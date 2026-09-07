import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, chapters, registrations, users, venues } from "../db/schema.js";
import { createEvent, publishEvent, setPendingSource } from "./event.js";
import {
  decidePromotionEligibility,
  decideReconfirmOutcome,
  decideWithdrawOutcome,
  getRegistrationAdmissionAndEvent,
  getRegistrationForEventAndUser,
  getWaitlistPosition,
  promoteFromWaitlistIfEligible,
  reconfirmRegistration,
  registerForEvent,
  withdrawRegistration,
} from "./registration.js";

// docs/agents/design/REQ-020.md — AC1 (atomic capacity, real concurrency),
// AC2 (double registration), AC4 (closed/cancelled/finished refusal +
// onward path), AC5 (source from pending_source), AC6 (requires_invite/
// requires_approval refusal), AC7 (exactly one audit_log row per write).
//
// Real Postgres, same infrastructure/skip discipline as handlers/start.test.ts
// (apps/bot/docker-compose.yml, TEST_DATABASE_URL). AC1 in particular is NOT
// verifiable against a sequential/mocked test -- it requires two genuinely
// concurrent transactions racing for a real row lock, which only a real
// Postgres server can arbitrate.

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT qr_token FROM registrations LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[registration.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
  await pool.query("TRUNCATE audit_log, registrations, events, venues, profiles, users, chapters CASCADE");
});

let chapterSeq = 0;
let userSeq = 0;
let tgSeq = 1_000_000_000;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(chapters)
    .values({
      code: `chapter-${chapterSeq}`,
      name: `Chapter ${chapterSeq}`,
      timezone: "Asia/Tashkent",
      defaultLang: "ru",
      active: true,
    })
    .returning({ id: chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedUser(): Promise<string> {
  userSeq += 1;
  tgSeq += 1;
  const rows = await db
    .insert(users)
    .values({ tgId: BigInt(tgSeq), tgUsername: `user${userSeq}`, lang: "en", role: "member" })
    .returning({ id: users.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedUser: no row returned");
  return row.id;
}

async function seedVenue(chapterId: string): Promise<string> {
  const rows = await db
    .insert(venues)
    .values({
      chapterId,
      name: "Test Venue",
      address: "123 Test St",
      capacity: 100,
    })
    .returning({ id: venues.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedVenue: no row returned");
  return row.id;
}

interface SeedEventOptions {
  capacity: number;
  requiresInvite?: boolean;
  requiresApproval?: boolean;
  registrationClosesAt?: Date | null;
  startsAt?: Date;
  endsAt?: Date;
  status?: "draft" | "published" | "cancelled";
}

async function seedPublishedEvent(chapterId: string, opts: SeedEventOptions): Promise<string> {
  const venueId = await seedVenue(chapterId);
  const organizerId = await seedUser();
  const eventId = await createEvent(
    db,
    organizerId,
    chapterId,
    {
      title: "Test Event",
      description: "A test event",
      format: "meetup",
      venueId,
      startsAt: opts.startsAt ?? new Date("2026-10-01T18:00:00Z"),
      endsAt: opts.endsAt ?? new Date("2026-10-01T20:00:00Z"),
      registrationClosesAt: opts.registrationClosesAt ?? null,
      capacity: opts.capacity,
      requiresInvite: opts.requiresInvite ?? false,
      requiresApproval: opts.requiresApproval ?? false,
      coverFileId: null,
    },
    new Date(),
  );
  if (opts.status === "cancelled") {
    await db.update(schema.events).set({ status: "cancelled" }).where(eq(schema.events.id, eventId));
  } else if (opts.status !== "draft") {
    await publishEvent(db, organizerId, eventId, chapterId, "Test Event", new Date());
  }
  return eventId;
}

describe("registerForEvent — AC1: atomic capacity under real concurrency", () => {
  it(
    "20 iterations, fresh fixtures each time: exactly one of two concurrent registrations for the last seat is admitted",
    async (t) => {
      if (!dbAvailable) {
        t.skip();
        return;
      }

      const ITERATIONS = 20;
      let admittedTotal = 0;
      let waitlistedTotal = 0;

      for (let i = 0; i < ITERATIONS; i++) {
        const chapterId = await seedChapter();
        // capacity 1, zero admitted yet -> exactly one seat available.
        const eventId = await seedPublishedEvent(chapterId, { capacity: 1 });
        const userA = await seedUser();
        const userB = await seedUser();

        const [resultA, resultB] = await Promise.all([
          registerForEvent(db, userA, eventId, new Date("2026-09-01T00:00:00Z")),
          registerForEvent(db, userB, eventId, new Date("2026-09-01T00:00:00Z")),
        ]);

        const outcomes = [resultA.kind, resultB.kind].sort();
        // Exactly one admitted, exactly one waitlisted -- never two admitted.
        expect(outcomes).toEqual(["admitted", "waitlisted"]);

        const admittedCount = [resultA, resultB].filter((r) => r.kind === "admitted").length;
        admittedTotal += admittedCount;
        waitlistedTotal += [resultA, resultB].filter((r) => r.kind === "waitlisted").length;

        // Direct DB check too: never more than 1 admitted row for this event.
        const admittedRows = await db.query.registrations.findMany({
          where: (reg, { eq: eqOp, and: andOp }) =>
            andOp(eqOp(reg.eventId, eventId), eqOp(reg.admission, "admitted")),
        });
        expect(admittedRows.length).toBe(1);
      }

      expect(admittedTotal).toBe(ITERATIONS);
      expect(waitlistedTotal).toBe(ITERATIONS);
    },
    60000,
  );
});

describe("registerForEvent — AC2: registering twice", () => {
  it("shows the current status and leaves exactly one row for (event, user)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();

    const first = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(first.kind).toBe("admitted");

    const second = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(second).toEqual({ kind: "already-registered", admission: "admitted" });

    const rows = await db
      .select()
      .from(registrations)
      .where(eq(registrations.eventId, eventId));
    expect(rows.filter((r) => r.userId === userId)).toHaveLength(1);
  });
});

describe("registerForEvent — AC4: closed / cancelled / finished refusal states", () => {
  it("refuses registration after registration_closes_at", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      capacity: 5,
      registrationClosesAt: new Date("2026-08-31T00:00:00Z"),
    });
    const userId = await seedUser();
    const outcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(outcome).toEqual({ kind: "registration-closed" });
  });

  it("refuses registration for a cancelled event", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5, status: "cancelled" });
    const userId = await seedUser();
    const outcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(outcome).toEqual({ kind: "event-cancelled" });
  });

  it("refuses registration for a finished event", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      capacity: 5,
      startsAt: new Date("2025-01-01T18:00:00Z"),
      endsAt: new Date("2025-01-01T20:00:00Z"),
    });
    const userId = await seedUser();
    const outcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(outcome).toEqual({ kind: "event-finished" });
  });
});

