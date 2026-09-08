import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, chapters, registrations, venues } from "../db/schema.js";
import { createEvent, publishEvent } from "./event.js";
import { resolveOrCreateUser } from "./user.js";
import { hasPastCheckIn, listPendingRequestsForOrganizer, registerForEvent } from "./registration.js";
import { getInviteCodeById, issueBulkInviteCode, issuePersonalInviteCode, redeemInviteCode } from "./inviteCode.js";

// docs/agents/design/REQ-038.md -- AC2, AC3, AC4 (concurrency), AC5, AC6, AC7, AC8, AC10,
// AC11. Real Postgres, same infrastructure/skip discipline as
// domain/registrationApproval.db.test.ts (REQ-035).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT used_count FROM invite_codes LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[inviteCodeRedeem.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
    "TRUNCATE notification_ledger, audit_log, invite_codes, registrations, events, venues, profiles, users, chapters CASCADE",
  );
});

let chapterSeq = 0;
let tgSeq = 1_050_000_000;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(chapters)
    .values({
      code: `req038-chapter-${chapterSeq}`,
      name: `REQ-038 Chapter ${chapterSeq}`,
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
    .values({ chapterId, name: "REQ-038 Venue", address: "1 Test St", capacity: 500 })
    .returning({ id: venues.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedVenue: no row returned");
  return row.id;
}

async function seedPublishedEvent(
  chapterId: string,
  capacity: number,
  requiresInvite: boolean,
  requiresApproval: boolean,
): Promise<{ id: string; title: string; organizerId: string }> {
  const venueId = await seedVenue(chapterId);
  const organizer = await seedUser();
  const title = `REQ-038 Event ${capacity}-${requiresInvite}-${requiresApproval}-${Date.now()}-${Math.random()}`;
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
      requiresInvite,
      requiresApproval,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, title, new Date());
  return { id: eventId, title, organizerId: organizer.id };
}

const EVAL_TIME = new Date("2026-09-01T00:00:00Z");
const FAR_FUTURE = new Date("2027-01-01T00:00:00Z");
const PAST_EXPIRY = new Date("2020-01-01T00:00:00Z");

async function countAuditRowsByActor(actorUserId: string): Promise<number> {
  const rows = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.actorUserId, actorUserId));
  return rows.length;
}

async function registrationCount(eventId: string, userId: string): Promise<number> {
  const rows = await db
    .select({ id: registrations.id })
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)));
  return rows.length;
}

