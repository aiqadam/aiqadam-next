import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { registrations } from "../db/schema.js";
import { cancelEvent, createEvent, publishEvent } from "../domain/event.js";
import { registerForEvent, withdrawRegistration } from "../domain/registration.js";
import { resolveOrCreateUser } from "../domain/user.js";
import type { NotificationButton, NotificationSender } from "../domain/notification.js";
import { notifyNonWithdrawnRegistrants } from "./event.js";

// docs/agents/design/REQ-027.md — job-level verification for AC1-AC5. Real
// Postgres, same infrastructure/skip discipline as
// scheduler/reminderJobs.db.test.ts.

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT 1 FROM notification_ledger LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[event.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
let nextTgId = 980_000_000;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(schema.chapters)
    .values({
      code: `chapter-req027-${chapterSeq}`,
      name: `Chapter REQ-027 ${chapterSeq}`,
      timezone: "Asia/Tashkent",
      defaultLang: "ru",
      active: true,
    })
    .returning({ id: schema.chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedOrganizer(): Promise<string> {
  const organizer = await resolveOrCreateUser(db, {
    tgId: BigInt(nextTgId++),
    tgUsername: `organizer${nextTgId}`,
    lang: "ru",
  });
  return organizer.id;
}

interface SeedEventOptions {
  capacity: number;
}

async function seedPublishedEvent(
  chapterId: string,
  organizerId: string,
  opts: SeedEventOptions,
): Promise<{ eventId: string; title: string }> {
  const title = "REQ-027 Test Event";
  const eventId = await createEvent(
    db,
    organizerId,
    chapterId,
    {
      title,
      description: "A test event",
      format: "meetup",
      venueId: null,
      startsAt: new Date("2026-09-10T18:00:00Z"),
      endsAt: new Date("2026-09-10T20:00:00Z"),
      registrationClosesAt: null,
      capacity: opts.capacity,
      requiresInvite: false,
      requiresApproval: false,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizerId, eventId, chapterId, title, new Date());
  return { eventId, title };
}

async function seedRegistrant(
  eventId: string,
  registerAt: Date,
  opts: { broadcastOptIn?: boolean } = {},
): Promise<{ userId: string; registrationId: string; admission: string }> {
  const user = await resolveOrCreateUser(db, {
    tgId: BigInt(nextTgId++),
    tgUsername: `member${nextTgId}`,
    lang: "ru",
  });
  if (opts.broadcastOptIn !== undefined) {
    await db
      .update(schema.users)
      .set({ broadcastOptIn: opts.broadcastOptIn })
      .where(eq(schema.users.id, user.id));
  }
  const result = await registerForEvent(db, user.id, eventId, registerAt);
  if (result.registrationId === undefined) {
    throw new Error(`seedRegistrant: registerForEvent did not create a row -- ${result.kind}`);
  }
  return { userId: user.id, registrationId: result.registrationId, admission: result.kind };
}

interface CapturedText {
  kind: "text";
  tgId: bigint;
  text: string;
  buttons?: NotificationButton[];
}
type Captured = CapturedText;

function makeFakeSender(): { sender: NotificationSender; sent: Captured[] } {
  const sent: Captured[] = [];
  return {
    sender: {
      async send(tgId, text, buttons) {
        sent.push({ kind: "text", tgId, text, buttons });
      },
      async sendPhoto() {
        throw new Error("notifyNonWithdrawnRegistrants never sends a photo");
      },
    },
    sent,
  };
}

describe("notifyNonWithdrawnRegistrants -- REQ-027 AC1: exactly one notification per non-withdrawn registrant", () => {
  it("3 admitted + 2 waitlisted + 1 withdrawn -> exactly 5 sends, none to the withdrawn registrant", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizerId = await seedOrganizer();
    // Capacity 3 so registrants 1-3 are admitted and 4-5 waitlisted.
    const { eventId, title } = await seedPublishedEvent(chapterId, organizerId, { capacity: 3 });

    const registerAt = new Date("2026-09-01T00:00:00Z");
    const admitted = [
      await seedRegistrant(eventId, registerAt),
      await seedRegistrant(eventId, registerAt),
      await seedRegistrant(eventId, registerAt),
    ];
    const waitlisted = [
      await seedRegistrant(eventId, registerAt),
      await seedRegistrant(eventId, registerAt),
    ];
    const toWithdraw = await seedRegistrant(eventId, registerAt);

    for (const reg of admitted) {
      expect(reg.admission).toBe("admitted");
    }
    for (const reg of waitlisted) {
      expect(reg.admission).toBe("waitlisted");
    }
    expect(toWithdraw.admission).toBe("waitlisted");

    const withdrawOutcome = await withdrawRegistration(
      db,
      toWithdraw.registrationId,
      toWithdraw.userId,
      new Date("2026-09-01T01:00:00Z"),
    );
    expect(withdrawOutcome.kind).toBe("withdrawn");

    await cancelEvent(db, organizerId, eventId, chapterId, title, new Date("2026-09-01T02:00:00Z"));

    const { sender, sent } = makeFakeSender();
    await notifyNonWithdrawnRegistrants(db, sender, eventId, title);

    // Exactly 5 notifications -- one per non-withdrawn registrant.
    expect(sent).toHaveLength(5);

    const nonWithdrawnRegistrationIds = new Set(
      [...admitted, ...waitlisted].map((r) => r.registrationId),
    );
    const ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(eq(schema.notificationLedger.kind, "event_cancelled"));
    expect(ledgerRows).toHaveLength(5);
    for (const row of ledgerRows) {
      expect(nonWithdrawnRegistrationIds.has(row.registrationId)).toBe(true);
    }

    // None sent to the withdrawn registrant.
    const withdrawnLedgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, toWithdraw.registrationId),
          eq(schema.notificationLedger.kind, "event_cancelled"),
        ),
      );
    expect(withdrawnLedgerRows).toHaveLength(0);
  });
});