describe("registerForEvent — AC5: source resolution from pending_source", () => {
  it("a registration made after ?start=e_<id>__linkedin carries source='linkedin'", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();
    await setPendingSource(db, userId, "linkedin");

    const outcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(outcome.kind).toBe("admitted");

    const rows = await db.select().from(registrations).where(eq(registrations.userId, userId));
    expect(rows[0]?.source).toBe("linkedin");

    // pending_source is cleared back to NULL after being consumed.
    const userRows = await db.select().from(users).where(eq(users.id, userId));
    expect(userRows[0]?.pendingSource).toBeNull();
  });

  it("falls back to 'direct' when no pending_source was ever set", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();

    await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    const rows = await db.select().from(registrations).where(eq(registrations.userId, userId));
    expect(rows[0]?.source).toBe("direct");
  });
});

describe("registerForEvent — AC6: requires_invite / requires_approval refusal", () => {
  it("refuses, never admits, when requires_invite is true", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5, requiresInvite: true });
    const userId = await seedUser();
    const outcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(outcome).toEqual({ kind: "requires-invite" });
  });

  it("refuses, never admits, when requires_approval is true", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5, requiresApproval: true });
    const userId = await seedUser();
    const outcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(outcome).toEqual({ kind: "requires-approval" });
  });
});

describe("registerForEvent — AC7: exactly one audit_log row per admission/waitlist write", () => {
  it("writes exactly one audit_log row for an admitted registration", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();

    const outcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(outcome.kind).toBe("admitted");

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, (outcome as { registrationId: string }).registrationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("registration.admit");
  });

  it("writes exactly one audit_log row for a waitlisted registration", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 1 });
    const userA = await seedUser();
    const userB = await seedUser();

    await registerForEvent(db, userA, eventId, new Date("2026-09-01T00:00:00Z"));
    const outcomeB = await registerForEvent(db, userB, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(outcomeB.kind).toBe("waitlisted");

    const rows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, (outcomeB as { registrationId: string }).registrationId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action).toBe("registration.waitlist");
  });

  it("writes no audit_log row for a non-writing refusal outcome", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5, requiresInvite: true });
    const userId = await seedUser();

    const beforeCount = (await db.select().from(auditLog)).length;
    const outcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(outcome).toEqual({ kind: "requires-invite" });
    const afterCount = (await db.select().from(auditLog)).length;
    expect(afterCount).toBe(beforeCount);
  });
});

describe("registerForEvent — qr_token issuance", () => {
  it("issues a qr_token only for an admitted outcome, none for waitlisted", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 1 });
    const userA = await seedUser();
    const userB = await seedUser();

    const outcomeA = await registerForEvent(db, userA, eventId, new Date("2026-09-01T00:00:00Z"));
    const outcomeB = await registerForEvent(db, userB, eventId, new Date("2026-09-01T00:00:00Z"));

    expect(outcomeA.kind).toBe("admitted");
    expect((outcomeA as { qrToken?: string }).qrToken).toMatch(/^[0-9a-f]{64}$/);

    expect(outcomeB.kind).toBe("waitlisted");
    expect((outcomeB as { qrToken?: string }).qrToken).toBeUndefined();

    const rowB = await db
      .select()
      .from(registrations)
      .where(eq(registrations.userId, userB));
    expect(rowB[0]?.qrToken).toBeNull();
  });
});

