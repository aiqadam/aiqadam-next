import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, chapters, inviteListEntries, registrations, users, venues } from "../db/schema.js";
import { createEvent, publishEvent } from "./event.js";
import { resolveOrCreateUser } from "./user.js";
import { registerForEvent } from "./registration.js";
import { getInviteCodeById, issuePersonalInviteCode } from "./inviteCode.js";
import {
  addInviteListEntry,
  getEventIdForInviteListEntry,
  getInviteListEntryById,
  issueInviteListEntryCode,
  listInviteListEntries,
  markInviteListEntryOpened,
  removeInviteListEntry,
  resolvePersonalCodeIdentity,
} from "./inviteList.js";

// docs/agents/design/REQ-040.md / REQ-040-schema.md -- domain-layer coverage:
// AC1, AC2, AC3 (status derivation), AC4, AC5 (static), AC6, AC7 (including
// REQ-040-schema.md §4's uniqueness-conflict relink scenario), AC8 (S3-safe
// select clause), AC9 (static), AC10 (static), AC11 (audit rows). Real
// Postgres, same infrastructure/skip discipline as
// domain/companionRedeem.db.test.ts (REQ-039).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT opened_at FROM invite_list_entries LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[inviteList.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
    "TRUNCATE notification_ledger, audit_log, invite_list_entries, invite_codes, registrations, events, venues, profiles, users, chapters CASCADE",
  );
});

let chapterSeq = 0;
let tgSeq = 1_063_000_000;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(chapters)
    .values({
      code: `req040-chapter-${chapterSeq}`,
      name: `REQ-040 Chapter ${chapterSeq}`,
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
    .values({ chapterId, name: "REQ-040 Venue", address: "1 Test St", capacity: 500 })
    .returning({ id: venues.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedVenue: no row returned");
  return row.id;
}

async function seedPublishedEvent(
  chapterId: string,
  opts: { requiresInvite?: boolean } = {},
): Promise<{ id: string; title: string; organizerId: string }> {
  const venueId = await seedVenue(chapterId);
  const organizer = await seedUser();
  const title = `REQ-040 Event ${Date.now()}-${Math.random()}`;
  const eventId = await createEvent(
    db,
    organizer.id,
    chapterId,
    {
      title,
      description: "A test event",
      format: "meetup",
      venueId,
      startsAt: new Date("2026-11-01T18:00:00Z"),
      endsAt: new Date("2026-11-01T20:00:00Z"),
      registrationClosesAt: null,
      capacity: 500,
      requiresInvite: opts.requiresInvite ?? false,
      requiresApproval: false,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, title, new Date());
  return { id: eventId, title, organizerId: organizer.id };
}

const AT = new Date("2026-09-01T00:00:00Z");
const FAR_FUTURE = new Date("2027-01-01T00:00:00Z");

async function entryRow(entryId: string) {
  const rows = await db.select().from(inviteListEntries).where(eq(inviteListEntries.id, entryId));
  return rows[0] ?? null;
}

async function userRow(userId: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId));
  return rows[0] ?? null;
}

async function usersCount(): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

async function entriesForUser(userId: string) {
  return db.select().from(inviteListEntries).where(eq(inviteListEntries.userId, userId));
}

async function countAuditRowsByEntity(entityId: string): Promise<number> {
  const rows = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, entityId));
  return rows.length;
}

async function countAuditRowsByAction(action: string): Promise<number> {
  const rows = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, action));
  return rows.length;
}

// ---------------------------------------------------------------------------
// AC1 -- a named guest who has never used the bot: exactly one users row,
// tg_id NULL, and a personal code can then be issued through REQ-037's own
// issuePersonalInviteCode, composed unchanged via issueInviteListEntryCode.
// ---------------------------------------------------------------------------
describe("AC1 -- adding a never-seen guest creates one tg_id-NULL users row; a personal code is then issuable through it", () => {
  it("createNamedGuestUser + addInviteListEntry -> one users row (tg_id NULL); issueInviteListEntryCode composes issuePersonalInviteCode unchanged", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();
    const before = await usersCount();

    const added = await addInviteListEntry(db, organizer.id, event.id, "Uzcard VIP", "Uzcard", "CEO", AT);
    expect(await usersCount()).toBe(before + 1);

    const guest = await userRow(added.userId);
    expect(guest).not.toBeNull();
    expect(guest?.tgId).toBeNull();

    const entry = await entryRow(added.entryId);
    expect(entry?.userId).toBe(added.userId);
    expect(entry?.inviteCodeId).toBeNull(); // issuing is a separate step (§3.1)

    const issued = await issueInviteListEntryCode(db, organizer.id, event.id, added.entryId, added.userId, FAR_FUTURE, AT);
    const codeRow = await getInviteCodeById(db, issued.id);
    expect(codeRow?.issuedToUserId).toBe(added.userId);
    expect(codeRow?.maxUses).toBe(1);

    const entryAfterIssue = await entryRow(added.entryId);
    expect(entryAfterIssue?.inviteCodeId).toBe(issued.id);
  });
});