describe("notifyNonWithdrawnRegistrants -- REQ-027 AC2: cancelling/running twice sends nothing extra", () => {
  it("running the batch a second time over the same event produces zero additional sends or ledger rows", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizerId = await seedOrganizer();
    const { eventId, title } = await seedPublishedEvent(chapterId, organizerId, { capacity: 5 });

    const registerAt = new Date("2026-09-01T00:00:00Z");
    const regA = await seedRegistrant(eventId, registerAt);
    const regB = await seedRegistrant(eventId, registerAt);

    await cancelEvent(db, organizerId, eventId, chapterId, title, new Date("2026-09-01T02:00:00Z"));

    const { sender: sender1, sent: sent1 } = makeFakeSender();
    await notifyNonWithdrawnRegistrants(db, sender1, eventId, title);
    expect(sent1).toHaveLength(2);

    // Simulate a second run (a repeat call, or a process restart re-running
    // the batch) -- no in-memory state carries over between the two calls
    // (a fresh sender/fresh call), same as an actual process restart would
    // produce.
    const { sender: sender2, sent: sent2 } = makeFakeSender();
    await notifyNonWithdrawnRegistrants(db, sender2, eventId, title);
    expect(sent2).toHaveLength(0);

    // Counted across both runs: still exactly 2 ledger rows, exactly 2
    // sends total (2 from run 1, 0 from run 2).
    const ledgerRowsA = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, regA.registrationId),
          eq(schema.notificationLedger.kind, "event_cancelled"),
        ),
      );
    expect(ledgerRowsA).toHaveLength(1);
    const ledgerRowsB = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, regB.registrationId),
          eq(schema.notificationLedger.kind, "event_cancelled"),
        ),
      );
    expect(ledgerRowsB).toHaveLength(1);
  });
});

