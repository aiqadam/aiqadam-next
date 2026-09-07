import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { registerForEvent } from "../domain/registration.js";
import type { NotificationButton, NotificationSender } from "../domain/notification.js";
import { NO_SHOW_REASON_CODES } from "../domain/registration.js";
import { makeNoShowReasonRequestJob } from "./noShowJobs.js";

// docs/agents/test-specs/REQ-032.md -- File 1: job-level verification for
// AC1, AC3, AC6. Modeled on scheduler/feedbackJobs.db.test.ts's own shape:
// real Postgres, makeFakeSender() capturing { tgId, text, buttons },
// makeNoShowReasonRequestJob called directly with an explicit evaluationTime
// (never the wall clock, decisions/0006).

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

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
      `[noShowJobs.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
let nextTgId = 995_000_000;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(schema.chapters)
    .values({
      code: `chapter-req032-job-${chapterSeq}`,
      name: `Chapter REQ-032 Job ${chapterSeq}`,
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
  endsAt: Date;
}

async function seedPublishedEvent(chapterId: string, opts: SeedEventOptions): Promise<string> {
  const organizerId = await seedOrganizer();
  const eventId = await createEvent(
    db,
    organizerId,
    chapterId,
    {
      title: "No-Show Job Test Event",
      description: "A test event",
      format: "meetup",
      venueId: null,
      startsAt: new Date(opts.endsAt.getTime() - 2 * 60 * 60 * 1000),
      endsAt: opts.endsAt,
      registrationClosesAt: null,
      capacity: 10,
      requiresInvite: false,
      requiresApproval: false,
      coverFileId: null,
    },
    new Date("2026-08-30T00:00:00Z"),
  );
  await publishEvent(db, organizerId, eventId, chapterId, "No-Show Job Test Event", new Date("2026-08-30T00:00:00Z"));
  return eventId;
}

// Shared-setup §5 helper: resolves/creates a user, registers, then --
// ONLY when opts.checkedInAt is provided -- directly sets checkedInAt/
// checkInMethod. Omitting it leaves the row admitted-and-never-checked-in,
// the exact no-show shape both files need.
async function seedAdmittedRegistration(
  eventId: string,
  opts: { checkedInAt?: Date | null } = {},
): Promise<{ userId: string; registrationId: string }> {
  const user = await resolveOrCreateUser(db, {
    tgId: BigInt(nextTgId++),
    tgUsername: `member${nextTgId}`,
    lang: "ru",
  });
  const result = await registerForEvent(db, user.id, eventId, new Date("2026-08-31T00:00:00Z"));
  if (result.kind !== "admitted" || result.registrationId === undefined) {
    throw new Error(`seedAdmittedRegistration: registerForEvent did not admit -- ${result.kind}`);
  }
  if (opts.checkedInAt !== undefined) {
    await db
      .update(schema.registrations)
      .set({ checkedInAt: opts.checkedInAt, checkInMethod: "qr" })
      .where(eq(schema.registrations.id, result.registrationId));
  }
  return { userId: user.id, registrationId: result.registrationId };
}

interface CapturedText {
  kind: "text";
  tgId: bigint;
  text: string;
  buttons?: NotificationButton[];
}
interface CapturedPhoto {
  kind: "photo";
  tgId: bigint;
  photo: Buffer;
  caption: string;
}
type Captured = CapturedText | CapturedPhoto;

function makeFakeSender(): { sender: NotificationSender; sent: Captured[] } {
  const sent: Captured[] = [];
  return {
    sender: {
      async send(tgId, text, buttons) {
        sent.push({ kind: "text", tgId, text, buttons });
      },
      async sendPhoto(tgId, photo, caption) {
        sent.push({ kind: "photo", tgId, photo, caption });
      },
    },
    sent,
  };
}

describe("makeNoShowReasonRequestJob -- REQ-032 AC1/AC6: never-checked-in admitted registration receives exactly one message with five reasons + free text; checked-in registration receives nothing; the send reaches a broadcast_opt_in=false user", () => {
  it("registration A (never checked in, broadcastOptIn=false) is sent exactly one message with 6 buttons; registration B (checked in) receives nothing", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { endsAt: new Date("2026-09-01T00:00:00Z") });

    const { userId: userIdA, registrationId: registrationIdA } = await seedAdmittedRegistration(eventId);
    await db.update(schema.users).set({ broadcastOptIn: false }).where(eq(schema.users.id, userIdA));

    const { registrationId: registrationIdB } = await seedAdmittedRegistration(eventId, {
      checkedInAt: new Date("2026-09-01T00:05:00Z"),
    });

    const evaluationTime = new Date("2026-09-01T00:10:00Z");
    const { sender, sent } = makeFakeSender();
    await makeNoShowReasonRequestJob(db, sender, 300000).run(evaluationTime);

    // Condition 1 -- sent has length exactly 1, B never appears.
    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message?.kind).toBe("text");
    if (message?.kind !== "text") throw new Error("expected text message");

    // Condition 2 -- 6 buttons: five fixed-reason codes in NO_SHOW_REASON_CODES
    // order, plus one "other" button.
    expect(message.buttons).toHaveLength(6);
    NO_SHOW_REASON_CODES.forEach((code, index) => {
      expect(message.buttons?.[index]?.callbackData).toBe(`noshow:reason:${code}:${registrationIdA}`);
    });
    expect(message.buttons?.[5]?.callbackData).toBe(`noshow:other:${registrationIdA}`);

    // Condition 3 -- notification_ledger has exactly one row for A, kind
    // no_show_reason_request; zero rows for B.
    const ledgerA = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationIdA),
          eq(schema.notificationLedger.kind, "no_show_reason_request"),
        ),
      );
    expect(ledgerA).toHaveLength(1);
    const ledgerB = await db
      .select()
      .from(schema.notificationLedger)
      .where(eq(schema.notificationLedger.registrationId, registrationIdB));
    expect(ledgerB).toHaveLength(0);

    // Condition 4 -- no_show_reason is still null for both (merely being
    // asked does not write anything).
    const regA = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, registrationIdA)))[0];
    const regB = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, registrationIdB)))[0];
    expect(regA?.noShowReason).toBeNull();
    expect(regB?.noShowReason).toBeNull();

    // AC6 -- A's own broadcastOptIn is false, and the send still happened.
    const userA = (await db.select().from(schema.users).where(eq(schema.users.id, userIdA)))[0];
    expect(userA?.broadcastOptIn).toBe(false);
  });
});

describe("makeNoShowReasonRequestJob -- REQ-032 AC3: the job re-run at T+24h and T+48h delivers NO further message to the same registration, across all four runs", () => {
  it("run1 sends+ledgers once; run2 (same evaluationTime) dedups via the ledger UNIQUE constraint; run3 (T+24h) and run4 (T+48h) are excluded by the window itself", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { endsAt: new Date("2026-09-01T00:00:00Z") });
    const { registrationId } = await seedAdmittedRegistration(eventId);

    const { sender, sent } = makeFakeSender();

    // Run 1 -- the genuine first send, shortly after endsAt.
    const evaluationTime0 = new Date("2026-09-01T00:10:00Z");
    await makeNoShowReasonRequestJob(db, sender, 300000).run(evaluationTime0);
    expect(sent).toHaveLength(1);
    let ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "no_show_reason_request"),
        ),
      );
    expect(ledgerRows).toHaveLength(1);

    // Run 2 -- immediate re-run at the SAME evaluationTime0, same
    // sender/sent array -- direct ledger-dedup proof.
    await makeNoShowReasonRequestJob(db, sender, 300000).run(evaluationTime0);
    expect(sent).toHaveLength(1);
    ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "no_show_reason_request"),
        ),
      );
    expect(ledgerRows).toHaveLength(1);

    // Run 3 -- T+24h: excluded by the window itself (endsAt > evaluationTime
    // - CATCH_UP_WINDOW_MS(2h) is false).
    const evaluationTime24 = new Date("2026-09-02T00:10:00Z");
    await makeNoShowReasonRequestJob(db, sender, 300000).run(evaluationTime24);
    expect(sent).toHaveLength(1);

    // Run 4 -- T+48h: excluded by the same window-exclusion mechanism, an
    // even larger margin.
    const evaluationTime48 = new Date("2026-09-03T00:10:00Z");
    await makeNoShowReasonRequestJob(db, sender, 300000).run(evaluationTime48);
    expect(sent).toHaveLength(1);

    // Total across all four runs: exactly 1 send, exactly 1 ledger row.
    ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "no_show_reason_request"),
        ),
      );
    expect(ledgerRows).toHaveLength(1);
  });
});