// ---------------------------------------------------------------------------
// AC2 -- two different never-seen guests both succeed, each tg_id NULL, no
// collision under the unique index on users.tg_id (REQ-010's own proven
// multi-NULL property, reused unchanged).
// ---------------------------------------------------------------------------
describe("AC2 -- two never-seen guests both succeed, both tg_id NULL, no unique-index collision", () => {
  it("adding guest A then guest B: both succeed, both users rows tg_id NULL, both entries exist", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();

    const a = await addInviteListEntry(db, organizer.id, event.id, "Guest A", "", "", AT);
    const b = await addInviteListEntry(db, organizer.id, event.id, "Guest B", "", "", AT);

    expect(a.userId).not.toBe(b.userId);
    const userA = await userRow(a.userId);
    const userB = await userRow(b.userId);
    expect(userA?.tgId).toBeNull();
    expect(userB?.tgId).toBeNull();

    const items = await listInviteListEntries(db, event.id);
    expect(items.map((i) => i.entryId).sort()).toEqual([a.entryId, b.entryId].sort());
  });
});

// ---------------------------------------------------------------------------
// AC3 -- the list renders each entry's outreach status across all four
// values: invited, opened, registered, attended.
// ---------------------------------------------------------------------------
describe("AC3 -- all four outreach statuses render correctly", () => {
  it("four entries constructed in the four states each render their correct status", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();

    const invitedOnly = await addInviteListEntry(db, organizer.id, event.id, "Invited Only", "", "", AT);

    const openedEntry = await addInviteListEntry(db, organizer.id, event.id, "Opened Guest", "", "", AT);
    const openedIssued = await issueInviteListEntryCode(
      db,
      organizer.id,
      event.id,
      openedEntry.entryId,
      openedEntry.userId,
      FAR_FUTURE,
      AT,
    );
    await markInviteListEntryOpened(db, openedIssued.id, AT);

    const registeredEntry = await addInviteListEntry(db, organizer.id, event.id, "Registered Guest", "", "", AT);
    const registeredOutcome = await registerForEvent(db, registeredEntry.userId, event.id, AT);
    expect(registeredOutcome.kind).toBe("admitted");

    const attendedEntry = await addInviteListEntry(db, organizer.id, event.id, "Attended Guest", "", "", AT);
    await registerForEvent(db, attendedEntry.userId, event.id, AT);
    await db
      .update(registrations)
      .set({ checkedInAt: AT })
      .where(and(eq(registrations.userId, attendedEntry.userId), eq(registrations.eventId, event.id)));

    const items = await listInviteListEntries(db, event.id);
    const byEntryId = new Map(items.map((i) => [i.entryId, i]));

    expect(byEntryId.get(invitedOnly.entryId)?.status).toBe("invited");
    expect(byEntryId.get(openedEntry.entryId)?.status).toBe("opened");
    expect(byEntryId.get(registeredEntry.entryId)?.status).toBe("registered");
    expect(byEntryId.get(attendedEntry.entryId)?.status).toBe("attended");
  });
});