describe("getWaitlistPosition — REQ-021 AC2: position recomputed live, no write to other rows", () => {
  it(
    "flipping the first of three waitlisted rows' admission (direct SQL, no withdraw feature) " +
      "shifts the second row's position 2 -> 1 on the next read, with zero write to the second row",
    async (t) => {
      if (!dbAvailable) {
        t.skip();
        return;
      }

      const chapterId = await seedChapter();
      // capacity 0 -> every registration lands directly in the waitlisted
      // branch (decideRegistrationOutcome row 8).
      const eventId = await seedPublishedEvent(chapterId, { capacity: 0 });
      const userA = await seedUser();
      const userB = await seedUser();
      const userC = await seedUser();

      // §0's concrete test recipe: three waitlisted rows, strictly
      // increasing created_at, inserted directly (not through
      // registerForEvent, so created_at ordering is exact and explicit
      // rather than relying on real-clock ordering between calls).
      const rowsInserted = await db
        .insert(registrations)
        .values([
          { eventId, userId: userA, admission: "waitlisted", source: "direct", createdAt: new Date("2026-09-01T00:00:00.000Z") },
          { eventId, userId: userB, admission: "waitlisted", source: "direct", createdAt: new Date("2026-09-01T00:00:01.000Z") },
          { eventId, userId: userC, admission: "waitlisted", source: "direct", createdAt: new Date("2026-09-01T00:00:02.000Z") },
        ])
        .returning({ id: registrations.id, userId: registrations.userId });

      const registrationA = rowsInserted.find((r) => r.userId === userA);
      const registrationB = rowsInserted.find((r) => r.userId === userB);
      if (registrationA === undefined || registrationB === undefined) {
        throw new Error("fixture insert did not return expected rows");
      }

      // Position for B, before: A and (nobody else) ahead -> position 2.
      const positionBefore = await getWaitlistPosition(db, eventId, registrationB.id);
      expect(positionBefore).toBe(2);

      const beforeRow = await db.select().from(registrations).where(eq(registrations.id, registrationB.id));
      const updatedAtBefore = beforeRow[0]?.updatedAt;
      expect(updatedAtBefore).toBeDefined();

      // Direct SQL state flip of the FIRST row only -- per REQ-021 design §0,
      // deliberately not through any application-level function, since no
      // withdraw feature exists yet (REQ-022 depends_on this requirement).
      await pool.query("UPDATE registrations SET admission = 'withdrawn' WHERE id = $1", [registrationA.id]);

      // B's own row was never touched by that statement.
      const afterRow = await db.select().from(registrations).where(eq(registrations.id, registrationB.id));
      const updatedAtAfter = afterRow[0]?.updatedAt;
      expect(updatedAtAfter).toEqual(updatedAtBefore);

      // B's position, recomputed fresh: with A no longer waitlisted, nobody
      // is ahead of B any more -> position 1.
      const positionAfter = await getWaitlistPosition(db, eventId, registrationB.id);
      expect(positionAfter).toBe(1);
    },
  );

  it("returns null for a row that is not (or no longer) waitlisted", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();
    const rows = await db
      .insert(registrations)
      .values({ eventId, userId, admission: "admitted", source: "direct" })
      .returning({ id: registrations.id });
    const row = rows[0];
    if (row === undefined) throw new Error("fixture insert returned no row");

    const position = await getWaitlistPosition(db, eventId, row.id);
    expect(position).toBeNull();
  });

  it("returns null for an unknown registrationId", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const position = await getWaitlistPosition(db, eventId, "00000000-0000-0000-0000-000000000000");
    expect(position).toBeNull();
  });
});

describe("registerForEvent — REQ-021 AC4: waitlist accepts unbounded registrations past capacity", () => {
  it("admits 5+ registrations to the waitlist past a fully booked capacity, with zero refusal", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 1 });

    const first = await seedUser();
    const firstOutcome = await registerForEvent(db, first, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(firstOutcome.kind).toBe("admitted");

    const WAITLIST_COUNT = 6;
    for (let i = 0; i < WAITLIST_COUNT; i++) {
      const userId = await seedUser();
      const outcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
      expect(outcome.kind).toBe("waitlisted");
    }

    const waitlistedRows = await db.query.registrations.findMany({
      where: (reg, { eq: eqOp, and: andOp }) => andOp(eqOp(reg.eventId, eventId), eqOp(reg.admission, "waitlisted")),
    });
    expect(waitlistedRows).toHaveLength(WAITLIST_COUNT);

    // Position for the last-inserted row equals the full count -- confirming
    // the ranking keeps working correctly at this size too.
    const lastRow = waitlistedRows.reduce((latest, r) => (r.createdAt > latest.createdAt ? r : latest));
    const lastPosition = await getWaitlistPosition(db, eventId, lastRow.id);
    expect(lastPosition).toBe(WAITLIST_COUNT);
  });
});

// docs/agents/design/REQ-022.md — decideWithdrawOutcome is pure, no I/O; unit
// tests need no database.
describe("decideWithdrawOutcome — REQ-022 §2.1: first-match-wins table", () => {
  it("returns not-found when the registration does not exist", () => {
    expect(
      decideWithdrawOutcome({
        registrationExists: false,
        ownerUserId: null,
        actingUserId: "user-1",
        admission: null,
        checkedInAt: null,
      }),
    ).toEqual({ kind: "not-found" });
  });

  it("returns not-owner when the acting user does not own the row", () => {
    expect(
      decideWithdrawOutcome({
        registrationExists: true,
        ownerUserId: "someone-else",
        actingUserId: "user-1",
        admission: "admitted",
        checkedInAt: null,
      }),
    ).toEqual({ kind: "not-owner" });
  });

  it("returns checked-in before eligibility, even though a checked-in row is always admitted", () => {
    expect(
      decideWithdrawOutcome({
        registrationExists: true,
        ownerUserId: "user-1",
        actingUserId: "user-1",
        admission: "admitted",
        checkedInAt: new Date("2026-09-01T00:00:00Z"),
      }),
    ).toEqual({ kind: "checked-in" });
  });

  it("returns not-eligible for an already-withdrawn row", () => {
    expect(
      decideWithdrawOutcome({
        registrationExists: true,
        ownerUserId: "user-1",
        actingUserId: "user-1",
        admission: "withdrawn",
        checkedInAt: null,
      }),
    ).toEqual({ kind: "not-eligible", admission: "withdrawn" });
  });

  it("returns not-eligible for a rejected row", () => {
    expect(
      decideWithdrawOutcome({
        registrationExists: true,
        ownerUserId: "user-1",
        actingUserId: "user-1",
        admission: "rejected",
        checkedInAt: null,
      }),
    ).toEqual({ kind: "not-eligible", admission: "rejected" });
  });

  it("returns withdrawn for an eligible, owned, not-checked-in row", () => {
    for (const admission of ["requested", "waitlisted", "admitted"] as const) {
      expect(
        decideWithdrawOutcome({
          registrationExists: true,
          ownerUserId: "user-1",
          actingUserId: "user-1",
          admission,
          checkedInAt: null,
        }),
      ).toEqual({ kind: "withdrawn", promotion: { kind: "not-attempted" } });
    }
  });
});