// ---------------------------------------------------------------------------
// AC2 -- a PERSONAL code issued to user A is refused when redeemed by user B:
// no registration, used_count unchanged. A's own redemption of the SAME code
// is the positive control proving the refusal is identity-specific, not a
// bug in the code itself.
// ---------------------------------------------------------------------------
describe("AC2 -- personal code redeemed by someone other than the issuee is refused", () => {
  it("issuePersonalInviteCode(targetUserId=A); redeemInviteCode(redeemerUserId=B) -> invite-code-not-yours; zero registration for B; used_count stays 0; A can still redeem it", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10, true, false);
    const userA = await seedUser();
    const userB = await seedUser();
    const issued = await issuePersonalInviteCode(db, userA.id, event.id, userA.id, FAR_FUTURE, new Date());

    const outcomeB = await redeemInviteCode(db, userB.id, issued.code, null, EVAL_TIME);
    expect(outcomeB.kind).toBe("invite-code-not-yours");
    expect(await registrationCount(event.id, userB.id)).toBe(0);
    const codeRowAfterB = await getInviteCodeById(db, issued.id);
    expect(codeRowAfterB?.usedCount).toBe(0);

    // Positive control: the issuee's own redemption succeeds -- confirms the
    // refusal is identity-specific, not a defect in the code/lookup itself.
    const outcomeA = await redeemInviteCode(db, userA.id, issued.code, null, EVAL_TIME);
    expect(outcomeA.kind).toBe("admitted");
    const codeRowAfterA = await getInviteCodeById(db, issued.id);
    expect(codeRowAfterA?.usedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC3 -- expired / spent / unknown / wrong-event, each with its own reason,
// none creates a registration or changes used_count.
// ---------------------------------------------------------------------------
describe("AC3 -- expired / spent / unknown code / wrong-event code are each refused with their own distinct reason", () => {
  it("expired code -> invite-code-expired, no registration, used_count unchanged", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10, true, false);
    const organizer = await seedUser();
    const issued = await issueBulkInviteCode(db, organizer.id, event.id, 5, PAST_EXPIRY, new Date());
    const user = await seedUser();

    const outcome = await redeemInviteCode(db, user.id, issued.code, null, EVAL_TIME);
    expect(outcome.kind).toBe("invite-code-expired");
    expect(await registrationCount(event.id, user.id)).toBe(0);
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(0);
  });

  it("spent code (used_count === max_uses) -> invite-code-spent, no registration, used_count unchanged", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10, true, false);
    const organizer = await seedUser();
    const issued = await issueBulkInviteCode(db, organizer.id, event.id, 1, FAR_FUTURE, new Date());
    await db.update(schema.inviteCodes).set({ usedCount: 1 }).where(eq(schema.inviteCodes.id, issued.id));
    const user = await seedUser();

    const outcome = await redeemInviteCode(db, user.id, issued.code, null, EVAL_TIME);
    expect(outcome.kind).toBe("invite-code-spent");
    expect(await registrationCount(event.id, user.id)).toBe(0);
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(1); // unchanged, not incremented
  });

  it("unknown code string -> invite-code-not-found", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const user = await seedUser();
    const outcome = await redeemInviteCode(db, user.id, "THISCODEDOESNOTEXIST0000000", null, EVAL_TIME);
    expect(outcome.kind).toBe("invite-code-not-found");
  });

  it("a code redeemed against a DIFFERENT event than its own -> invite-code-wrong-event, no registration on either event, used_count unchanged", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventA = await seedPublishedEvent(chapterId, 10, true, false);
    const eventB = await seedPublishedEvent(chapterId, 10, true, false);
    const organizer = await seedUser();
    const issued = await issueBulkInviteCode(db, organizer.id, eventA.id, 5, FAR_FUTURE, new Date());
    const user = await seedUser();

    // Typed /redeem shape: explicitEventId = eventB.id, but the code's own
    // event_id is eventA.
    const outcome = await redeemInviteCode(db, user.id, issued.code, eventB.id, EVAL_TIME);
    expect(outcome.kind).toBe("invite-code-wrong-event");
    expect(await registrationCount(eventA.id, user.id)).toBe(0);
    expect(await registrationCount(eventB.id, user.id)).toBe(0);
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 -- concurrent redemption of the LAST remaining use of a bulk code:
// exactly one success, used_count never exceeds max_uses. See "AC4 -- special
// design note" above this file's fenced block for why this mirrors REQ-035's
// AC5 concurrency test and what makes it a genuine (not probabilistic) proof.
// Capacity is deliberately NOT the bottleneck in either case (event capacity
// is always well above the fan-in) -- only the invite_codes row lock can be
// what produces exactly one winner.
// ---------------------------------------------------------------------------
describe("AC4 -- redeemInviteCode: used_count never exceeds max_uses under real concurrency", () => {
  it(
    "requirement's literal shape: 20 iterations, two concurrent redeemers racing a code with exactly one use left, exactly one admits each time",
    async (t) => {
      if (!dbAvailable) {
        t.skip();
        return;
      }
      const ITERATIONS = 20;
      let admittedTotal = 0;
      let spentTotal = 0;

      for (let i = 0; i < ITERATIONS; i++) {
        const chapterId = await seedChapter();
        const event = await seedPublishedEvent(chapterId, 50, true, false); // capacity well above fan-in
        const organizer = await seedUser();
        const issued = await issueBulkInviteCode(db, organizer.id, event.id, 2, FAR_FUTURE, new Date());
        await db.update(schema.inviteCodes).set({ usedCount: 1 }).where(eq(schema.inviteCodes.id, issued.id)); // exactly one use left
        const userX = await seedUser();
        const userY = await seedUser();

        const [outcomeX, outcomeY] = await Promise.all([
          redeemInviteCode(db, userX.id, issued.code, null, EVAL_TIME),
          redeemInviteCode(db, userY.id, issued.code, null, EVAL_TIME),
        ]);

        const kinds = [outcomeX.kind, outcomeY.kind].sort();
        expect(kinds).toEqual(["admitted", "invite-code-spent"]);

        admittedTotal += [outcomeX, outcomeY].filter((o) => o.kind === "admitted").length;
        spentTotal += [outcomeX, outcomeY].filter((o) => o.kind === "invite-code-spent").length;

        const codeRow = await getInviteCodeById(db, issued.id);
        expect(codeRow?.usedCount).toBe(2); // == max_uses, never above

        const admittedRows = await db
          .select({ id: registrations.id })
          .from(registrations)
          .where(and(eq(registrations.eventId, event.id), eq(registrations.admission, "admitted")));
        expect(admittedRows.length).toBe(1);
      }

      expect(admittedTotal).toBe(ITERATIONS);
      expect(spentTotal).toBe(ITERATIONS);
    },
    60000,
  );

  it(
    "higher fan-in: 5 iterations of 10 concurrent redeemers racing a code with exactly one use left, using a dedicated pool proven to open more than one real connection, exactly one admits each time",
    async (t) => {
      if (!dbAvailable) {
        t.skip();
        return;
      }
      const highConcurrencyPool = new Pool({ connectionString: TEST_DATABASE_URL, max: 30, connectionTimeoutMillis: 5000 });
      const highConcurrencyDb = drizzle(highConcurrencyPool, { schema });

      try {
        const ITERATIONS = 5;
        const FAN_IN = 10;

        for (let i = 0; i < ITERATIONS; i++) {
          const chapterId = await seedChapter();
          const event = await seedPublishedEvent(chapterId, 50, true, false);
          const organizer = await seedUser();
          const issued = await issueBulkInviteCode(db, organizer.id, event.id, FAN_IN, FAR_FUTURE, new Date());
          await db
            .update(schema.inviteCodes)
            .set({ usedCount: FAN_IN - 1 })
            .where(eq(schema.inviteCodes.id, issued.id)); // exactly one use left
          const redeemers: { id: string }[] = [];
          for (let j = 0; j < FAN_IN; j++) {
            redeemers.push(await seedUser());
          }

          const totalCountBefore = highConcurrencyPool.totalCount;

          const promises = redeemers.map((r) => redeemInviteCode(highConcurrencyDb, r.id, issued.code, null, EVAL_TIME));
          // Give every call's own pool.connect() a chance to fire before any
          // transaction has necessarily committed -- direct evidence more
          // than one physical connection was opened for this batch.
          await new Promise((resolve) => setImmediate(resolve));
          expect(highConcurrencyPool.totalCount).toBeGreaterThan(Math.min(1, totalCountBefore));
          expect(highConcurrencyPool.totalCount).toBeGreaterThan(1);

          const outcomes = await Promise.all(promises);
          const admittedCount = outcomes.filter((o) => o.kind === "admitted").length;
          const spentCount = outcomes.filter((o) => o.kind === "invite-code-spent").length;
          expect(admittedCount).toBe(1);
          expect(spentCount).toBe(FAN_IN - 1);

          const codeRow = await getInviteCodeById(highConcurrencyDb, issued.id);
          expect(codeRow?.usedCount).toBe(FAN_IN); // == max_uses, never above

          const admittedRows = await highConcurrencyDb
            .select({ id: registrations.id })
            .from(registrations)
            .where(and(eq(registrations.eventId, event.id), eq(registrations.admission, "admitted")));
          expect(admittedRows.length).toBe(1);
        }
      } finally {
        await highConcurrencyPool.end();
      }
    },
    120000,
  );
});

// ---------------------------------------------------------------------------
// AC5 -- valid code + requires_approval=true -> 'requested', not 'admitted',
// and visible in REQ-035's organizer pending-request list.
// ---------------------------------------------------------------------------
describe("AC5 -- valid code on a requires_invite AND requires_approval event yields 'requested', visible to the organizer", () => {
  it("redeemInviteCode -> 'requested'; listPendingRequestsForOrganizer includes this redeemer", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10, true, true); // requiresInvite AND requiresApproval
    const organizer = await seedUser();
    const issued = await issueBulkInviteCode(db, organizer.id, event.id, 5, FAR_FUTURE, new Date());
    const user = await seedUser();

    const outcome = await redeemInviteCode(db, user.id, issued.code, null, EVAL_TIME);
    expect(outcome.kind).toBe("requested");

    const list = await listPendingRequestsForOrganizer(db, event.id, "en", EVAL_TIME);
    expect(list.some((item) => item.userId === user.id)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC6 -- valid code on a FULL-capacity requires_invite event yields
// 'waitlisted', not 'admitted': a code buys past the invite gate, not past
// capacity.
// ---------------------------------------------------------------------------
describe("AC6 -- valid code on a full-capacity requires_invite event yields 'waitlisted'", () => {
  it("capacity 1, already filled by a plain admitted registration; a valid code redemption waitlists, does not override capacity", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 1, true, false); // capacity 1, no approval gate
    const filler = await seedUser();
    // Fill the only seat via the past-attendee route is unnecessary here --
    // simplest is to directly exercise the code path for the filler too, so
    // the only seat is legitimately consumed before the case under test.
    const organizer = await seedUser();
    const fillerCode = await issueBulkInviteCode(db, organizer.id, event.id, 1, FAR_FUTURE, new Date());
    const fillerOutcome = await redeemInviteCode(db, filler.id, fillerCode.code, null, EVAL_TIME);
    expect(fillerOutcome.kind).toBe("admitted");

    const issued = await issueBulkInviteCode(db, organizer.id, event.id, 5, FAR_FUTURE, new Date());
    const redeemer = await seedUser();
    const outcome = await redeemInviteCode(db, redeemer.id, issued.code, null, EVAL_TIME);
    expect(outcome.kind).toBe("waitlisted");
  });
});

// ---------------------------------------------------------------------------
// AC7 -- past-attendee eligibility: a query, never a stored flag.
// ---------------------------------------------------------------------------
describe("AC7 -- past check-in satisfies the invite gate without any code; no past check-in is refused", () => {
  it("a user with checked_in_at set on a past registration is admitted to a NEW requires_invite event WITHOUT any code", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const pastEvent = await seedPublishedEvent(chapterId, 10, false, false);
    const user = await seedUser();
    const pastReg = await registerForEvent(db, user.id, pastEvent.id, EVAL_TIME);
    expect(pastReg.kind).toBe("admitted");
    // hasPastCheckIn inspects only checked_in_at IS NOT NULL -- set it
    // directly (design §2.1's own reasoning: a non-null value is already
    // structural evidence of past attendance; no separate "past" filter is
    // re-derived here or in the implementation).
    await db.update(registrations).set({ checkedInAt: new Date("2026-01-01T00:00:00Z") }).where(eq(registrations.id, pastReg.registrationId!));

    expect(await hasPastCheckIn(db, user.id)).toBe(true);

    const newEvent = await seedPublishedEvent(chapterId, 10, true, false); // requiresInvite, no approval
    const outcome = await registerForEvent(db, user.id, newEvent.id, EVAL_TIME);
    expect(outcome.kind).toBe("admitted"); // no code involved anywhere in this call
  });

  it("a user with NO past check-in registering for a requires_invite event WITHOUT a code is refused (requires-invite)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10, true, false);
    const user = await seedUser();
    expect(await hasPastCheckIn(db, user.id)).toBe(false);

    const outcome = await registerForEvent(db, user.id, event.id, EVAL_TIME);
    expect(outcome.kind).toBe("requires-invite");
  });

  it("static: no stored returning/attended-before column, cache, or flag anywhere in schema.ts", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const schemaPath = join(repoRoot, "apps", "bot", "src", "db", "schema.ts");
    const schemaText = readFileSync(schemaPath, "utf8");
    expect(schemaText).not.toMatch(/is_?returning|returning_status|attended_before|past_attendee|eligib/i);
  });
});