// ---------------------------------------------------------------------------
// AC4 -- registered/attended are DERIVED, never stored: flipping a
// registration's admission and separately setting checked_in_at directly in
// the database changes the rendered status with NO write to the list-entry
// row (compared by that row's updated_at before/after).
// ---------------------------------------------------------------------------
describe("AC4 -- registered/attended are derived, no write to the invite_list_entries row", () => {
  it("registering, then checking in, changes the rendered status but never touches the entry's updated_at", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();

    const entry = await addInviteListEntry(db, organizer.id, event.id, "Derived Status Guest", "", "", AT);
    const beforeRow = await entryRow(entry.entryId);
    expect(beforeRow).not.toBeNull();

    let items = await listInviteListEntries(db, event.id);
    expect(items.find((i) => i.entryId === entry.entryId)?.status).toBe("invited");

    await registerForEvent(db, entry.userId, event.id, AT);
    items = await listInviteListEntries(db, event.id);
    expect(items.find((i) => i.entryId === entry.entryId)?.status).toBe("registered");

    const afterRegisterRow = await entryRow(entry.entryId);
    expect(afterRegisterRow?.updatedAt.getTime()).toBe(beforeRow!.updatedAt.getTime());

    await db
      .update(registrations)
      .set({ checkedInAt: AT })
      .where(and(eq(registrations.userId, entry.userId), eq(registrations.eventId, event.id)));
    items = await listInviteListEntries(db, event.id);
    expect(items.find((i) => i.entryId === entry.entryId)?.status).toBe("attended");

    const afterCheckinRow = await entryRow(entry.entryId);
    expect(afterCheckinRow?.updatedAt.getTime()).toBe(beforeRow!.updatedAt.getTime());
  });
});

// ---------------------------------------------------------------------------
// AC5 -- static: no column, cache or persisted field holds a registered or
// attended status for a list entry; only opened_at is the stored, justified
// exception (REQ-040.md §3.2/§7).
// ---------------------------------------------------------------------------
describe("AC5 -- static: no stored registered/attended field anywhere in invite_list_entries", () => {
  it("schema.ts's invite_list_entries table definition has no column named/related to registered or attended", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const schemaPath = join(repoRoot, "apps", "bot", "src", "db", "schema.ts");
    const text = readFileSync(schemaPath, "utf8").replace(/\r\n/g, "\n");
    const startIdx = text.indexOf("export const inviteListEntries = pgTable(");
    expect(startIdx, "invite_list_entries table definition not found").toBeGreaterThan(-1);
    const endIdx = text.indexOf("\n);", startIdx);
    const tableBlock = text.slice(startIdx, endIdx);
    expect(tableBlock).not.toMatch(/\bregistered\b/i);
    expect(tableBlock).not.toMatch(/\battended\b/i);
    // opened_at IS the one justified stored exception -- present, not absent.
    expect(tableBlock).toMatch(/opened_at/);
  });

  it("domain/inviteList.ts's listInviteListEntries query issues no UPDATE against invite_list_entries", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const filePath = join(repoRoot, "apps", "bot", "src", "domain", "inviteList.ts");
    const text = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");
    const fnStart = text.indexOf("export async function listInviteListEntries");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = text.indexOf("\n// ---", fnStart + 1);
    const fnBody = text.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
    expect(fnBody).not.toMatch(/\.update\(/);
  });

  // Widened per TEST-DESIGN-VALIDATOR step-03b BLOCKER (rework 1): AC5's
  // verification method in requirements.yaml is `git grep` over apps/bot as
  // a whole, and this requirement's own diff adds resolvePersonalCodeIdentity
  // and markInviteListEntryOpened calls to handlers/start.ts -- new code the
  // two checks above never read. This check scopes to exactly the two new
  // call sites REQ-040 added there (not the whole file, which also contains
  // unrelated, pre-existing REQ-039 code) so a stray persisted
  // registered/attended field slipped into either new call site would be
  // caught, without false-flagging unrelated code.
  it("handlers/start.ts's new resolvePersonalCodeIdentity/markInviteListEntryOpened call sites hold no registered/attended field", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const filePath = join(repoRoot, "apps", "bot", "src", "handlers", "start.ts");
    const text = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");

    const identityStart = text.indexOf("const identity = await resolvePersonalCodeIdentity(");
    expect(identityStart, "resolvePersonalCodeIdentity call site not found in handlers/start.ts").toBeGreaterThan(-1);
    const identityEnd = text.indexOf("if (identityResolvedUserId === null) {", identityStart);
    expect(identityEnd).toBeGreaterThan(identityStart);
    const identityBlock = text.slice(identityStart, identityEnd);
    expect(identityBlock).not.toMatch(/\bregistered\b/i);
    expect(identityBlock).not.toMatch(/\battended\b/i);

    const openedStart = text.indexOf("REQ-040.md §3.2 -- the first-open-only write");
    expect(openedStart, "markInviteListEntryOpened call site comment not found in handlers/start.ts").toBeGreaterThan(-1);
    const openedEnd = text.indexOf("const isCompanionCode = codeRow !== null", openedStart);
    expect(openedEnd).toBeGreaterThan(openedStart);
    const openedBlock = text.slice(openedStart, openedEnd);
    expect(openedBlock).not.toMatch(/\bregistered\b/i);
    expect(openedBlock).not.toMatch(/\battended\b/i);
  });
});

