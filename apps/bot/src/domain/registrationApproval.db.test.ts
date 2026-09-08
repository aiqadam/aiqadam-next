import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, chapters, profiles, registrations, users, venues } from "../db/schema.js";
import { createEvent, publishEvent } from "./event.js";
import { resolveOrCreateUser } from "./user.js";
import {
  approveRequest,
  getPendingRequestForOrganizer,
  listPendingRequestsForOrganizer,
  registerForEvent,
  rejectRequest,
} from "./registration.js";
import { renderRequestDetailMessage, renderRequestsListMessage } from "../handlers/organizerRequests.js";

// docs/agents/design/REQ-035.md — AC3 (zero Wishlist, static), AC5 (capacity under
// real concurrency), AC8 (no phone/email in the rendered list/detail), AC10 (exactly
// one audit_log row per approve/approve-override/reject). Real Postgres, same
// infrastructure/skip discipline as domain/registration.db.test.ts.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

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
      `[registrationApproval.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
    "TRUNCATE notification_ledger, audit_log, event_staff, registrations, events, venues, profiles, users, chapters CASCADE",
  );
});

let chapterSeq = 0;
let tgSeq = 1_020_000_000;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(chapters)
    .values({
      code: `req035-chapter-${chapterSeq}`,
      name: `REQ-035 Chapter ${chapterSeq}`,
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
  tgSeq += 1;
  const tgId = tgSeq;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `u${tgId}`, lang: "en" });
  return { id: user.id, tgId };
}

async function seedVenue(chapterId: string): Promise<string> {
  const rows = await db
    .insert(venues)
    .values({ chapterId, name: "REQ-035 Venue", address: "1 Test St", capacity: 500 })
    .returning({ id: venues.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedVenue: no row returned");
  return row.id;
}

async function seedPublishedEvent(chapterId: string, capacity: number): Promise<{ id: string; title: string }> {
  const venueId = await seedVenue(chapterId);
  const organizer = await seedUser();
  const title = `REQ-035 Event ${capacity}-${Date.now()}-${Math.random()}`;
  const eventId = await createEvent(
    db,
    organizer.id,
    chapterId,
    {
      title,
      description: "A test event",
      format: "meetup",
      venueId,
      startsAt: new Date("2026-10-01T18:00:00Z"),
      endsAt: new Date("2026-10-01T20:00:00Z"),
      registrationClosesAt: null,
      capacity,
      requiresInvite: false,
      requiresApproval: true,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, title, new Date());
  return { id: eventId, title };
}

// requiresApproval:true always yields "requested" regardless of seatsLeft
// (decideRegistrationOutcome row 6) -- safe to call any number of times
// without touching capacity.
async function seedPendingRequest(eventId: string): Promise<{ registrationId: string; userId: string; tgId: number }> {
  const user = await seedUser();
  const result = await registerForEvent(db, user.id, eventId, new Date("2026-09-01T00:00:00Z"));
  if (result.kind !== "requested" || result.registrationId === undefined) {
    throw new Error(`seedPendingRequest: expected 'requested', got ${result.kind}`);
  }
  return { registrationId: result.registrationId, userId: user.id, tgId: user.tgId };
}

async function countAuditRows(entityId: string): Promise<number> {
  const rows = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, entityId));
  return rows.length;
}

// ---------------------------------------------------------------------------
// AC3 — no wishlist table, migration, or row. Static, no DB dependency at
// all (runs even if dbAvailable is false) -- the same grep-the-repo shape
// prior requirements' analogous checks use, applied directly rather than
// trusted from BACKEND-DEV's/REVIEWER's/SECURITY-REVIEWER's self-reports.
// ---------------------------------------------------------------------------
describe("AC3 -- zero Wishlist entity anywhere in schema or migrations", () => {
  it("schema.ts and every migration file contain no 'wishlist' table/column/reference", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const schemaPath = join(repoRoot, "apps", "bot", "src", "db", "schema.ts");
    const schemaText = readFileSync(schemaPath, "utf8");
    expect(schemaText.toLowerCase()).not.toContain("wishlist");

    const migrationsDir = join(repoRoot, "apps", "bot", "drizzle");
    const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql"));
    expect(migrationFiles.length).toBeGreaterThan(0); // sanity: the dir must actually contain migrations
    for (const file of migrationFiles) {
      const text = readFileSync(join(migrationsDir, file), "utf8");
      expect(text.toLowerCase(), `migration ${file} must not mention wishlist`).not.toContain("wishlist");
    }
  });
});

// ---------------------------------------------------------------------------
// AC5 -- capacity enforced under real concurrent Postgres access.
// ---------------------------------------------------------------------------
describe("AC5 -- approveRequest: capacity never exceeded under real concurrency", () => {
  it(
    "requirement's literal shape: 20 iterations, two concurrent organizers approving the last seat, exactly one admits each time",
    async (t) => {
      if (!dbAvailable) {
        t.skip();
        return;
      }
      const ITERATIONS = 20;
      let admittedTotal = 0;
      let needsOverrideTotal = 0;

      for (let i = 0; i < ITERATIONS; i++) {
        const chapterId = await seedChapter();
        const event = await seedPublishedEvent(chapterId, 1); // capacity 1
        const reqA = await seedPendingRequest(event.id);
        const reqB = await seedPendingRequest(event.id);
        const organizer = await seedUser();
        await db.update(users).set({ role: "organizer", chapterId }).where(eq(users.id, organizer.id));

        const [outcomeA, outcomeB] = await Promise.all([
          approveRequest(db, reqA.registrationId, organizer.id, false, new Date()),
          approveRequest(db, reqB.registrationId, organizer.id, false, new Date()),
        ]);

        const kinds = [outcomeA.kind, outcomeB.kind].sort();
        expect(kinds).toEqual(["approve", "needs-override-confirmation"]);

        admittedTotal += [outcomeA, outcomeB].filter((o) => o.kind === "approve").length;
        needsOverrideTotal += [outcomeA, outcomeB].filter((o) => o.kind === "needs-override-confirmation").length;

        const admittedRows = await db
          .select({ id: registrations.id })
          .from(registrations)
          .where(and(eq(registrations.eventId, event.id), eq(registrations.admission, "admitted")));
        expect(admittedRows.length).toBe(1); // never more than one admitted for this event
      }

      expect(admittedTotal).toBe(ITERATIONS);
      expect(needsOverrideTotal).toBe(ITERATIONS);
    },
    60000,
  );

  it(
    "higher fan-in: 5 iterations of 10 concurrent approvals for the last seat, using a dedicated pool proven to open more than one real connection, exactly one admits each time",
    async (t) => {
      if (!dbAvailable) {
        t.skip();
        return;
      }
      // A dedicated pool, sized comfortably above the fan-in (10), so each
      // concurrent approveRequest call gets its OWN physical connection
      // rather than queueing behind a shared one (see the "AC5 special
      // design note" above -- this is what makes the totalCount assertion
      // below meaningful).
      const highConcurrencyPool = new Pool({ connectionString: TEST_DATABASE_URL, max: 30, connectionTimeoutMillis: 5000 });
      const highConcurrencyDb = drizzle(highConcurrencyPool, { schema });

      try {
        const ITERATIONS = 5;
        const FAN_IN = 10;

        for (let i = 0; i < ITERATIONS; i++) {
          const chapterId = await seedChapter();
          const event = await seedPublishedEvent(chapterId, 1); // capacity 1
          const requests = [];
          for (let j = 0; j < FAN_IN; j++) {
            requests.push(await seedPendingRequest(event.id));
          }
          const organizer = await seedUser();
          await db.update(users).set({ role: "organizer", chapterId }).where(eq(users.id, organizer.id));

          const totalCountBefore = highConcurrencyPool.totalCount;

          const promises = requests.map((r) =>
            approveRequest(highConcurrencyDb, r.registrationId, organizer.id, false, new Date()),
          );
          // Give every call's own pool.connect() a chance to fire before any
          // transaction has necessarily committed -- direct evidence that
          // more than one physical connection was opened for this batch,
          // not one connection serializing FAN_IN statements.
          await new Promise((resolve) => setImmediate(resolve));
          expect(highConcurrencyPool.totalCount).toBeGreaterThan(Math.min(1, totalCountBefore));
          expect(highConcurrencyPool.totalCount).toBeGreaterThan(1);

          const outcomes = await Promise.all(promises);

          const approveCount = outcomes.filter((o) => o.kind === "approve").length;
          const needsOverrideCount = outcomes.filter((o) => o.kind === "needs-override-confirmation").length;
          expect(approveCount).toBe(1);
          expect(needsOverrideCount).toBe(FAN_IN - 1);

          const admittedRows = await highConcurrencyDb
            .select({ id: registrations.id })
            .from(registrations)
            .where(and(eq(registrations.eventId, event.id), eq(registrations.admission, "admitted")));
          expect(admittedRows.length).toBe(1); // zero silent over-admissions even at 10-way fan-in
        }
      } finally {
        await highConcurrencyPool.end();
      }
    },
    120000,
  );
});

// ---------------------------------------------------------------------------
// AC8 -- the rendered list/detail views never carry phone or email, even
// when both are stored on the requester's profile.
// ---------------------------------------------------------------------------
describe("AC8 -- no phone/email in the rendered request list or detail view", () => {
  it("a requester with both phone and email stored never has either leak into the rendered output", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const req = await seedPendingRequest(event.id);

    const SECRET_PHONE = "+77011234567";
    const SECRET_EMAIL = "definitely-secret@example.com";
    await db.insert(profiles).values({
      userId: req.userId,
      firstName: "Aigerim",
      lastName: "Bekova",
      phone: SECRET_PHONE,
      email: SECRET_EMAIL,
      company: "Acme Robotics",
      position: "Backend Engineer",
      isStudent: false,
    });

    const listItems = await listPendingRequestsForOrganizer(db, event.id, "en");
    expect(listItems).toHaveLength(1);
    const item = listItems[0]!;

    const listView = renderRequestsListMessage(event.title, event.id, listItems, listItems.length, { current: 0, total: 1 }, null, "en");
    const listSerialized = listView.text + JSON.stringify(listView.keyboard);

    const detailItem = await getPendingRequestForOrganizer(db, req.registrationId, "en");
    expect(detailItem).not.toBeNull();
    const detailView = renderRequestDetailMessage(event.title, detailItem!, "en");
    const detailSerialized = detailView.text + JSON.stringify(detailView.keyboard);

    // Positive control -- confirms the fixture actually rendered something
    // real, so the negative assertions below aren't vacuously passing
    // against an empty/failed render.
    expect(detailSerialized).toContain("Acme Robotics");
    expect(item.company).toBe("Acme Robotics");

    for (const serialized of [listSerialized, detailSerialized]) {
      expect(serialized).not.toContain(SECRET_PHONE);
      expect(serialized).not.toContain(SECRET_EMAIL);
      expect(serialized.toLowerCase()).not.toContain("+7701123"); // partial-digit leak guard
    }
  });
});

// ---------------------------------------------------------------------------
// AC10 -- exactly one audit_log row per approve / approve-override / reject.
// ---------------------------------------------------------------------------
describe("AC10 -- exactly one audit_log row per write", () => {
  it("approveRequest (plain) writes exactly one audit_log row, action registration.approve", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 5);
    const req = await seedPendingRequest(event.id);
    const organizer = await seedUser();

    // Baseline captured right before the action under test (approve), NOT
    // before the registration was even created -- seedPendingRequest's own
    // registerForEvent call already wrote one 'registration.request' audit
    // row for this registrationId (registration.ts:242-254, unconditional
    // for every outcome including 'requested'), so the true baseline is 1,
    // not 0. Asserting deltas off this baseline (matching
    // registration.db.test.ts's REQ-034 AC6 pattern) keeps the assertion
    // correct regardless of how many rows precede the action.
    const before = await countAuditRows(req.registrationId);
    expect(before).toBe(1);

    const outcome = await approveRequest(db, req.registrationId, organizer.id, false, new Date());
    expect(outcome.kind).toBe("approve");

    const after = await countAuditRows(req.registrationId);
    expect(after).toBe(before + 1);

    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, req.registrationId));
    const approveRow = rows.find((r) => r.action === "registration.approve");
    expect(approveRow).toBeDefined();

    // Re-approving an already-decided row must add zero further rows -- part
    // of "exactly one," not a separate AC.
    const secondOutcome = await approveRequest(db, req.registrationId, organizer.id, false, new Date());
    expect(secondOutcome.kind).toBe("not-requested");
    expect(await countAuditRows(req.registrationId)).toBe(after);
  });

  it("approveRequest (override) writes exactly one audit_log row, action registration.approve_override", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 1); // capacity 1
    const reqFiller = await seedPendingRequest(event.id);
    const reqOverride = await seedPendingRequest(event.id);
    const organizer = await seedUser();

    // Fill the only seat first.
    const fillerOutcome = await approveRequest(db, reqFiller.registrationId, organizer.id, false, new Date());
    expect(fillerOutcome.kind).toBe("approve");

    // Baseline captured right before the action under test (the blocked-then
    // -overridden approve), not before creation -- reqOverride's own
    // seedPendingRequest call already wrote its 'registration.request' row.
    const before = await countAuditRows(reqOverride.registrationId);
    expect(before).toBe(1);

    // Without override -- must NOT write.
    const blockedOutcome = await approveRequest(db, reqOverride.registrationId, organizer.id, false, new Date());
    expect(blockedOutcome.kind).toBe("needs-override-confirmation");
    expect(await countAuditRows(reqOverride.registrationId)).toBe(before);

    // With override -- exactly one row, distinct action string.
    const overrideOutcome = await approveRequest(db, reqOverride.registrationId, organizer.id, true, new Date());
    expect(overrideOutcome.kind).toBe("approve-override");
    const after = await countAuditRows(reqOverride.registrationId);
    expect(after).toBe(before + 1);
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, reqOverride.registrationId));
    const overrideRow = rows.find((r) => r.action === "registration.approve_override");
    expect(overrideRow).toBeDefined();
  });

  it("rejectRequest writes exactly one audit_log row, action registration.reject, payload carries the reason", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 5);
    const req = await seedPendingRequest(event.id);
    const organizer = await seedUser();

    // Baseline captured right before the action under test (reject), not
    // before creation -- seedPendingRequest's own registerForEvent call
    // already wrote this registrationId's 'registration.request' row.
    const before = await countAuditRows(req.registrationId);
    expect(before).toBe(1);

    const outcome = await rejectRequest(db, req.registrationId, organizer.id, "Room is full for this cohort.", new Date());
    expect(outcome.kind).toBe("reject");

    const after = await countAuditRows(req.registrationId);
    expect(after).toBe(before + 1);

    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, req.registrationId));
    const rejectRow = rows.find((r) => r.action === "registration.reject");
    expect(rejectRow).toBeDefined();
    expect((rejectRow!.payload as { reason?: string } | null)?.reason).toBe("Room is full for this cohort.");

    // Re-rejecting an already-decided row adds zero further rows.
    const secondOutcome = await rejectRequest(db, req.registrationId, organizer.id, "second attempt", new Date());
    expect(secondOutcome.kind).toBe("not-requested");
    expect(await countAuditRows(req.registrationId)).toBe(after);
  });
});