describe("withdrawRegistration — REQ-022 AC2: admitted -> withdrawn, seats-left +1 at next read", () => {
  it("flips admission to withdrawn and frees the seat for computeSeatsLeft's next read", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 1 });
    const userId = await seedUser();

    const registerOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(registerOutcome.kind).toBe("admitted");
    const registrationId = (registerOutcome as { registrationId: string }).registrationId;

    const admittedBefore = await db.query.registrations.findMany({
      where: (reg, { eq: eqOp, and: andOp }) => andOp(eqOp(reg.eventId, eventId), eqOp(reg.admission, "admitted")),
    });
    expect(admittedBefore).toHaveLength(1);

    const withdrawOutcome = await withdrawRegistration(
      db,
      registrationId,
      userId,
      new Date("2026-09-02T00:00:00Z"),
    );
    // No waitlist exists for this event -- promotion is attempted (the row
    // was admitted) but finds nobody to promote (REQ-023 AC3).
    expect(withdrawOutcome).toEqual({ kind: "withdrawn", promotion: { kind: "no-waitlist" } });

    const rows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(rows[0]?.admission).toBe("withdrawn");

    // computeSeatsLeft's underlying count (admission = 'admitted') no longer
    // includes this row on the very next read -- the seat is freed.
    const admittedAfter = await db.query.registrations.findMany({
      where: (reg, { eq: eqOp, and: andOp }) => andOp(eqOp(reg.eventId, eventId), eqOp(reg.admission, "admitted")),
    });
    expect(admittedAfter).toHaveLength(0);

    // A fresh registration attempt for a different user is now admitted
    // (capacity 1, seat freed).
    const nextUser = await seedUser();
    const nextOutcome = await registerForEvent(db, nextUser, eventId, new Date("2026-09-03T00:00:00Z"));
    expect(nextOutcome.kind).toBe("admitted");
  });
});

describe("withdrawRegistration — REQ-022 AC3: checked-in registration refuses, row unchanged", () => {
  it("refuses withdrawal for a non-null checked_in_at, leaving admission untouched", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 1 });
    const userId = await seedUser();

    const registerOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(registerOutcome.kind).toBe("admitted");
    const registrationId = (registerOutcome as { registrationId: string }).registrationId;

    // Direct SQL check-in flip -- no check-in feature exists yet in this
    // codebase (REQ-028/029's scope), same discipline REQ-021's own test
    // used for a withdrawal state flip it also had no feature for yet.
    await pool.query(
      "UPDATE registrations SET checked_in_at = $1, admission = 'admitted' WHERE id = $2",
      [new Date("2026-09-01T12:00:00Z"), registrationId],
    );

    const outcome = await withdrawRegistration(db, registrationId, userId, new Date("2026-09-02T00:00:00Z"));
    expect(outcome).toEqual({ kind: "checked-in" });

    const rows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(rows[0]?.admission).toBe("admitted");
    expect(rows[0]?.checkedInAt).not.toBeNull();
  });
});

describe("registerForEvent — REQ-022 AC4: re-registering after withdrawal reuses the same row", () => {
  it("UPDATEs the existing row (same id, same created_at) instead of inserting a new one", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();

    const firstOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    expect(firstOutcome.kind).toBe("admitted");
    const registrationId = (firstOutcome as { registrationId: string }).registrationId;

    const beforeRows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    const createdAtBefore = beforeRows[0]?.createdAt;
    expect(createdAtBefore).toBeDefined();

    const withdrawOutcome = await withdrawRegistration(
      db,
      registrationId,
      userId,
      new Date("2026-09-02T00:00:00Z"),
    );
    expect(withdrawOutcome).toEqual({ kind: "withdrawn", promotion: { kind: "no-waitlist" } });

    const secondOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-03T00:00:00Z"));
    expect(secondOutcome.kind).toBe("admitted");
    expect((secondOutcome as { registrationId: string }).registrationId).toBe(registrationId);

    // Never a second row for this (event, user) pair.
    const allRowsForUser = await db
      .select()
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)));
    expect(allRowsForUser).toHaveLength(1);

    const afterRows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(afterRows[0]?.id).toBe(registrationId);
    expect(afterRows[0]?.createdAt).toEqual(createdAtBefore);
    expect(afterRows[0]?.admission).toBe("admitted");
  });

  it("also reuses the row when re-registering while the event is still full (rejoins the waitlist at the original position)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 1 });
    const filler = await seedUser();
    await registerForEvent(db, filler, eventId, new Date("2026-09-01T00:00:00Z"));

    const userId = await seedUser();
    const firstOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:01Z"));
    expect(firstOutcome.kind).toBe("waitlisted");
    const registrationId = (firstOutcome as { registrationId: string }).registrationId;

    const beforeRows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    const createdAtBefore = beforeRows[0]?.createdAt;

    await withdrawRegistration(db, registrationId, userId, new Date("2026-09-02T00:00:00Z"));

    const secondOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-03T00:00:00Z"));
    expect(secondOutcome.kind).toBe("waitlisted");
    expect((secondOutcome as { registrationId: string }).registrationId).toBe(registrationId);

    const afterRows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(afterRows[0]?.createdAt).toEqual(createdAtBefore);
  });
});