// ---------------------------------------------------------------------------
// AC6 -- redemption LINKS the pre-created row: tg_id becomes non-null, id
// unchanged, no second users row. A run with no pre-created row does not
// exercise this and is not evidence -- this case always constructs one
// first.
// ---------------------------------------------------------------------------
describe("AC6 -- resolvePersonalCodeIdentity 'linked' branch: link, don't create", () => {
  it("normal case: no row holds the caller's tg_id yet -> pre-created row A is UPDATEd, id unchanged, no second users row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();

    const entry = await addInviteListEntry(db, organizer.id, event.id, "VIP Guest", "SAP", "", AT);
    const issued = await issuePersonalInviteCode(db, organizer.id, event.id, entry.userId, FAR_FUTURE, AT);

    const beforeCount = await usersCount();
    tgSeq += 1;
    const callerTgId = BigInt(tgSeq);

    const result = await resolvePersonalCodeIdentity(db, issued.code, callerTgId, "vip_guest", "en", AT);
    expect(result.kind).toBe("linked");
    expect(result.kind === "linked" ? result.userId : null).toBe(entry.userId);

    const guestRow = await userRow(entry.userId);
    expect(guestRow?.id).toBe(entry.userId); // id unchanged -- an UPDATE, never a second INSERT
    expect(guestRow?.tgId).toBe(callerTgId);
    expect(guestRow?.tgUsername).toBe("vip_guest");
    expect(await usersCount()).toBe(beforeCount); // no second users row created
  });

  it("not-found: an unknown code returns not-applicable", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    tgSeq += 1;
    const result = await resolvePersonalCodeIdentity(db, "NOSUCHCODE", BigInt(tgSeq), null, "en", AT);
    expect(result.kind).toBe("not-applicable");
  });

  it("bulk/companion code (issuedToUserId NULL) is not-applicable", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();
    const bulk = await import("./inviteCode.js").then((m) => m.issueBulkInviteCode(db, organizer.id, event.id, 5, FAR_FUTURE, AT));

    tgSeq += 1;
    const result = await resolvePersonalCodeIdentity(db, bulk.code, BigInt(tgSeq), null, "en", AT);
    expect(result.kind).toBe("not-applicable");
  });

  it("target-already-linked: a personal code whose target already has a non-null tg_id is not-applicable (falls through to ordinary resolveOrCreateUser + existing not-yours refusal)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();
    const target = await seedUser(); // already has a tg_id -- REQ-037's ordinary case
    const issued = await issuePersonalInviteCode(db, organizer.id, event.id, target.id, FAR_FUTURE, AT);

    tgSeq += 1;
    const result = await resolvePersonalCodeIdentity(db, issued.code, BigInt(tgSeq), null, "en", AT);
    expect(result.kind).toBe("not-applicable");
  });

  it("own-row-null-tg-id, second tap with the same caller tg_id is idempotent (concurrency fallback re-read)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();
    const entry = await addInviteListEntry(db, organizer.id, event.id, "Idempotent Guest", "", "", AT);
    const issued = await issuePersonalInviteCode(db, organizer.id, event.id, entry.userId, FAR_FUTURE, AT);

    tgSeq += 1;
    const callerTgId = BigInt(tgSeq);
    const first = await resolvePersonalCodeIdentity(db, issued.code, callerTgId, "u1", "en", AT);
    expect(first.kind).toBe("linked");

    // Second tap: A.tgId is now callerTgId (non-null) -> rule table row 3
    // applies (target already linked) -- not-applicable, correctly, since
    // the caller's own row now resolves via the ordinary tg_id-keyed path.
    const second = await resolvePersonalCodeIdentity(db, issued.code, callerTgId, "u1", "en", AT);
    expect(second.kind).toBe("not-applicable");
  });
});

