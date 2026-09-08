import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { chapters, notificationLedger, registrations, users } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { listPendingRequestsForOrganizer, registerForEvent } from "../domain/registration.js";
import type { NotificationSender } from "../domain/notification.js";
import { makeUrgencyNoticeJob } from "./urgencyJobs.js";

// docs/agents/test-specs/REQ-036.md -- File 1: the T-48h urgency job.
// AC1 (push + list marker, both timings) and AC7's urgency-side half
// (broadcast_opt_in=false still reached, blocked=true never reached).
// Same infra/skip discipline as scheduler/noShowJobs.db.test.ts.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT 1 FROM registrations LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[urgencyJobs.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
    );
  }
}, 15000);

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  if (!dbAvailable) {
    return;
  }
  await pool.query(
    "TRUNCATE notification_ledger, audit_log, registrations, events, venues, profiles, users, chapters CASCADE",
  );
});

let chapterSeq = 0;
let nextTgId = 1_030_000_000;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(chapters)
    .values({
      code: `req036-urgency-chapter-${chapterSeq}`,
      name: `REQ-036 Urgency Chapter ${chapterSeq}`,
      timezone: "Asia/Tashkent",
      defaultLang: "en",
      active: true,
    })
    .returning({ id: chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedUser(opts: { broadcastOptIn?: boolean; blocked?: boolean } = {}): Promise<{ id: string; tgId: number }> {
  nextTgId += 1;
  const tgId = nextTgId;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `u${tgId}`, lang: "en" });
  if (opts.broadcastOptIn !== undefined) {
    await db.update(users).set({ broadcastOptIn: opts.broadcastOptIn }).where(eq(users.id, user.id));
  }
  if (opts.blocked !== undefined) {
    await db.update(users).set({ blocked: opts.blocked }).where(eq(users.id, user.id));
  }
  return { id: user.id, tgId };
}

async function seedOrganizer(
  chapterId: string,
  opts: { broadcastOptIn?: boolean; blocked?: boolean } = {},
): Promise<{ id: string; tgId: number }> {
  const organizer = await seedUser(opts);
  await db.update(users).set({ role: "organizer", chapterId }).where(eq(users.id, organizer.id));
  return organizer;
}

async function seedPublishedEvent(chapterId: string, startsAt: Date): Promise<{ id: string; title: string }> {
  const organizer = await seedUser();
  const title = `REQ-036 Urgency Event ${Date.now()}-${Math.random()}`;
  const eventId = await createEvent(
    db,
    organizer.id,
    chapterId,
    {
      title,
      description: "A test event",
      format: "meetup",
      venueId: null,
      startsAt,
      endsAt: new Date(startsAt.getTime() + 2 * 60 * 60 * 1000),
      registrationClosesAt: null,
      capacity: 10,
      requiresInvite: false,
      requiresApproval: true,
      coverFileId: null,
    },
    new Date("2026-01-01T00:00:00Z"),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, title, new Date("2026-01-01T00:00:00Z"));
  return { id: eventId, title };
}

// requiresApproval:true always yields "requested" regardless of seatsLeft
// (registrationApproval.db.test.ts's own established comment) -- exactly the
// pending-request shape this file needs.
async function seedPendingRequest(eventId: string): Promise<{ registrationId: string; userId: string }> {
  const user = await seedUser();
  const result = await registerForEvent(db, user.id, eventId, new Date("2026-01-01T00:00:00Z"));
  if (result.kind !== "requested" || result.registrationId === undefined) {
    throw new Error(`seedPendingRequest: expected 'requested', got ${result.kind}`);
  }
  return { registrationId: result.registrationId, userId: user.id };
}

interface Captured {
  tgId: bigint;
  text: string;
}

function makeFakeSender(): { sender: NotificationSender; sent: Captured[] } {
  const sent: Captured[] = [];
  return {
    sender: {
      async send(tgId, text) {
        sent.push({ tgId, text });
      },
      async sendPhoto() {
        throw new Error("the urgency notice never sends a photo");
      },
    },
    sent,
  };
}