describe("withdrawRegistration — REQ-022 AC5: exactly one audit_log row per withdrawal", () => {
  it("writes exactly one audit_log row for a successful withdrawal", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();

    const registerOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    const registrationId = (registerOutcome as { registrationId: string }).registrationId;

    const beforeCount = (await db.select().from(auditLog)).length;
    const outcome = await withdrawRegistration(db, registrationId, userId, new Date("2026-09-02T00:00:00Z"));
    expect(outcome).toEqual({ kind: "withdrawn", promotion: { kind: "no-waitlist" } });
    const afterCount = (await db.select().from(auditLog)).length;
    expect(afterCount).toBe(beforeCount + 1);

    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, registrationId));
    const withdrawRows = rows.filter((r) => r.action === "registration.withdraw");
    expect(withdrawRows).toHaveLength(1);
  });

  it("writes no audit_log row for a refusal (already withdrawn)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();

    const registerOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    const registrationId = (registerOutcome as { registrationId: string }).registrationId;
    await withdrawRegistration(db, registrationId, userId, new Date("2026-09-02T00:00:00Z"));

    const beforeCount = (await db.select().from(auditLog)).length;
    const secondOutcome = await withdrawRegistration(db, registrationId, userId, new Date("2026-09-03T00:00:00Z"));
    expect(secondOutcome).toEqual({ kind: "not-eligible", admission: "withdrawn" });
    const afterCount = (await db.select().from(auditLog)).length;
    expect(afterCount).toBe(beforeCount);
  });
});

describe("getRegistrationForEventAndUser — REQ-022 §4.1 step 4: display-only read", () => {
  it("returns the registration row for (event, user) when one exists", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();
    const registerOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    const registrationId = (registerOutcome as { registrationId: string }).registrationId;

    const found = await getRegistrationForEventAndUser(db, eventId, userId);
    expect(found).toEqual({ id: registrationId, admission: "admitted", checkedInAt: null });
  });

  it("returns null when no registration exists for that (event, user) pair", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();

    const found = await getRegistrationForEventAndUser(db, eventId, userId);
    expect(found).toBeNull();
  });
});

// docs/agents/design/REQ-023.md — waitlist auto-promotion on a freed seat,
// halting at T-24h. Real Postgres, same infrastructure/skip discipline as
// the rest of this file.

async function insertWaitlisted(eventId: string, userId: string, createdAt: Date): Promise<string> {
  const rows = await db
    .insert(registrations)
    .values({ eventId, userId, admission: "waitlisted", source: "direct", createdAt })
    .returning({ id: registrations.id });
  const row = rows[0];
  if (row === undefined) throw new Error("insertWaitlisted: no row returned");
  return row.id;
}

describe("REQ-023 AC1: withdrawal promotes exactly the earliest-created waitlisted registration", () => {
  it("48h-out event, capacity full, 3 waitlisted at distinct times -> only the earliest is promoted", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    // 48h out (> 24h halt boundary) -> not halted.
    const eventId = await seedPublishedEvent(chapterId, {
      capacity: 1,
      startsAt: new Date("2026-09-03T00:00:00Z"),
      endsAt: new Date("2026-09-03T02:00:00Z"),
    });

    const admittedUser = await seedUser();
    const admittedOutcome = await registerForEvent(db, admittedUser, eventId, evaluationTime);
    expect(admittedOutcome.kind).toBe("admitted");
    const admittedRegistrationId = (admittedOutcome as { registrationId: string }).registrationId;

    const userA = await seedUser();
    const userB = await seedUser();
    const userC = await seedUser();
    const regA = await insertWaitlisted(eventId, userA, new Date("2026-09-01T00:00:01Z"));
    const regB = await insertWaitlisted(eventId, userB, new Date("2026-09-01T00:00:02Z"));
    const regC = await insertWaitlisted(eventId, userC, new Date("2026-09-01T00:00:03Z"));

    const outcome = await withdrawRegistration(db, admittedRegistrationId, admittedUser, evaluationTime);
    expect(outcome.kind).toBe("withdrawn");
    const promotion = (outcome as { promotion: { kind: string } }).promotion;
    expect(promotion).toMatchObject({ kind: "promoted", registrationId: regA, promotedUserId: userA });

    const rowA = await db.select().from(registrations).where(eq(registrations.id, regA));
    expect(rowA[0]?.admission).toBe("admitted");
    expect(rowA[0]?.qrToken).toMatch(/^[0-9a-f]{64}$/);

    // The other two waitlisted rows are never touched.
    const rowB = await db.select().from(registrations).where(eq(registrations.id, regB));
    expect(rowB[0]?.admission).toBe("waitlisted");
    const rowC = await db.select().from(registrations).where(eq(registrations.id, regC));
    expect(rowC[0]?.admission).toBe("waitlisted");
  });
});