// ---------------------------------------------------------------------------
// AC7 -- the redeemer ALREADY has their own users row: handled exactly as
// the design states (relink, never a merge, never a refusal) -- no two live
// users rows for one person with no stated resolution.
// ---------------------------------------------------------------------------
describe("AC7 -- resolvePersonalCodeIdentity 'collision-relinked' branch: relink, never merge, never refuse", () => {
  it("plain collision: A's single list entry is repointed to B; invite_codes.issued_to_user_id repointed; A left inert (tg_id still NULL, row not deleted); one entry_relinked audit row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();
    const b = await seedUser(); // B -- the redeemer's own, separate, pre-existing account

    const entryA = await addInviteListEntry(db, organizer.id, event.id, "Collision Guest", "", "", AT);
    const issued = await issuePersonalInviteCode(db, organizer.id, event.id, entryA.userId, FAR_FUTURE, AT);

    const result = await resolvePersonalCodeIdentity(db, issued.code, BigInt(b.tgId), `u${b.tgId}`, "en", AT);
    expect(result.kind).toBe("collision-relinked");
    expect(result.kind === "collision-relinked" ? result.userId : null).toBe(b.id);

    // A is left inert: still present, tg_id still NULL, never deleted.
    const aRow = await userRow(entryA.userId);
    expect(aRow).not.toBeNull();
    expect(aRow?.tgId).toBeNull();

    // A's entry is now B's, not deleted (no conflict existed for this event).
    const aEntries = await entriesForUser(entryA.userId);
    expect(aEntries).toHaveLength(0);
    const bEntries = await entriesForUser(b.id);
    expect(bEntries).toHaveLength(1);
    expect(bEntries[0]?.id).toBe(entryA.entryId);

    // The outstanding personal invite code is repointed to B.
    const codeAfter = await getInviteCodeById(db, issued.id);
    expect(codeAfter?.issuedToUserId).toBe(b.id);

    // Exactly one entry_relinked audit row for the one entry A held.
    expect(await countAuditRowsByEntity(entryA.entryId)).toBeGreaterThanOrEqual(1);
    const relinkRows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, entryA.entryId), eq(auditLog.action, "invite_list.entry_relinked")));
    expect(relinkRows).toHaveLength(1);
  });

  it("multi-event collision, no uniqueness conflict: ALL of A's entries across every event are repointed to B, not just the redeemed event's", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event1 = await seedPublishedEvent(chapterId);
    const event2 = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();
    const b = await seedUser();

    const entryA1 = await addInviteListEntry(db, organizer.id, event1.id, "Multi-Event Guest", "", "", AT);
    // A is separately listed for event2 too (the same pre-created row, per
    // REQ-040.md §2.4 point 2's scoping to ALL of A's events).
    await db.insert(inviteListEntries).values({
      eventId: event2.id,
      userId: entryA1.userId,
      addedBy: organizer.id,
      inviteCodeId: null,
      openedAt: null,
      name: "Multi-Event Guest",
      company: null,
      position: null,
    });

    const issued = await issuePersonalInviteCode(db, organizer.id, event1.id, entryA1.userId, FAR_FUTURE, AT);
    const result = await resolvePersonalCodeIdentity(db, issued.code, BigInt(b.tgId), `u${b.tgId}`, "en", AT);
    expect(result.kind).toBe("collision-relinked");

    const aEntries = await entriesForUser(entryA1.userId);
    expect(aEntries).toHaveLength(0); // zero entries left anywhere for A
    const bEntries = await entriesForUser(b.id);
    expect(bEntries.map((e) => e.eventId).sort()).toEqual([event1.id, event2.id].sort());
  });

  it("uniqueness-conflict scenario (REQ-040-schema.md §4): B already has an entry for one of A's events -- that entry is left untouched, A's conflicting entry is deleted (not merged), exactly one audit row per entry A originally held", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const e1 = await seedPublishedEvent(chapterId); // the event being redeemed
    const e2 = await seedPublishedEvent(chapterId); // an event where B is already, separately, listed
    const organizer = await seedUser();
    const b = await seedUser();

    const entryA_e1 = await addInviteListEntry(db, organizer.id, e1.id, "Conflict Guest A", "", "", AT);
    // A also has an entry for e2 (same pre-created row).
    const aE2Rows = await db
      .insert(inviteListEntries)
      .values({
        eventId: e2.id,
        userId: entryA_e1.userId,
        addedBy: organizer.id,
        inviteCodeId: null,
        openedAt: null,
        name: "Conflict Guest A",
        company: null,
        position: null,
      })
      .returning({ id: inviteListEntries.id });
    const entryA_e2Id = aE2Rows[0]!.id;

    // B is independently, already listed for e2 under their own real
    // identity -- this is the row that must be preserved, not overwritten.
    const bE2Rows = await db
      .insert(inviteListEntries)
      .values({
        eventId: e2.id,
        userId: b.id,
        addedBy: organizer.id,
        inviteCodeId: null,
        openedAt: null,
        name: "B Under Own Identity",
        company: "B's Real Company",
        position: null,
      })
      .returning({ id: inviteListEntries.id });
    const entryB_e2Id = bE2Rows[0]!.id;

    const issued = await issuePersonalInviteCode(db, organizer.id, e1.id, entryA_e1.userId, FAR_FUTURE, AT);
    const result = await resolvePersonalCodeIdentity(db, issued.code, BigInt(b.tgId), `u${b.tgId}`, "en", AT);
    expect(result.kind).toBe("collision-relinked");

    // Final state: A holds zero entries anywhere.
    const aEntries = await entriesForUser(entryA_e1.userId);
    expect(aEntries).toHaveLength(0);

    // B holds exactly one entry per event: e1 (repointed from A) and e2
    // (B's own pre-existing row, untouched -- never overwritten with A's
    // data).
    const bEntries = await entriesForUser(b.id);
    expect(bEntries).toHaveLength(2);
    const bE1Entry = bEntries.find((e) => e.eventId === e1.id);
    const bE2Entry = bEntries.find((e) => e.eventId === e2.id);
    expect(bE1Entry?.id).toBe(entryA_e1.entryId); // e1: the repointed row (A's original entry id)
    expect(bE2Entry?.id).toBe(entryB_e2Id); // e2: B's OWN pre-existing row survives unchanged
    expect(bE2Entry?.name).toBe("B Under Own Identity"); // not overwritten with A's data
    expect(bE2Entry?.company).toBe("B's Real Company");

    // A's conflicting e2 entry was deleted, not merged.
    const deletedRow = await entryRow(entryA_e2Id);
    expect(deletedRow).toBeNull();

    // One audit row per entry A originally held (2 entries: e1's UPDATE, e2's DELETE).
    const relinkRows = await db.select().from(auditLog).where(eq(auditLog.action, "invite_list.entry_relinked"));
    expect(relinkRows).toHaveLength(2);
    const relinkedEntryIds = relinkRows.map((r) => r.entityId).sort();
    expect(relinkedEntryIds).toEqual([entryA_e1.entryId, entryA_e2Id].sort());
  });
});