describe("notifyNonWithdrawnRegistrants -- REQ-027 AC3: broadcast_opt_in=false still receives the cancellation", () => {
  it("a transactional send bypasses broadcast_opt_in entirely", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizerId = await seedOrganizer();
    const { eventId, title } = await seedPublishedEvent(chapterId, organizerId, { capacity: 5 });

    const registerAt = new Date("2026-09-01T00:00:00Z");
    const reg = await seedRegistrant(eventId, registerAt, { broadcastOptIn: false });

    await cancelEvent(db, organizerId, eventId, chapterId, title, new Date("2026-09-01T02:00:00Z"));

    const { sender, sent } = makeFakeSender();
    await notifyNonWithdrawnRegistrants(db, sender, eventId, title);

    expect(sent).toHaveLength(1);
    expect(sent[0]?.tgId).toBeDefined();

    const ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, reg.registrationId),
          eq(schema.notificationLedger.kind, "event_cancelled"),
        ),
      );
    expect(ledgerRows).toHaveLength(1);
  });
});

describe("notifyNonWithdrawnRegistrants -- REQ-027 AC4: registrations rows are untouched", () => {
  it("every registrations row for the event still exists with admission UNCHANGED after cancellation + notification", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizerId = await seedOrganizer();
    const { eventId, title } = await seedPublishedEvent(chapterId, organizerId, { capacity: 1 });

    const registerAt = new Date("2026-09-01T00:00:00Z");
    const regAdmitted = await seedRegistrant(eventId, registerAt);
    const regWaitlisted = await seedRegistrant(eventId, registerAt);
    const regToWithdraw = await seedRegistrant(eventId, registerAt);
    await withdrawRegistration(db, regToWithdraw.registrationId, regToWithdraw.userId, new Date("2026-09-01T01:00:00Z"));

    const beforeRows = await db
      .select()
      .from(registrations)
      .where(eq(registrations.eventId, eventId));
    // Full row set, sorted by id for a stable comparison.
    const sortById = (rows: typeof beforeRows) => [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const beforeSorted = sortById(beforeRows);
    expect(beforeSorted).toHaveLength(3);

    await cancelEvent(db, organizerId, eventId, chapterId, title, new Date("2026-09-01T02:00:00Z"));
    const { sender } = makeFakeSender();
    await notifyNonWithdrawnRegistrants(db, sender, eventId, title);

    const afterRows = await db
      .select()
      .from(registrations)
      .where(eq(registrations.eventId, eventId));
    const afterSorted = sortById(afterRows);

    expect(afterSorted).toHaveLength(3);
    expect(afterSorted).toEqual(beforeSorted);

    // Explicit admission-unchanged spot checks, by identity.
    const admissionById = new Map(afterSorted.map((r) => [r.id, r.admission]));
    expect(admissionById.get(regAdmitted.registrationId)).toBe("admitted");
    expect(admissionById.get(regWaitlisted.registrationId)).toBe("waitlisted");
    expect(admissionById.get(regToWithdraw.registrationId)).toBe("withdrawn");
  });
});

describe("notifyNonWithdrawnRegistrants -- REQ-027 AC5: message offers the upcoming events list as an onward path", () => {
  it("the composed message contains the event title and the existing deepLinkSeeUpcoming string", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizerId = await seedOrganizer();
    const { eventId, title } = await seedPublishedEvent(chapterId, organizerId, { capacity: 5 });

    const registerAt = new Date("2026-09-01T00:00:00Z");
    await seedRegistrant(eventId, registerAt);

    await cancelEvent(db, organizerId, eventId, chapterId, title, new Date("2026-09-01T02:00:00Z"));

    const { sender, sent } = makeFakeSender();
    await notifyNonWithdrawnRegistrants(db, sender, eventId, title);

    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message?.kind).toBe("text");
    if (message?.kind !== "text") throw new Error("expected text message");

    const catalog = (await import("../i18n/catalog.js")).getCatalog("ru");
    expect(message.text).toContain(catalog.event.cancelledNotificationHeader);
    expect(message.text).toContain(title);
    expect(message.text).toContain(catalog.event.deepLinkSeeUpcoming);
  });
});