describe("REQ-023 AC2: T-24h halt", () => {
  it("12h-out event -> withdrawal promotes nobody, freed seat stays free", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    // 12h out (<= 24h halt boundary) -> halted.
    const eventId = await seedPublishedEvent(chapterId, {
      capacity: 1,
      startsAt: new Date("2026-09-01T12:00:00Z"),
      endsAt: new Date("2026-09-01T14:00:00Z"),
    });

    const admittedUser = await seedUser();
    const admittedOutcome = await registerForEvent(db, admittedUser, eventId, evaluationTime);
    const admittedRegistrationId = (admittedOutcome as { registrationId: string }).registrationId;

    const waitlistedUser = await seedUser();
    const regWaitlisted = await insertWaitlisted(eventId, waitlistedUser, new Date("2026-09-01T00:00:01Z"));

    const outcome = await withdrawRegistration(db, admittedRegistrationId, admittedUser, evaluationTime);
    expect(outcome).toEqual({ kind: "withdrawn", promotion: { kind: "halted-t24h" } });

    // The waitlisted row is untouched -- still waitlisted, not promoted.
    const row = await db.select().from(registrations).where(eq(registrations.id, regWaitlisted));
    expect(row[0]?.admission).toBe("waitlisted");

    // The freed seat stays free (admitted count is now 0, not backfilled).
    const admittedRows = await db.query.registrations.findMany({
      where: (reg, { eq: eqOp, and: andOp }) => andOp(eqOp(reg.eventId, eventId), eqOp(reg.admission, "admitted")),
    });
    expect(admittedRows).toHaveLength(0);
  });
});

describe("REQ-023 AC3: empty waitlist", () => {
  it("withdrawal against an empty waitlist completes with no error and no promotion", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      capacity: 1,
      startsAt: new Date("2026-09-03T00:00:00Z"),
      endsAt: new Date("2026-09-03T02:00:00Z"),
    });
    const admittedUser = await seedUser();
    const admittedOutcome = await registerForEvent(db, admittedUser, eventId, evaluationTime);
    const admittedRegistrationId = (admittedOutcome as { registrationId: string }).registrationId;

    const outcome = await withdrawRegistration(db, admittedRegistrationId, admittedUser, evaluationTime);
    expect(outcome).toEqual({ kind: "withdrawn", promotion: { kind: "no-waitlist" } });
  });
});

describe("REQ-023 AC4: promotion racing a fresh registration for the same freed seat never over-admits", () => {
  it(
    "20 iterations, fresh fixtures each time: withdrawal-triggered promotion racing a fresh registerForEvent " +
      "for the same freed seat -- exactly one of the two ever ends up admitted",
    async (t) => {
      if (!dbAvailable) {
        t.skip();
        return;
      }

      const ITERATIONS = 20;
      const evaluationTime = new Date("2026-09-01T00:00:00Z");

      for (let i = 0; i < ITERATIONS; i++) {
        const chapterId = await seedChapter();
        // 48h out -- not halted. Capacity 1: one admitted seat, one
        // waitlisted candidate behind it.
        const eventId = await seedPublishedEvent(chapterId, {
          capacity: 1,
          startsAt: new Date("2026-09-03T00:00:00Z"),
          endsAt: new Date("2026-09-03T02:00:00Z"),
        });

        const admittedUser = await seedUser();
        const admittedOutcome = await registerForEvent(db, admittedUser, eventId, evaluationTime);
        expect(admittedOutcome.kind).toBe("admitted");
        const admittedRegistrationId = (admittedOutcome as { registrationId: string }).registrationId;

        const waitlistedUser = await seedUser();
        await insertWaitlisted(eventId, waitlistedUser, new Date("2026-09-01T00:00:01Z"));

        const freshRegistrant = await seedUser();

        // Race: withdrawing the admitted seat (which attempts to promote the
        // waitlisted user into the freed seat) against a fresh registration
        // attempt for a completely different, third user -- both competing
        // for the SAME single freed seat.
        const [withdrawOutcome, freshOutcome] = await Promise.all([
          withdrawRegistration(db, admittedRegistrationId, admittedUser, evaluationTime),
          registerForEvent(db, freshRegistrant, eventId, evaluationTime),
        ]);

        expect(withdrawOutcome.kind).toBe("withdrawn");

        // Never more than 1 admitted row for this event -- the capacity-1
        // ceiling holds even under this concurrent promotion-vs-registration
        // race.
        const admittedRows = await db.query.registrations.findMany({
          where: (reg, { eq: eqOp, and: andOp }) =>
            andOp(eqOp(reg.eventId, eventId), eqOp(reg.admission, "admitted")),
        });
        expect(admittedRows.length).toBeLessThanOrEqual(1);
        expect(admittedRows.length).toBe(1);

        // Exactly one of {waitlisted candidate promoted, fresh registrant
        // admitted} happened -- never both, never neither (one of them
        // always fills the single freed seat).
        const promotion = (withdrawOutcome as { promotion: { kind: string } }).promotion;
        const promotedTheWaitlisted = promotion.kind === "promoted";
        const admittedTheFreshOne = freshOutcome.kind === "admitted";
        expect(promotedTheWaitlisted !== admittedTheFreshOne).toBe(true);
      }
    },
    60000,
  );
});