// ---------------------------------------------------------------------------
// AC8 -- the rendered list contains no phone number and no email address for
// any entry, even when the underlying users have both stored on a `profiles`
// row.
// ---------------------------------------------------------------------------
describe("AC8 -- listInviteListEntries never surfaces phone or email", () => {
  it("an entry whose linked user has a profiles row with both phone and email set: neither value appears anywhere in the rendered view", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();
    const guest = await seedUser();
    const phone = "+998901112233";
    const email = "guest@example.com";
    await db.insert(schema.profiles).values({
      userId: guest.id,
      firstName: "Profiled Guest",
      company: "Real Co",
      phone,
      email,
    });
    // Add guest.id directly onto the list (simulating a resolved/linked
    // entry) to exercise the profiles-joined path.
    const entryRows = await db
      .insert(inviteListEntries)
      .values({
        eventId: event.id,
        userId: guest.id,
        addedBy: organizer.id,
        inviteCodeId: null,
        openedAt: null,
        name: "Snapshot Name",
        company: "Snapshot Co",
        position: null,
      })
      .returning({ id: inviteListEntries.id });
    expect(entryRows).toHaveLength(1);

    const items = await listInviteListEntries(db, event.id);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain(phone);
    expect(serialized).not.toContain(email);
    // Display-precedence: profiles data wins once it exists (§4.2).
    expect(items[0]?.name).toBe("Profiled Guest");
    expect(items[0]?.company).toBe("Real Co");
  });
});

