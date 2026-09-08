import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, chapters, profiles, registrations, venues } from "../db/schema.js";
import { createEvent, publishEvent } from "./event.js";
import { resolveOrCreateUser } from "./user.js";
import { registerForEvent } from "./registration.js";
import { getInviteCodeById, issueCompanionInviteCode, redeemInviteCode } from "./inviteCode.js";

// docs/agents/design/REQ-039.md -- AC1, AC2 (static), AC4 (field set, part), AC5, AC6 (part),
// AC9. Real Postgres, same infrastructure/skip discipline as
// domain/inviteCodeRedeem.db.test.ts (REQ-038).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT grants_companion_of FROM invite_codes LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[companionRedeem.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
let tgSeq = 1_061_000_000;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(chapters)
    .values({
      code: `req039-chapter-${chapterSeq}`,
      name: `REQ-039 Chapter ${chapterSeq}`,
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
    .values({ chapterId, name: "REQ-039 Venue", address: "1 Test St", capacity: 500 })
    .returning({ id: venues.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedVenue: no row returned");
  return row.id;
}

async function seedPublishedEvent(chapterId: string, capacity: number): Promise<{ id: string; title: string; organizerId: string }> {
  const venueId = await seedVenue(chapterId);
  const organizer = await seedUser();
  const title = `REQ-039 Event ${capacity}-${Date.now()}-${Math.random()}`;
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
      requiresApproval: false,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, title, new Date());
  return { id: eventId, title, organizerId: organizer.id };
}

const EVAL_TIME = new Date("2026-09-01T00:00:00Z");
const FAR_FUTURE = new Date("2027-01-01T00:00:00Z");

async function registrationRow(eventId: string, userId: string) {
  const rows = await db
    .select()
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)));
  return rows[0] ?? null;
}

async function registrationCount(eventId: string, userId: string): Promise<number> {
  const rows = await db
    .select({ id: registrations.id })
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)));
  return rows.length;
}

async function profileRow(userId: string) {
  const rows = await db.select().from(profiles).where(eq(profiles.userId, userId));
  return rows[0] ?? null;
}

async function profileCount(userId: string): Promise<number> {
  const rows = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId));
  return rows.length;
}

async function countAuditRowsByActor(actorUserId: string): Promise<number> {
  const rows = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.actorUserId, actorUserId));
  return rows.length;
}

// ---------------------------------------------------------------------------
// AC1 -- a guest redeeming a companion code whose grants_companion_of is host
// H gets a registration with invited_by_user_id = H, invite_code_id = the
// code. AC4 (part) -- the Profile row written carries exactly name/company/
// phone, nothing else (no experience-level/student-flag/links/email).
// ---------------------------------------------------------------------------
describe("AC1 -- companion redemption sets invited_by_user_id = host's id, invite_code_id = the code", () => {
  it("redeemInviteCode with companionProfile set -> admitted; registration.invitedByUserId === host.id; registration.inviteCodeId === issued.id; Profile row carries exactly name/company/phone", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const organizer = await seedUser();
    const host = await seedUser();
    const guest = await seedUser();
    const issued = await issueCompanionInviteCode(db, organizer.id, event.id, host.id, FAR_FUTURE, new Date());

    const outcome = await redeemInviteCode(db, guest.id, issued.code, null, EVAL_TIME, {
      name: "Guest Full Name",
      company: "Acme Corp",
      phone: "+998901234567",
    });
    expect(outcome.kind).toBe("admitted");

    const row = await registrationRow(event.id, guest.id);
    expect(row?.invitedByUserId).toBe(host.id);
    expect(row?.inviteCodeId).toBe(issued.id);

    // AC4 (part): exactly name/company/phone were written, nothing else.
    const profile = await profileRow(guest.id);
    expect(profile?.firstName).toBe("Guest Full Name");
    expect(profile?.company).toBe("Acme Corp");
    expect(profile?.phone).toBe("+998901234567");
    expect(profile?.email).toBeNull();
    expect(profile?.position).toBeNull();
    expect(profile?.isStudent).toBeNull();
    expect(profile?.experienceLevel).toBeNull();
    expect(profile?.linksGithub).toBeNull();
    expect(profile?.linksLinkedin).toBeNull();
    expect(profile?.linksSite).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC2 -- static: invited_by_user_id is the only attribution mechanism. No
// companion-specific column beyond the pre-existing grants_companion_of, no
// referral table, no second attribution field, no migration adds another.
// ---------------------------------------------------------------------------
describe("AC2 -- no second attribution mechanism anywhere in schema.ts or the migrations", () => {
  it("schema.ts's only companion/referral-named COLUMN DEFINITION is the pre-existing grants_companion_of", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const schemaPath = join(repoRoot, "apps", "bot", "src", "db", "schema.ts");
    const schemaText = readFileSync(schemaPath, "utf8");
    // Restrict to actual column-definition lines (drizzle's `name: type(...)`
    // shape) so this does not false-positive on prose comments that merely
    // mention "companion" (e.g. this file's own header comments).
    const columnDefLines = schemaText
      .split("\n")
      .filter((line) => /^\s*\w+:\s*(uuid|text|boolean|integer|timestamp|jsonb|bigint)\(/.test(line));
    const companionOrReferralLines = columnDefLines.filter((line) => /companion|referral/i.test(line));
    expect(companionOrReferralLines.length).toBe(1);
    expect(companionOrReferralLines[0]).toContain("grants_companion_of");
  });

  it("no migration file newer than the pre-existing REQ-037 migration mentions companion/referral; no migration mentions referral at all", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const migrationsDir = join(repoRoot, "apps", "bot", "drizzle");
    const migrationFiles = readdirSync(migrationsDir).filter((f: string) => f.endsWith(".sql")).sort();
    expect(migrationFiles.length).toBeGreaterThan(0);

    const referralHits: string[] = [];
    const companionHits: string[] = [];
    for (const file of migrationFiles) {
      const text = readFileSync(join(migrationsDir, file), "utf8").toLowerCase();
      if (text.includes("referral")) referralHits.push(file);
      if (text.includes("companion")) companionHits.push(file);
    }
    expect(referralHits).toEqual([]);
    // Exactly the pre-existing REQ-037 migration that introduced
    // grants_companion_of -- no NEW migration for this requirement.
    expect(companionHits).toEqual(["0007_sturdy_network.sql"]);
  });
});

// ---------------------------------------------------------------------------
// AC5 -- a companion redeeming against a FULL event is waitlisted, not
// admitted, and not given a seat outside capacity.
// ---------------------------------------------------------------------------
describe("AC5 -- companion redemption against a full event is waitlisted, not admitted", () => {
  it("capacity 1, already filled by a plain registration; companion redemption waitlists", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 1); // capacity 1
    const filler = await seedUser();
    const fillerOutcome = await registerForEvent(db, filler.id, event.id, EVAL_TIME);
    expect(fillerOutcome.kind).toBe("admitted"); // the only seat is now taken

    const organizer = await seedUser();
    const host = await seedUser();
    const guest = await seedUser();
    const issued = await issueCompanionInviteCode(db, organizer.id, event.id, host.id, FAR_FUTURE, new Date());

    const outcome = await redeemInviteCode(db, guest.id, issued.code, null, EVAL_TIME, {
      name: "Waitlisted Guest",
      company: "",
      phone: "+998901111111",
    });
    expect(outcome.kind).toBe("waitlisted");

    const row = await registrationRow(event.id, guest.id);
    expect(row?.admission).toBe("waitlisted");
    expect(row?.invitedByUserId).toBe(host.id); // attribution still holds even when waitlisted
  });
});