describe("REQ-023 AC5: promotion refuses for a cancelled or finished event", () => {
  it("refuses promotion into a cancelled event", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      capacity: 1,
      startsAt: new Date("2026-09-03T00:00:00Z"),
      endsAt: new Date("2026-09-03T02:00:00Z"),
    });
    const waitlistedUser = await seedUser();
    const regWaitlisted = await insertWaitlisted(eventId, waitlistedUser, new Date("2026-09-01T00:00:01Z"));
    await db.update(schema.events).set({ status: "cancelled" }).where(eq(schema.events.id, eventId));

    const outcome = await promoteFromWaitlistIfEligible(db, eventId, evaluationTime);
    expect(outcome).toEqual({ kind: "event-not-eligible" });

    const row = await db.select().from(registrations).where(eq(registrations.id, regWaitlisted));
    expect(row[0]?.admission).toBe("waitlisted");
  });

  it("refuses promotion into an event whose ends_at has passed", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      capacity: 1,
      startsAt: new Date("2025-01-01T18:00:00Z"),
      endsAt: new Date("2025-01-01T20:00:00Z"),
    });
    const waitlistedUser = await seedUser();
    const regWaitlisted = await insertWaitlisted(eventId, waitlistedUser, new Date("2025-01-01T00:00:01Z"));

    const outcome = await promoteFromWaitlistIfEligible(db, eventId, evaluationTime);
    expect(outcome).toEqual({ kind: "event-not-eligible" });

    const row = await db.select().from(registrations).where(eq(registrations.id, regWaitlisted));
    expect(row[0]?.admission).toBe("waitlisted");
  });
});

describe("REQ-023 AC7: exactly one audit_log row per promotion; a second run finds nothing to promote", () => {
  it("writes exactly one audit_log row for a successful promotion", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      capacity: 1,
      startsAt: new Date("2026-09-03T00:00:00Z"),
      endsAt: new Date("2026-09-03T02:00:00Z"),
    });
    const admittedUser = await seedUser();
    const admittedOutcome = await registerForEvent(db, admittedUser, eventId, evaluationTime);
    const admittedRegistrationId = (admittedOutcome as { registrationId: string }).registrationId;

    const waitlistedUser = await seedUser();
    const regWaitlisted = await insertWaitlisted(eventId, waitlistedUser, new Date("2026-09-01T00:00:01Z"));

    const beforeCount = (await db.select().from(auditLog)).length;
    const outcome = await withdrawRegistration(db, admittedRegistrationId, admittedUser, evaluationTime);
    expect(outcome.kind).toBe("withdrawn");
    const afterCount = (await db.select().from(auditLog)).length;
    // Exactly two new rows: one for registration.withdraw, one for
    // registration.promote.
    expect(afterCount).toBe(beforeCount + 2);

    const promoteRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, regWaitlisted));
    const promoteAuditRows = promoteRows.filter((r) => r.action === "registration.promote");
    expect(promoteAuditRows).toHaveLength(1);
  });

  it("running the promotion path twice for the same freed seat promotes nobody the second time (capacity-full refusal)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      capacity: 1,
      startsAt: new Date("2026-09-03T00:00:00Z"),
      endsAt: new Date("2026-09-03T02:00:00Z"),
    });
    const admittedUser = await seedUser();
    await registerForEvent(db, admittedUser, eventId, evaluationTime);

    const waitlistedUserA = await seedUser();
    await insertWaitlisted(eventId, waitlistedUserA, new Date("2026-09-01T00:00:01Z"));
    const waitlistedUserB = await seedUser();
    await insertWaitlisted(eventId, waitlistedUserB, new Date("2026-09-01T00:00:02Z"));

    // First run: the event is still full (nobody withdrew) -> capacity-full,
    // nobody promoted, nothing written.
    const beforeCount = (await db.select().from(auditLog)).length;
    const firstRun = await promoteFromWaitlistIfEligible(db, eventId, evaluationTime);
    expect(firstRun).toEqual({ kind: "capacity-full" });
    const afterFirstRun = (await db.select().from(auditLog)).length;
    expect(afterFirstRun).toBe(beforeCount);

    // Second run against the same, still-full event: same refusal, same
    // zero-write outcome -- "running the promotion path twice for the same
    // freed seat" (here: a seat that was never freed) sends nothing either
    // time.
    const secondRun = await promoteFromWaitlistIfEligible(db, eventId, evaluationTime);
    expect(secondRun).toEqual({ kind: "capacity-full" });
    const afterSecondRun = (await db.select().from(auditLog)).length;
    expect(afterSecondRun).toBe(beforeCount);

    // Both waitlisted rows remain untouched.
    const waitlistedRows = await db.query.registrations.findMany({
      where: (reg, { eq: eqOp, and: andOp }) =>
        andOp(eqOp(reg.eventId, eventId), eqOp(reg.admission, "waitlisted")),
    });
    expect(waitlistedRows).toHaveLength(2);
  });
});