describe("AC1 -- urgency job at exactly T-48h surfaces both the push and the list marker; an event >48h out surfaces nothing", () => {
  it("event exactly 48h from starts_at with two 'requested' registrations: both pushed to the chapter's organizer and both marked urgent on the list; an event 49h out is untouched by either mechanism", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const evaluationTime = new Date("2026-03-10T00:00:00Z");
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);

    // Event A -- exactly 48h from starts_at at evaluationTime (the trigger instant).
    const eventA = await seedPublishedEvent(chapterId, new Date(evaluationTime.getTime() + 48 * 60 * 60 * 1000));
    const reqA1 = await seedPendingRequest(eventA.id);
    const reqA2 = await seedPendingRequest(eventA.id);

    // Event B -- 49h out (strictly more than 48h): both timings run in this
    // one test, and this event must surface nothing via either mechanism.
    const eventB = await seedPublishedEvent(chapterId, new Date(evaluationTime.getTime() + 49 * 60 * 60 * 1000));
    const reqB1 = await seedPendingRequest(eventB.id);

    const { sender, sent } = makeFakeSender();
    await makeUrgencyNoticeJob(db, sender, 300000).run(evaluationTime);

    // Push: exactly 2 sends, both to the chapter's organizer, both about event A.
    expect(sent).toHaveLength(2);
    for (const message of sent) {
      expect(message.tgId).toBe(BigInt(organizer.tgId));
      expect(message.text).toContain(eventA.title);
    }

    // Ledger: exactly one 'pending_request_urgent' row per event-A registration, zero for event B's.
    const ledgerA1 = await db
      .select()
      .from(notificationLedger)
      .where(and(eq(notificationLedger.registrationId, reqA1.registrationId), eq(notificationLedger.kind, "pending_request_urgent")));
    const ledgerA2 = await db
      .select()
      .from(notificationLedger)
      .where(and(eq(notificationLedger.registrationId, reqA2.registrationId), eq(notificationLedger.kind, "pending_request_urgent")));
    const ledgerB1 = await db
      .select()
      .from(notificationLedger)
      .where(and(eq(notificationLedger.registrationId, reqB1.registrationId), eq(notificationLedger.kind, "pending_request_urgent")));
    expect(ledgerA1).toHaveLength(1);
    expect(ledgerA2).toHaveLength(1);
    expect(ledgerB1).toHaveLength(0);

    // List marker: isUrgent true for both event-A items, false for event-B's --
    // computed fresh via listPendingRequestsForOrganizer/isRequestUrgent,
    // independent of whether the push above was ever sent or attempted.
    const listA = await listPendingRequestsForOrganizer(db, eventA.id, "en", evaluationTime);
    expect(listA).toHaveLength(2);
    for (const item of listA) expect(item.isUrgent).toBe(true);

    const listB = await listPendingRequestsForOrganizer(db, eventB.id, "en", evaluationTime);
    expect(listB).toHaveLength(1);
    expect(listB[0]!.isUrgent).toBe(false);

    // Neither registration's admission changed -- the urgency job never writes state.
    const regA1 = (await db.select().from(registrations).where(eq(registrations.id, reqA1.registrationId)))[0];
    const regB1 = (await db.select().from(registrations).where(eq(registrations.id, reqB1.registrationId)))[0];
    expect(regA1?.admission).toBe("requested");
    expect(regB1?.admission).toBe("requested");
  });
});

describe("AC7 (urgency side) -- the push reaches a broadcast_opt_in=false organizer and never reaches a blocked=true organizer", () => {
  it("chapter X's organizer (broadcastOptIn=false) is pushed exactly once; chapter Y's organizer (blocked=true) receives nothing and gets no ledger row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const evaluationTime = new Date("2026-03-10T00:00:00Z");
    const startsAt = new Date(evaluationTime.getTime() + 48 * 60 * 60 * 1000);

    const chapterX = await seedChapter();
    const organizerX = await seedOrganizer(chapterX, { broadcastOptIn: false });
    const eventX = await seedPublishedEvent(chapterX, startsAt);
    const reqX = await seedPendingRequest(eventX.id);

    const chapterY = await seedChapter();
    const organizerY = await seedOrganizer(chapterY, { blocked: true });
    const eventY = await seedPublishedEvent(chapterY, startsAt);
    const reqY = await seedPendingRequest(eventY.id);

    const { sender, sent } = makeFakeSender();
    await makeUrgencyNoticeJob(db, sender, 300000).run(evaluationTime);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.tgId).toBe(BigInt(organizerX.tgId));

    const ledgerX = await db
      .select()
      .from(notificationLedger)
      .where(and(eq(notificationLedger.registrationId, reqX.registrationId), eq(notificationLedger.kind, "pending_request_urgent")));
    expect(ledgerX).toHaveLength(1);

    const ledgerY = await db
      .select()
      .from(notificationLedger)
      .where(and(eq(notificationLedger.registrationId, reqY.registrationId), eq(notificationLedger.kind, "pending_request_urgent")));
    expect(ledgerY).toHaveLength(0);

    const orgYRow = (await db.select().from(users).where(eq(users.id, organizerY.id)))[0];
    expect(orgYRow?.blocked).toBe(true);
  });
});