// ---------------------------------------------------------------------------
// AC9 -- static: no send action anywhere in the new domain/handler files.
// ---------------------------------------------------------------------------
describe("AC9 -- static: no code path sends a message to the list entry's own user", () => {
  it("domain/inviteList.ts and handlers/inviteList.ts contain no NotificationSender/ctx.reply* call targeting an entry's user_id", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const domainText = readFileSync(join(repoRoot, "apps", "bot", "src", "domain", "inviteList.ts"), "utf8");
    const handlerText = readFileSync(join(repoRoot, "apps", "bot", "src", "handlers", "inviteList.ts"), "utf8");
    // No sender import/usage at all in either file -- every reply in the
    // handler goes to ctx (the organizer's own chat), never to a
    // NotificationSender targeting the guest.
    expect(domainText).not.toMatch(/NotificationSender/);
    expect(handlerText).not.toMatch(/NotificationSender/);
    expect(handlerText).not.toMatch(/sender\./);
  });

  // Widened per TEST-DESIGN-VALIDATOR step-03b BLOCKER (rework 1): AC9's
  // verification method is `git grep` over apps/bot, and handlers/start.ts
  // is where this requirement's diff actually wires resolvePersonalCodeIdentity
  // and markInviteListEntryOpened into the live redemption path -- unread by
  // the check above. start.ts ALSO contains an unrelated, pre-existing
  // REQ-039 host-notification `sender.send(...)` call further down in the
  // same function (targeting the companion invite's host, who already has a
  // non-null tg_id, not the entry being newly linked/opened) -- so this check
  // scopes to exactly the two new call sites REQ-040 added, the same two
  // blocks the AC5 check above isolates, rather than the whole file, to
  // avoid flagging that unrelated legitimate send.
  it("handlers/start.ts's new resolvePersonalCodeIdentity/markInviteListEntryOpened call sites send nothing", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const filePath = join(repoRoot, "apps", "bot", "src", "handlers", "start.ts");
    const text = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");

    const identityStart = text.indexOf("const identity = await resolvePersonalCodeIdentity(");
    expect(identityStart, "resolvePersonalCodeIdentity call site not found in handlers/start.ts").toBeGreaterThan(-1);
    const identityEnd = text.indexOf("if (identityResolvedUserId === null) {", identityStart);
    expect(identityEnd).toBeGreaterThan(identityStart);
    const identityBlock = text.slice(identityStart, identityEnd);
    expect(identityBlock).not.toMatch(/NotificationSender/);
    expect(identityBlock).not.toMatch(/sender\./);
    expect(identityBlock).not.toMatch(/ctx\.reply/);

    const openedStart = text.indexOf("REQ-040.md §3.2 -- the first-open-only write");
    expect(openedStart, "markInviteListEntryOpened call site comment not found in handlers/start.ts").toBeGreaterThan(-1);
    const openedEnd = text.indexOf("const isCompanionCode = codeRow !== null", openedStart);
    expect(openedEnd).toBeGreaterThan(openedStart);
    const openedBlock = text.slice(openedStart, openedEnd);
    expect(openedBlock).not.toMatch(/NotificationSender/);
    expect(openedBlock).not.toMatch(/sender\./);
    expect(openedBlock).not.toMatch(/ctx\.reply/);
  });
});