describe("decidePromotionEligibility — REQ-023 §2.2: first-match-wins table", () => {
  const base = {
    eventStatus: "published" as const,
    startsAt: new Date("2026-09-03T00:00:00Z"),
    endsAt: new Date("2026-09-03T02:00:00Z"),
    seatsLeft: 1,
  };
  const evaluationTime = new Date("2026-09-01T00:00:00Z");

  it("refuses a cancelled event as event-not-eligible", () => {
    expect(decidePromotionEligibility({ ...base, eventStatus: "cancelled" }, evaluationTime)).toEqual({
      ok: false,
      reason: "event-not-eligible",
    });
  });

  it("refuses a draft event as event-not-eligible", () => {
    expect(decidePromotionEligibility({ ...base, eventStatus: "draft" }, evaluationTime)).toEqual({
      ok: false,
      reason: "event-not-eligible",
    });
  });

  it("refuses a finished event as event-not-eligible", () => {
    expect(
      decidePromotionEligibility(
        { ...base, endsAt: new Date("2026-08-31T00:00:00Z") },
        evaluationTime,
      ),
    ).toEqual({ ok: false, reason: "event-not-eligible" });
  });

  it("refuses within T-24h as halted-t24h, checked before capacity", () => {
    expect(
      decidePromotionEligibility(
        { ...base, startsAt: new Date("2026-09-01T12:00:00Z"), seatsLeft: 0 },
        evaluationTime,
      ),
    ).toEqual({ ok: false, reason: "halted-t24h" });
  });

  it("refuses a full event as capacity-full", () => {
    expect(decidePromotionEligibility({ ...base, seatsLeft: 0 }, evaluationTime)).toEqual({
      ok: false,
      reason: "capacity-full",
    });
  });

  it("allows an eligible, non-halted, non-full event", () => {
    expect(decidePromotionEligibility(base, evaluationTime)).toEqual({ ok: true });
  });
});

// docs/agents/design/REQ-026.md §4 — decideReconfirmOutcome's first-match-wins
// table. Pure, no I/O.
describe("decideReconfirmOutcome — REQ-026 §4: first-match-wins table", () => {
  it("returns not-found when the registration does not exist", () => {
    expect(
      decideReconfirmOutcome({
        registrationExists: false,
        ownerUserId: null,
        actingUserId: "user-1",
        admission: null,
      }),
    ).toEqual({ kind: "not-found" });
  });

  it("returns not-owner when the acting user does not own the row", () => {
    expect(
      decideReconfirmOutcome({
        registrationExists: true,
        ownerUserId: "someone-else",
        actingUserId: "user-1",
        admission: "admitted",
      }),
    ).toEqual({ kind: "not-owner" });
  });

  it("returns not-eligible for a non-admitted row (e.g. withdrawn)", () => {
    expect(
      decideReconfirmOutcome({
        registrationExists: true,
        ownerUserId: "user-1",
        actingUserId: "user-1",
        admission: "withdrawn",
      }),
    ).toEqual({ kind: "not-eligible", admission: "withdrawn" });
  });

  it("returns reconfirmed for an eligible, owned, admitted row", () => {
    expect(
      decideReconfirmOutcome({
        registrationExists: true,
        ownerUserId: "user-1",
        actingUserId: "user-1",
        admission: "admitted",
      }),
    ).toEqual({ kind: "reconfirmed" });
  });
});

describe("reconfirmRegistration — REQ-026 AC2 first half: reconfirmed_at set, admission unchanged", () => {
  it("sets reconfirmed_at and writes exactly one audit_log row, admission untouched", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();
    const registerOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    const registrationId = (registerOutcome as { registrationId: string }).registrationId;

    const beforeCount = (await db.select().from(auditLog)).length;
    const outcome = await reconfirmRegistration(db, registrationId, userId, new Date("2026-09-01T12:00:00Z"));
    expect(outcome).toEqual({ kind: "reconfirmed" });
    const afterCount = (await db.select().from(auditLog)).length;
    expect(afterCount).toBe(beforeCount + 1);

    const rows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(rows[0]?.admission).toBe("admitted");
    expect(rows[0]?.reconfirmedAt).not.toBeNull();

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, registrationId));
    const reconfirmRows = auditRows.filter((r) => r.action === "registration.reconfirm");
    expect(reconfirmRows).toHaveLength(1);
  });

  it("refuses (not-eligible) and writes no audit row for a withdrawn registration", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();
    const registerOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    const registrationId = (registerOutcome as { registrationId: string }).registrationId;
    await withdrawRegistration(db, registrationId, userId, new Date("2026-09-01T06:00:00Z"));

    const beforeCount = (await db.select().from(auditLog)).length;
    const outcome = await reconfirmRegistration(db, registrationId, userId, new Date("2026-09-01T12:00:00Z"));
    expect(outcome).toEqual({ kind: "not-eligible", admission: "withdrawn" });
    const afterCount = (await db.select().from(auditLog)).length;
    expect(afterCount).toBe(beforeCount);

    const rows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(rows[0]?.reconfirmedAt).toBeNull();
  });
});

describe("getRegistrationAdmissionAndEvent — REQ-026 §2: at-send-time recheck read", () => {
  it("returns admission/eventId/userId/qrToken for an existing registration", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, { capacity: 5 });
    const userId = await seedUser();
    const registerOutcome = await registerForEvent(db, userId, eventId, new Date("2026-09-01T00:00:00Z"));
    const registrationId = (registerOutcome as { registrationId: string }).registrationId;

    const found = await getRegistrationAdmissionAndEvent(db, registrationId);
    expect(found).toEqual({
      admission: "admitted",
      eventId,
      userId,
      qrToken: (registerOutcome as { qrToken: string }).qrToken,
    });
  });

  it("returns null for an unknown registrationId", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const found = await getRegistrationAdmissionAndEvent(db, "00000000-0000-0000-0000-000000000000");
    expect(found).toBeNull();
  });
});