// ---------------------------------------------------------------------------
// AC6 (part) -- a second person attempting to redeem a single-use companion
// code (max_uses defaults to 1, REQ-037's issueCompanionInviteCode) is
// refused and no registration is created. Domain-level shape; File 2's own
// AC6 exercises the full handler flow through both guests' conversations.
// ---------------------------------------------------------------------------
describe("AC6 -- single-use companion code: second redemption attempt is refused, no registration created", () => {
  it("guestA redeems successfully (used_count -> 1); guestB's attempt on the same code -> invite-code-spent, zero registration and zero profile for guestB", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const organizer = await seedUser();
    const host = await seedUser();
    const guestA = await seedUser();
    const guestB = await seedUser();
    const issued = await issueCompanionInviteCode(db, organizer.id, event.id, host.id, FAR_FUTURE, new Date());
    expect(issued).toBeDefined();
    const issuedRow = await getInviteCodeById(db, issued.id);
    expect(issuedRow?.maxUses).toBe(1); // the default this AC relies on

    const outcomeA = await redeemInviteCode(db, guestA.id, issued.code, null, EVAL_TIME, {
      name: "Guest A",
      company: "A Co",
      phone: "+998900000001",
    });
    expect(outcomeA.kind).toBe("admitted");
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(1);

    const outcomeB = await redeemInviteCode(db, guestB.id, issued.code, null, EVAL_TIME, {
      name: "Guest B",
      company: "B Co",
      phone: "+998900000002",
    });
    expect(outcomeB.kind).toBe("invite-code-spent");
    expect(await registrationCount(event.id, guestB.id)).toBe(0);
    expect(await profileCount(guestB.id)).toBe(0); // refusal returns before the Profile insert
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(1); // unchanged, not incremented
  });
});

// ---------------------------------------------------------------------------
// AC9 -- exactly one audit_log row per successful companion registration,
// counted before/after; zero on a refusal.
// ---------------------------------------------------------------------------
describe("AC9 -- exactly one audit_log row per successful companion registration", () => {
  it("a successful companion redemption writes exactly one audit_log row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const organizer = await seedUser();
    const host = await seedUser();
    const guest = await seedUser();
    const issued = await issueCompanionInviteCode(db, organizer.id, event.id, host.id, FAR_FUTURE, new Date());

    const before = await countAuditRowsByActor(guest.id);
    expect(before).toBe(0);

    const outcome = await redeemInviteCode(db, guest.id, issued.code, null, EVAL_TIME, {
      name: "Audited Guest",
      company: "",
      phone: "+998900000003",
    });
    expect(outcome.kind).toBe("admitted");

    const after = await countAuditRowsByActor(guest.id);
    expect(after).toBe(before + 1);
  });

  it("a refused companion redemption (spent code) writes zero audit_log rows for the refused guest", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const organizer = await seedUser();
    const host = await seedUser();
    const guestA = await seedUser();
    const guestB = await seedUser();
    const issued = await issueCompanionInviteCode(db, organizer.id, event.id, host.id, FAR_FUTURE, new Date());
    await redeemInviteCode(db, guestA.id, issued.code, null, EVAL_TIME, { name: "A", company: "", phone: "+998900000004" });

    const before = await countAuditRowsByActor(guestB.id);
    expect(before).toBe(0);
    const outcomeB = await redeemInviteCode(db, guestB.id, issued.code, null, EVAL_TIME, {
      name: "B",
      company: "",
      phone: "+998900000005",
    });
    expect(outcomeB.kind).toBe("invite-code-spent");
    expect(await countAuditRowsByActor(guestB.id)).toBe(before);
  });
});