// ---------------------------------------------------------------------------
// AC8 -- the design artefact states FR-4's "configurable per event"
// resolution, and no column is added to `events` by this requirement.
// ---------------------------------------------------------------------------
describe("AC8 -- design artefact states the FR-4 resolution; no new events column", () => {
  it("docs/agents/design/REQ-038.md explicitly states resolution (a) and the 'no column added' conclusion", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const designPath = join(repoRoot, "docs", "agents", "design", "REQ-038.md");
    const designText = readFileSync(designPath, "utf8");
    // Normalize whitespace before the substring check so a markdown
    // line-wrap in the prose (this exact phrase wraps between "to" and
    // "every" in the committed source) can never break this assertion --
    // robust against any future rewrapping without weakening the check's
    // intent (still requires the full phrase, in order, contiguous once
    // wrapping is collapsed).
    const normalizedDesignText = designText.replace(/\s+/g, " ");
    expect(normalizedDesignText).toContain("resolution (a): the rule applies uniformly to every");
    expect(normalizedDesignText).toContain("No column is added to `events`");
  });

  it("static: schema.ts's events table definition carries no eligibility/returning-flag column", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const schemaPath = join(repoRoot, "apps", "bot", "src", "db", "schema.ts");
    const schemaText = readFileSync(schemaPath, "utf8");
    const startIdx = schemaText.indexOf('export const events = pgTable("events"');
    expect(startIdx).toBeGreaterThan(-1);
    const nextExportIdx = schemaText.indexOf("\nexport const", startIdx + 1);
    const eventsBlock = nextExportIdx > -1 ? schemaText.slice(startIdx, nextExportIdx) : schemaText.slice(startIdx);
    expect(eventsBlock).not.toMatch(/returning|eligib|pastAttendee|invite_eligibility/i);
  });
});

