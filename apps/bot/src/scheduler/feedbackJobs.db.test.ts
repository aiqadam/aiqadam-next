import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { registerForEvent } from "../domain/registration.js";
import type { NotificationButton, NotificationSender } from "../domain/notification.js";
import { makeFeedbackRequestJob, makeFeedbackReminderJob } from "./feedbackJobs.js";

// docs/agents/test-specs/REQ-031.md -- File 1: job-level verification for
// AC1, AC4, AC7. Modeled on scheduler/reminderJobs.db.test.ts's own shape:
// real Postgres, makeFakeSender() capturing { tgId, text, buttons },
// makeFeedbackRequestJob/makeFeedbackReminderJob called directly with an
// explicit evaluationTime (never the wall clock, decisions/0006).

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT 1 FROM feedback LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[feedbackJobs.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
    "TRUNCATE notification_ledger, audit_log, feedback, registrations, events, venues, profiles, users, chapters CASCADE",
  );
});

let chapterSeq = 0;
let nextTgId = 993_000_000;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(schema.chapters)
    .values({
      code: `chapter-req031-job-${chapterSeq}`,
      name: `Chapter REQ-031 Job ${chapterSeq}`,
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
      title: "Feedback Job Test Event",
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
  await publishEvent(db, organizerId, eventId, chapterId, "Feedback Job Test Event", new Date("2026-08-30T00:00:00Z"));
  return eventId;
}

// Shared-setup §5 helper: resolves/creates a user, registers, then directly
// sets checkedInAt/checkInMethod -- this suite does not need to exercise the
// real QR check-in flow (already covered by REQ-029's own suites).
async function seedAdmittedCheckedInRegistration(
  eventId: string,
  opts: { broadcastOptIn?: boolean; checkedInAt?: Date; skipCheckIn?: boolean } = {},
): Promise<{ userId: string; registrationId: string }> {
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
  const result = await registerForEvent(db, user.id, eventId, new Date("2026-08-31T00:00:00Z"));
  if (result.kind !== "admitted" || result.registrationId === undefined) {
    throw new Error(`seedAdmittedCheckedInRegistration: registerForEvent did not admit -- ${result.kind}`);
  }
  if (opts.skipCheckIn !== true) {
    await db
      .update(schema.registrations)
      .set({
        checkedInAt: opts.checkedInAt ?? new Date("2026-09-01T00:05:00Z"),
        checkInMethod: "qr",
      })
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

describe("makeFeedbackRequestJob -- REQ-031 AC1/AC7: checked-in receives T+2h request; never-checked-in receives nothing; broadcast_opt_in=false still receives it", () => {
  it("registration A (checked-in, broadcastOptIn=false) is sent exactly one NPS prompt; registration B (admitted, never checked in) receives nothing", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { endsAt: new Date("2026-09-01T00:00:00Z") });

    const { userId: userIdA, registrationId: registrationIdA } = await seedAdmittedCheckedInRegistration(eventId, {
      broadcastOptIn: false,
      checkedInAt: new Date("2026-09-01T00:05:00Z"),
    });
    const { registrationId: registrationIdB } = await seedAdmittedCheckedInRegistration(eventId, {
      skipCheckIn: true,
    });

    const evaluationTime = new Date("2026-09-01T02:05:00Z");
    const { sender, sent } = makeFakeSender();
    await makeFeedbackRequestJob(db, sender, 300000).run(evaluationTime);

    // Condition 1 -- sent has length exactly 1, B never appears.
    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message?.kind).toBe("text");
    if (message?.kind !== "text") throw new Error("expected text message");

    // Condition 2 -- 11 buttons, labels "0".."10", callbackData naming A.
    expect(message.buttons).toHaveLength(11);
    for (let n = 0; n <= 10; n += 1) {
      expect(message.buttons?.[n]?.label).toBe(String(n));
      expect(message.buttons?.[n]?.callbackData).toBe(`feedback:nps:${n}:${registrationIdA}`);
    }

    // Condition 3 -- ledger has exactly one row for A, kind feedback_request;
    // zero rows for B.
    const ledgerA = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationIdA),
          eq(schema.notificationLedger.kind, "feedback_request"),
        ),
      );
    expect(ledgerA).toHaveLength(1);
    const ledgerB = await db
      .select()
      .from(schema.notificationLedger)
      .where(eq(schema.notificationLedger.registrationId, registrationIdB));
    expect(ledgerB).toHaveLength(0);

    // Condition 4 -- feedback table has zero rows (no NPS answered yet).
    const feedbackRows = await db.select().from(schema.feedback);
    expect(feedbackRows).toHaveLength(0);

    // AC7 piggyback: A's own broadcastOptIn is false, and the send still
    // happened -- proving the T+2h request reaches a broadcast_opt_in=false
    // user (the transactional classification never reads broadcastOptIn).
    const userA = await db.select().from(schema.users).where(eq(schema.users.id, userIdA));
    expect(userA[0]?.broadcastOptIn).toBe(false);
  });
});

describe("makeFeedbackReminderJob -- REQ-031 AC4: exactly one T+24h reminder, nothing thereafter, across three runs", () => {
  it("run1 sends+ledgers once; run2 (same evaluationTime) dedups via the ledger UNIQUE constraint; run3 (T+48h) is excluded by the window itself", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { endsAt: new Date("2026-09-01T00:00:00Z") });
    const { registrationId } = await seedAdmittedCheckedInRegistration(eventId, {
      checkedInAt: new Date("2026-09-01T00:05:00Z"),
    });

    // Run 1 -- the genuine T+24h send.
    const evaluationTime24 = new Date("2026-09-02T00:05:00Z");
    const { sender, sent } = makeFakeSender();
    await makeFeedbackReminderJob(db, sender, 300000).run(evaluationTime24);

    expect(sent).toHaveLength(1);
    let ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "feedback_reminder"),
        ),
      );
    expect(ledgerRows).toHaveLength(1);

    // Run 2 -- immediate re-run at the SAME evaluationTime, same
    // sender/sent array -- direct ledger-dedup proof.
    await makeFeedbackReminderJob(db, sender, 300000).run(evaluationTime24);
    expect(sent).toHaveLength(1);
    ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "feedback_reminder"),
        ),
      );
    expect(ledgerRows).toHaveLength(1);

    // Run 3 -- a much later re-run, T+48h: excluded by the window itself
    // before the ledger is ever consulted a third time.
    const evaluationTime48 = new Date("2026-09-03T00:05:00Z");
    await makeFeedbackReminderJob(db, sender, 300000).run(evaluationTime48);
    expect(sent).toHaveLength(1);
    ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "feedback_reminder"),
        ),
      );
    expect(ledgerRows).toHaveLength(1);
  });
});
