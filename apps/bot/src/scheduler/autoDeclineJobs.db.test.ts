import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, chapters, events, notificationLedger, registrations, users } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { approveRequest, registerForEvent, rejectRequest } from "../domain/registration.js";
import type { NotificationSender } from "../domain/notification.js";
import { makeAutoDeclineJob } from "./autoDeclineJobs.js";

// docs/agents/test-specs/REQ-036.md -- File 2: the registration-close
// auto-decline job. AC2 (mass transition + exactly-one-message-each,
// approved/rejected untouched), AC3 (honest/blame-free wording + onward
// path), AC4 (restart-safety -- run twice, see the spec's own design note
// above for why this is the correct proof), AC5 (registration_closes_at
// IS NULL -> ends_at fallback, both directions), AC6 (verified inline:
// exactly one audit_log row per transition, actorUserId null), AC7's
// auto-decline-side half, AC8 (no inline literal user-facing string in
// either scheduler file). Same infra/skip discipline as
// scheduler/noShowJobs.db.test.ts.

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
      `[autoDeclineJobs.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
let nextTgId = 1_031_000_000;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(chapters)
    .values({
      code: `req036-autodecline-chapter-${chapterSeq}`,
      name: `REQ-036 AutoDecline Chapter ${chapterSeq}`,
      timezone: "Asia/Tashkent",
      defaultLang: "en",
      active: true,
    })
    .returning({ id: chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedUser(): Promise<{ id: string; tgId: number }> {
  nextTgId += 1;
  const tgId = nextTgId;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `u${tgId}`, lang: "en" });
  return { id: user.id, tgId };
}

async function seedOrganizer(chapterId: string): Promise<{ id: string; tgId: number }> {
  const organizer = await seedUser();
  await db.update(users).set({ role: "organizer", chapterId }).where(eq(users.id, organizer.id));
  return organizer;
}

interface SeedEventOptions {
  startsAt: Date;
  endsAt: Date;
  registrationClosesAt: Date | null;
}

async function seedPublishedEvent(chapterId: string, opts: SeedEventOptions): Promise<{ id: string; title: string }> {
  const organizer = await seedUser();
  const title = `REQ-036 AutoDecline Event ${Date.now()}-${Math.random()}`;
  const eventId = await createEvent(
    db,
    organizer.id,
    chapterId,
    {
      title,
      description: "A test event",
      format: "meetup",
      venueId: null,
      startsAt: opts.startsAt,
      endsAt: opts.endsAt,
      registrationClosesAt: opts.registrationClosesAt,
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

// requiresApproval:true always yields "requested" regardless of seatsLeft --
// exactly the pending-request shape this file needs.
async function seedPendingRequest(eventId: string): Promise<{ registrationId: string; userId: string }> {
  const user = await seedUser();
  const result = await registerForEvent(db, user.id, eventId, new Date("2026-01-01T00:00:00Z"));
  if (result.kind !== "requested" || result.registrationId === undefined) {
    throw new Error(`seedPendingRequest: expected 'requested', got ${result.kind}`);
  }
  return { registrationId: result.registrationId, userId: user.id };
}

async function countAuditRows(registrationIds: string[]): Promise<number> {
  const rows = await db.select({ id: auditLog.id }).from(auditLog).where(inArray(auditLog.entityId, registrationIds));
  return rows.length;
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
        throw new Error("the auto-decline notice never sends a photo");
      },
    },
    sent,
  };
}

describe("AC2 -- at registration_closes_at, every remaining 'requested' registration becomes 'rejected' with exactly one message each; the admitted and previously-rejected rows are untouched", () => {
  it("3 pending + 1 already-admitted + 1 already-rejected: exactly 3 transitions and 3 sends", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const closesAt = new Date("2026-04-01T00:00:00Z");
    const evaluationTime = new Date("2026-04-01T00:10:00Z");
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const event = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-04-05T00:00:00Z"),
      endsAt: new Date("2026-04-05T02:00:00Z"),
      registrationClosesAt: closesAt,
    });

    const pending1 = await seedPendingRequest(event.id);
    const pending2 = await seedPendingRequest(event.id);
    const pending3 = await seedPendingRequest(event.id);
    const toAdmit = await seedPendingRequest(event.id);
    const toReject = await seedPendingRequest(event.id);

    const admitOutcome = await approveRequest(db, toAdmit.registrationId, organizer.id, false, new Date("2026-03-20T00:00:00Z"));
    expect(admitOutcome.kind).toBe("approve");
    const rejectOutcome = await rejectRequest(db, toReject.registrationId, organizer.id, "not a fit", new Date("2026-03-20T00:00:00Z"));
    expect(rejectOutcome.kind).toBe("reject");

    const allIds = [pending1, pending2, pending3, toAdmit, toReject].map((r) => r.registrationId);
    const auditBefore = await countAuditRows(allIds);

    const { sender, sent } = makeFakeSender();
    await makeAutoDeclineJob(db, sender, 300000).run(evaluationTime);

    expect(sent).toHaveLength(3);

    for (const pending of [pending1, pending2, pending3]) {
      const row = (await db.select().from(registrations).where(eq(registrations.id, pending.registrationId)))[0];
      expect(row?.admission).toBe("rejected");
      const ledger = await db
        .select()
        .from(notificationLedger)
        .where(and(eq(notificationLedger.registrationId, pending.registrationId), eq(notificationLedger.kind, "registration_auto_declined")));
      expect(ledger).toHaveLength(1);
      // AC6 -- exactly one audit_log row per auto-decline, actorUserId NULL.
      const audit = await db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, pending.registrationId), eq(auditLog.action, "registration.auto_decline")));
      expect(audit).toHaveLength(1);
      expect(audit[0]!.actorUserId).toBeNull();
    }

    const admittedRow = (await db.select().from(registrations).where(eq(registrations.id, toAdmit.registrationId)))[0];
    expect(admittedRow?.admission).toBe("admitted");
    const rejectedRow = (await db.select().from(registrations).where(eq(registrations.id, toReject.registrationId)))[0];
    expect(rejectedRow?.admission).toBe("rejected");

    const autoDeclineForAdmitted = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, toAdmit.registrationId), eq(auditLog.action, "registration.auto_decline")));
    expect(autoDeclineForAdmitted).toHaveLength(0);
    const autoDeclineForRejected = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, toReject.registrationId), eq(auditLog.action, "registration.auto_decline")));
    expect(autoDeclineForRejected).toHaveLength(0);

    // AC6, counted before and after: exactly 3 new audit rows total.
    const auditAfter = await countAuditRows(allIds);
    expect(auditAfter).toBe(auditBefore + 3);
  });
});

describe("AC3 -- the auto-decline message states no decision was reached in time, attributes nothing to personal merit, and offers the upcoming-events onward path", () => {
  it("captured message text matches the catalog's honest, blame-free wording plus the deepLinkSeeUpcoming onward path", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const closesAt = new Date("2026-04-01T00:00:00Z");
    const evaluationTime = new Date("2026-04-01T00:05:00Z");
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-04-05T00:00:00Z"),
      endsAt: new Date("2026-04-05T02:00:00Z"),
      registrationClosesAt: closesAt,
    });
    await seedPendingRequest(event.id);

    const { sender, sent } = makeFakeSender();
    await makeAutoDeclineJob(db, sender, 300000).run(evaluationTime);

    expect(sent).toHaveLength(1);
    const text = sent[0]!.text;

    // Honest: states no decision was reached / registration closed.
    expect(text).toContain("was not decided before registration closed");
    // Blame-free: explicitly disclaims personal review/judgment.
    expect(text).toContain("Nobody reviewed and declined it");
    // No personal-merit language: never claims the person was found lacking
    // on their own merits.
    expect(text.toLowerCase()).not.toContain("you were not accepted");
    expect(text.toLowerCase()).not.toContain("not good enough");
    expect(text.toLowerCase()).not.toContain("not qualified");
    expect(text.toLowerCase()).not.toContain("your application");
    // Onward path -- the exact reused deepLinkSeeUpcoming string (REQ-035 §0.4).
    expect(text).toContain("See what's coming up with /events");
  });
});

describe("AC4 -- running the auto-decline job again for the same event delivers exactly the original number of messages and performs no further transitions", () => {
  it("run 1 transitions and sends for all three pending requests; run 2 (same evaluationTime, simulating a restart's immediate first tick) sends and transitions nothing further", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const closesAt = new Date("2026-04-01T00:00:00Z");
    const evaluationTime = new Date("2026-04-01T00:10:00Z");
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-04-05T00:00:00Z"),
      endsAt: new Date("2026-04-05T02:00:00Z"),
      registrationClosesAt: closesAt,
    });

    const reqs = [await seedPendingRequest(event.id), await seedPendingRequest(event.id), await seedPendingRequest(event.id)];
    const ids = reqs.map((r) => r.registrationId);

    const { sender, sent } = makeFakeSender();
    const job = makeAutoDeclineJob(db, sender, 300000);

    // Run 1 -- the genuine first tick.
    await job.run(evaluationTime);
    expect(sent).toHaveLength(3);
    for (const r of reqs) {
      const row = (await db.select().from(registrations).where(eq(registrations.id, r.registrationId)))[0];
      expect(row?.admission).toBe("rejected");
    }
    // Baseline: each seedPendingRequest's own registerForEvent call already
    // wrote one 'registration.request' audit row (REQ-034, unconditional for
    // every outcome including 'requested') -- so the true baseline per row
    // is 1, plus 1 auto_decline row each after run 1: 3 * (1 + 1) = 6.
    const auditAfterRun1 = await countAuditRows(ids);
    expect(auditAfterRun1).toBe(6);

    // Run 2 -- "restart and run again": same evaluationTime, the restarted
    // process's own immediate first tick (runner.ts) re-running selection
    // from scratch. Mechanism 2 (WHERE admission='requested') now excludes
    // all three rows -- the literal AC4 proof (see this spec's design note).
    await job.run(evaluationTime);
    expect(sent).toHaveLength(3); // no further sends
    for (const r of reqs) {
      const row = (await db.select().from(registrations).where(eq(registrations.id, r.registrationId)))[0];
      expect(row?.admission).toBe("rejected"); // no further transition
    }
    const auditAfterRun2 = await countAuditRows(ids);
    expect(auditAfterRun2).toBe(auditAfterRun1); // zero further audit rows

    for (const r of reqs) {
      const ledger = await db
        .select()
        .from(notificationLedger)
        .where(and(eq(notificationLedger.registrationId, r.registrationId), eq(notificationLedger.kind, "registration_auto_declined")));
      expect(ledger).toHaveLength(1); // still exactly one, not two
    }
  });
});

describe("AC5 -- registration_closes_at IS NULL falls back to ends_at: no crash, no undocumented silent skip, no new column", () => {
  it("an event with registrationClosesAt=null whose endsAt has already passed auto-declines its pending request exactly as a non-null close would", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const endsAt = new Date("2026-04-01T00:00:00Z");
    const evaluationTime = new Date("2026-04-01T00:10:00Z"); // shortly after endsAt
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-03-31T22:00:00Z"),
      endsAt,
      registrationClosesAt: null,
    });
    const pending = await seedPendingRequest(event.id);

    const eventRowBefore = (await db.select().from(events).where(eq(events.id, event.id)))[0];
    expect(eventRowBefore?.registrationClosesAt).toBeNull(); // sanity: the NULL case is genuinely constructed

    const { sender, sent } = makeFakeSender();
    await makeAutoDeclineJob(db, sender, 300000).run(evaluationTime);

    expect(sent).toHaveLength(1); // no crash, no silent skip
    const row = (await db.select().from(registrations).where(eq(registrations.id, pending.registrationId)))[0];
    expect(row?.admission).toBe("rejected");
    const audit = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, pending.registrationId), eq(auditLog.action, "registration.auto_decline")));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorUserId).toBeNull();

    // No column was added to make the NULL case "go away" -- registrationClosesAt
    // is still nullable and still null on this exact row after the job ran.
    const eventRowAfter = (await db.select().from(events).where(eq(events.id, event.id)))[0];
    expect(eventRowAfter?.registrationClosesAt).toBeNull();
  });

  it("the same NULL-registrationClosesAt event, evaluated BEFORE its endsAt, is not yet auto-declined", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const endsAt = new Date("2026-04-01T00:00:00Z");
    const evaluationTime = new Date("2026-03-31T23:00:00Z"); // before endsAt
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-03-31T22:00:00Z"),
      endsAt,
      registrationClosesAt: null,
    });
    const pending = await seedPendingRequest(event.id);

    const { sender, sent } = makeFakeSender();
    await makeAutoDeclineJob(db, sender, 300000).run(evaluationTime);

    expect(sent).toHaveLength(0);
    const row = (await db.select().from(registrations).where(eq(registrations.id, pending.registrationId)))[0];
    expect(row?.admission).toBe("requested");
  });
});

describe("AC7 (auto-decline side) -- the message reaches a broadcast_opt_in=false registrant and never reaches a blocked=true registrant (whose row still transitions)", () => {
  it("registrant A (broadcastOptIn=false) receives exactly one message; registrant B (blocked=true) receives none but is still transitioned to rejected with an audit row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const closesAt = new Date("2026-04-01T00:00:00Z");
    const evaluationTime = new Date("2026-04-01T00:10:00Z");
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-04-05T00:00:00Z"),
      endsAt: new Date("2026-04-05T02:00:00Z"),
      registrationClosesAt: closesAt,
    });

    const pendingA = await seedPendingRequest(event.id);
    await db.update(users).set({ broadcastOptIn: false }).where(eq(users.id, pendingA.userId));

    const pendingB = await seedPendingRequest(event.id);
    await db.update(users).set({ blocked: true }).where(eq(users.id, pendingB.userId));

    const { sender, sent } = makeFakeSender();
    await makeAutoDeclineJob(db, sender, 300000).run(evaluationTime);

    expect(sent).toHaveLength(1); // only A

    const rowA = (await db.select().from(registrations).where(eq(registrations.id, pendingA.registrationId)))[0];
    expect(rowA?.admission).toBe("rejected");
    const ledgerA = await db
      .select()
      .from(notificationLedger)
      .where(and(eq(notificationLedger.registrationId, pendingA.registrationId), eq(notificationLedger.kind, "registration_auto_declined")));
    expect(ledgerA).toHaveLength(1);

    // B: the state transition + audit row happen regardless -- the write is
    // not gated by whether the notification succeeds (design §3.4/§4).
    const rowB = (await db.select().from(registrations).where(eq(registrations.id, pendingB.registrationId)))[0];
    expect(rowB?.admission).toBe("rejected");
    const auditB = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, pendingB.registrationId), eq(auditLog.action, "registration.auto_decline")));
    expect(auditB).toHaveLength(1);
    const ledgerB = await db
      .select()
      .from(notificationLedger)
      .where(and(eq(notificationLedger.registrationId, pendingB.registrationId), eq(notificationLedger.kind, "registration_auto_declined")));
    expect(ledgerB).toHaveLength(0); // no ledger row -- the blocked check happens before the ledger insert
  });
});

describe("AC8 -- no inline literal user-facing string in either new scheduler file (both source text via the catalog)", () => {
  it("urgencyJobs.ts and autoDeclineJobs.ts call into the catalog for every composed message, and never hardcode the provisional English wording directly", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const urgencyPath = join(repoRoot, "apps", "bot", "src", "scheduler", "urgencyJobs.ts");
    const autoDeclinePath = join(repoRoot, "apps", "bot", "src", "scheduler", "autoDeclineJobs.ts");
    const urgencyText = readFileSync(urgencyPath, "utf8");
    const autoDeclineText = readFileSync(autoDeclinePath, "utf8");

    // Every composed message must actually go through getCatalog(...).
    expect(urgencyText).toContain("getCatalog(lang)");
    expect(autoDeclineText).toContain("catalog.autoDecline.notification");

    // Neither job file hardcodes the provisional English sentence itself --
    // it lives only in i18n/en.ts (and its ru.ts parallel), never duplicated
    // as an inline literal in the scheduler layer.
    expect(urgencyText).not.toContain("still pending 48 hours");
    expect(autoDeclineText).not.toContain("was not decided before registration closed");
  });
});