// ---------------------------------------------------------------------------
// AC10 -- no wishlist table, migration, or row (same static shape
// registrationApproval.db.test.ts's REQ-035 AC3 case already established).
// ---------------------------------------------------------------------------
describe("AC10 -- zero Wishlist entity anywhere in schema or migrations", () => {
  it("schema.ts and every migration file contain no 'wishlist' table/column/reference", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const schemaPath = join(repoRoot, "apps", "bot", "src", "db", "schema.ts");
    const schemaText = readFileSync(schemaPath, "utf8");
    expect(schemaText.toLowerCase()).not.toContain("wishlist");

    const migrationsDir = join(repoRoot, "apps", "bot", "drizzle");
    const migrationFiles = readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql"));
    expect(migrationFiles.length).toBeGreaterThan(0);
    for (const file of migrationFiles) {
      const text = readFileSync(join(migrationsDir, file), "utf8");
      expect(text.toLowerCase(), `migration ${file} must not mention wishlist`).not.toContain("wishlist");
    }
  });
});

// ---------------------------------------------------------------------------
// AC11 -- exactly one audit_log row per SUCCESSFUL redemption; zero on a
// refusal.
// ---------------------------------------------------------------------------
describe("AC11 -- exactly one audit_log row per successful redemption, zero on refusal", () => {
  it("a successful (admitted) redemption writes exactly one audit_log row, action registration.admit, payload carries inviteCodeId", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10, true, false);
    const organizer = await seedUser();
    const issued = await issueBulkInviteCode(db, organizer.id, event.id, 5, FAR_FUTURE, new Date());
    const user = await seedUser();

    const before = await countAuditRowsByActor(user.id);
    expect(before).toBe(0); // brand-new user, no prior activity

    const outcome = await redeemInviteCode(db, user.id, issued.code, null, EVAL_TIME);
    expect(outcome.kind).toBe("admitted");

    const after = await countAuditRowsByActor(user.id);
    expect(after).toBe(before + 1);

    const rows = await db.select().from(auditLog).where(eq(auditLog.actorUserId, user.id));
    const admitRow = rows.find((r) => r.action === "registration.admit");
    expect(admitRow).toBeDefined();
    expect((admitRow!.payload as { inviteCodeId?: string } | null)?.inviteCodeId).toBe(issued.id);
  });

  it("a refused redemption (unknown code) writes zero audit_log rows", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const user = await seedUser();
    const before = await countAuditRowsByActor(user.id);
    expect(before).toBe(0);

    const outcome = await redeemInviteCode(db, user.id, "THISCODEDOESNOTEXISTEITHER0", null, EVAL_TIME);
    expect(outcome.kind).toBe("invite-code-not-found");

    expect(await countAuditRowsByActor(user.id)).toBe(before);
  });
});