// ---------------------------------------------------------------------------
// AC10 -- static: no engagement score, activity heuristic, or group-activity
// column/field anywhere.
// ---------------------------------------------------------------------------
describe("AC10 -- static: no engagement/activity-approximation field anywhere", () => {
  it("schema.ts's invite_list_entries block and domain/inviteList.ts contain no engagement/activity-named field", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const schemaText = readFileSync(join(repoRoot, "apps", "bot", "src", "db", "schema.ts"), "utf8").replace(/\r\n/g, "\n");
    const startIdx = schemaText.indexOf("export const inviteListEntries = pgTable(");
    const endIdx = schemaText.indexOf("\n);", startIdx);
    const tableBlock = schemaText.slice(startIdx, endIdx);
    expect(tableBlock).not.toMatch(/engagement|activity[_-]?score|group[_-]?activity/i);

    const domainText = readFileSync(join(repoRoot, "apps", "bot", "src", "domain", "inviteList.ts"), "utf8");
    expect(domainText).not.toMatch(/engagement|activity[_-]?score|group[_-]?activity/i);
  });

  // Widened per TEST-DESIGN-VALIDATOR step-03b BLOCKER (rework 1): AC10's
  // verification method is `git grep` over apps/bot, and handlers/start.ts
  // -- unread above -- is exactly where this requirement's diff added its
  // new call sites. Scoped identically to the AC5/AC9 widenings above (the
  // two new call-site blocks only) so unrelated pre-existing code in the
  // same file cannot produce a false flag.
  it("handlers/start.ts's new resolvePersonalCodeIdentity/markInviteListEntryOpened call sites hold no engagement/activity field", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const filePath = join(repoRoot, "apps", "bot", "src", "handlers", "start.ts");
    const text = readFileSync(filePath, "utf8").replace(/\r\n/g, "\n");

    const identityStart = text.indexOf("const identity = await resolvePersonalCodeIdentity(");
    expect(identityStart, "resolvePersonalCodeIdentity call site not found in handlers/start.ts").toBeGreaterThan(-1);
    const identityEnd = text.indexOf("if (identityResolvedUserId === null) {", identityStart);
    expect(identityEnd).toBeGreaterThan(identityStart);
    const identityBlock = text.slice(identityStart, identityEnd);
    expect(identityBlock).not.toMatch(/engagement|activity[_-]?score|group[_-]?activity/i);

    const openedStart = text.indexOf("REQ-040.md §3.2 -- the first-open-only write");
    expect(openedStart, "markInviteListEntryOpened call site comment not found in handlers/start.ts").toBeGreaterThan(-1);
    const openedEnd = text.indexOf("const isCompanionCode = codeRow !== null", openedStart);
    expect(openedEnd).toBeGreaterThan(openedStart);
    const openedBlock = text.slice(openedStart, openedEnd);
    expect(openedBlock).not.toMatch(/engagement|activity[_-]?score|group[_-]?activity/i);
  });
});

// ---------------------------------------------------------------------------
// AC11 -- adding and removing a list entry each write exactly one audit_log
// row.
// ---------------------------------------------------------------------------
describe("AC11 -- adding and removing each write exactly one audit_log row", () => {
  it("addInviteListEntry writes exactly one invite_list.add row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();

    const before = await countAuditRowsByAction("invite_list.add");
    const entry = await addInviteListEntry(db, organizer.id, event.id, "Audited Guest", "", "", AT);
    const after = await countAuditRowsByAction("invite_list.add");
    expect(after).toBe(before + 1);
    expect(await countAuditRowsByEntity(entry.entryId)).toBe(1);
  });

  it("removeInviteListEntry writes exactly one invite_list.remove row and deletes the row (hard DELETE)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();
    const entry = await addInviteListEntry(db, organizer.id, event.id, "To Remove", "", "", AT);

    const before = await countAuditRowsByAction("invite_list.remove");
    const result = await removeInviteListEntry(db, organizer.id, entry.entryId, AT);
    expect(result.kind).toBe("removed");
    const after = await countAuditRowsByAction("invite_list.remove");
    expect(after).toBe(before + 1);

    expect(await entryRow(entry.entryId)).toBeNull(); // hard delete
    expect(await getInviteListEntryById(db, entry.entryId)).toBeNull();
    // The underlying users row is never touched by removal.
    const guestStillThere = await userRow(entry.userId);
    expect(guestStillThere).not.toBeNull();
  });

  it("removeInviteListEntry on an unknown id is a no-op: not-found, zero audit rows written", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    await seedPublishedEvent(chapterId); // unused, just to exercise a populated schema
    const organizer = await seedUser();

    const before = await countAuditRowsByAction("invite_list.remove");
    const result = await removeInviteListEntry(db, organizer.id, "00000000-0000-0000-0000-000000000000", AT);
    expect(result.kind).toBe("not-found");
    expect(await countAuditRowsByAction("invite_list.remove")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// getEventIdForInviteListEntry -- read-only helper the handler's S2 re-check
// on the remove-confirm step depends on.
// ---------------------------------------------------------------------------
describe("getEventIdForInviteListEntry", () => {
  it("resolves the owning event id for an existing entry, null for an unknown one", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId);
    const organizer = await seedUser();
    const entry = await addInviteListEntry(db, organizer.id, event.id, "Lookup Guest", "", "", AT);

    expect(await getEventIdForInviteListEntry(db, entry.entryId)).toBe(event.id);
    expect(await getEventIdForInviteListEntry(db, "00000000-0000-0000-0000-000000000000")).toBeNull();
  });
});
