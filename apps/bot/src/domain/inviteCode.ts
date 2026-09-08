import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { events, inviteCodes, profiles, registrations, users } from "../db/schema.js";
import type { BotLang } from "../i18n/catalog.js";
import { getCatalog } from "../i18n/catalog.js";
import { writeAuditLog } from "./auditLog.js";
import { computeSeatsLeft, getPendingSource } from "./event.js";
import {
  clearPendingSource,
  decideRegistrationOutcome,
  deriveCheckinDisplayName,
  generateQrToken,
  resolveRegistrationSource,
  type AdmissionState,
  type RegisterForEventResult,
} from "./registration.js";

// docs/agents/design/REQ-033.md §4 — the invite code VALUE generator. Pure,
// framework-free (decisions/0004): no grammY import, no I/O beyond the CSPRNG
// call, no DbClient dependency. Scope is the code value only — no issuing or
// redemption domain logic (that is REQ-037/REQ-038/REQ-039's job). Placed
// alongside (not inside) domain/registration.ts's generateQrToken(), per the
// design's own instruction: the two outputs serve different purposes
// (qr_token is machine-scanned only, never typed; this code is
// typed-or-scanned) and stay independently named and independently callable.

// §4 "Alphabet" — 32 symbols, visually-ambiguous characters excluded: digits
// 2-9 (0/1 excluded) plus uppercase A-Z minus I and O. L and Q ARE both
// included — 32 is already an exact power of two (log2(32) = 5 bits/char), so
// no further exclusion is made (design §4's explicit resolution of the one
// rework-cycle inconsistency).
export const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

// §4 "Length and entropy" — 128-bit S4 floor / 5 bits per character = 25.6,
// rounded up to the smallest integer length that clears the floor: 26
// characters. Resulting entropy: 26 * 5 = 130 bits (>= 128, a 2-bit margin).
export const INVITE_CODE_LENGTH = 26;

// §4 "Generator shape" — one CSPRNG call (node:crypto's randomBytes, the same
// primitive generateQrToken() already uses; never Math.random, never a
// sequential id, never a hash of a user id, per S4's exact negative-case
// list), then an unbiased byte-to-symbol mapping. `byte % 32` is unbiased
// specifically because 32 evenly divides 256 (256 / 32 = 8 exactly) — every
// alphabet symbol is equally likely regardless of which byte value maps to
// it (design §4's explicit correctness note: this would NOT be safe for an
// alphabet size that does not evenly divide 256).
export function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < bytes.length; i++) {
    code += INVITE_CODE_ALPHABET[bytes[i]! % INVITE_CODE_ALPHABET.length];
  }
  return code;
}

// ---------------------------------------------------------------------------
// docs/agents/design/REQ-037.md — the issuing side of PRD FR-5. Framework-free
// (decisions/0004): no grammY import anywhere in this file. Every
// time-dependent predicate (the cancelled/finished refusal checks) is run by
// the CALLER against event.ts's own getEventById/isFinished — this file never
// reads the event's own state, it only performs the invite_codes INSERT +
// AuditLog write once the caller has already decided to proceed.
// ---------------------------------------------------------------------------

// §1.5 — shared parse/validate shape (types only, per the approved design).
export type IssueInviteCodeInput =
  | { kind: "personal"; eventId: string; targetUserId: string; expiresAt: Date | null }
  | { kind: "bulk"; eventId: string; maxUses: number; expiresAt: Date | null }
  | { kind: "companion"; eventId: string; hostUserId: string; expiresAt: Date | null };

export type IssueInviteCodeValidation =
  | { ok: true; value: IssueInviteCodeInput }
  | { ok: false; missing: string[] }; // field names, same convention as EventCreateValidation's `missing` list

// §1's first-token-plus-remainder parse, extended to a second required token
// before the optional (whitespace-joined) remainder — same shape
// parseRequestsCommandArgs (handlers/organizerRequests.ts) already
// establishes for "<event_id> [rest]", extended here per design §1.1.
function splitInviteArgs(raw: string): { eventId: string | null; second: string | null; rest: string | null } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { eventId: null, second: null, rest: null };
  }
  const tokens = trimmed.split(/\s+/);
  const eventId = tokens[0] ?? null;
  const second = tokens.length > 1 ? (tokens[1] ?? null) : null;
  const restTokens = tokens.slice(2);
  const rest = restTokens.length > 0 ? restTokens.join(" ") : null;
  return { eventId, second, rest };
}

// §1.4 — parses the optional third-token expiry override. Pushes
// "expires_at" onto `missing` when a non-empty override fails to parse as a
// date (the same "collect and report, don't half-apply" discipline
// validateEventCreateInput/validateEventUpdateInput use), and returns null
// (caller defaults to the event's startsAt) when no override was supplied.
function parseExpiresAtOverride(rest: string | null, missing: string[]): Date | null {
  if (rest === null) {
    return null;
  }
  const parsed = new Date(rest);
  if (Number.isNaN(parsed.getTime())) {
    missing.push("expires_at");
    return null;
  }
  return parsed;
}

// §1.1 — /invite_personal <event_id> <user_id> [expires_at]
export function parseInvitePersonalArgs(raw: string): IssueInviteCodeValidation {
  const { eventId, second, rest } = splitInviteArgs(raw);
  const missing: string[] = [];
  if (eventId === null) missing.push("event_id");
  if (second === null) missing.push("user_id");
  const expiresAt = parseExpiresAtOverride(rest, missing);
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    value: { kind: "personal", eventId: eventId as string, targetUserId: second as string, expiresAt },
  };
}

// §1.2 — /invite_bulk <event_id> <max_uses> [expires_at]. `max_uses`'s
// positive-integer parsing rule is reused from validateEventCreateInput's
// `capacity` field per the design's own instruction, restated as a rule, not
// copied code.
export function parseInviteBulkArgs(raw: string): IssueInviteCodeValidation {
  const { eventId, second, rest } = splitInviteArgs(raw);
  const missing: string[] = [];
  if (eventId === null) missing.push("event_id");

  let maxUses = 0;
  if (second === null) {
    missing.push("max_uses");
  } else {
    const parsed = Number(second);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      missing.push("max_uses");
    } else {
      maxUses = parsed;
    }
  }

  const expiresAt = parseExpiresAtOverride(rest, missing);
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return { ok: true, value: { kind: "bulk", eventId: eventId as string, maxUses, expiresAt } };
}

// §1.3 — /invite_companion <event_id> <host_user_id> [expires_at]
export function parseInviteCompanionArgs(raw: string): IssueInviteCodeValidation {
  const { eventId, second, rest } = splitInviteArgs(raw);
  const missing: string[] = [];
  if (eventId === null) missing.push("event_id");
  if (second === null) missing.push("host_user_id");
  const expiresAt = parseExpiresAtOverride(rest, missing);
  if (missing.length > 0) {
    return { ok: false, missing };
  }
  return {
    ok: true,
    value: { kind: "companion", eventId: eventId as string, hostUserId: second as string, expiresAt },
  };
}

// ---------------------------------------------------------------------------
// §6 — one domain function per command, each performing exactly one
// invite_codes INSERT plus exactly one writeAuditLog call inside one
// transaction, mirroring createEvent's shape (event.ts). All refusal checks
// (event-not-found, authorization, cancelled, finished, user-existence,
// argument validity) are the caller's responsibility (the handler) — these
// functions perform the write only once every check has already passed, same
// division event.ts's publishEvent/cancelEvent already use.
// ---------------------------------------------------------------------------
export interface IssuedInviteCode {
  id: string;
  code: string;
}

export async function issuePersonalInviteCode(
  db: DbClient["db"],
  actorUserId: string,
  eventId: string,
  targetUserId: string,
  expiresAt: Date,
  at: Date,
): Promise<IssuedInviteCode> {
  return db.transaction(async (tx) => {
    const code = generateInviteCode();
    const rows = await tx
      .insert(inviteCodes)
      .values({
        eventId,
        code,
        issuedToUserId: targetUserId,
        grantsCompanionOf: null,
        maxUses: 1,
        expiresAt,
      })
      .returning({ id: inviteCodes.id });

    const row = rows[0];
    if (row === undefined) {
      // Unreachable in practice: RETURNING on a successful INSERT always
      // yields exactly one row (no-speculation guard, same discipline as
      // createEvent/createVenue).
      throw new Error("issuePersonalInviteCode: insert returned no row");
    }

    await writeAuditLog(tx, {
      actorUserId,
      action: "invite_code.issue",
      entity: "invite_code",
      entityId: row.id,
      payload: {
        eventId,
        shape: "personal",
        maxUses: 1,
        issuedToUserId: targetUserId,
        grantsCompanionOf: null,
      },
      at,
    });

    return { id: row.id, code };
  });
}

export async function issueBulkInviteCode(
  db: DbClient["db"],
  actorUserId: string,
  eventId: string,
  maxUses: number,
  expiresAt: Date,
  at: Date,
): Promise<IssuedInviteCode> {
  return db.transaction(async (tx) => {
    const code = generateInviteCode();
    const rows = await tx
      .insert(inviteCodes)
      .values({
        eventId,
        code,
        issuedToUserId: null,
        grantsCompanionOf: null,
        maxUses,
        expiresAt,
      })
      .returning({ id: inviteCodes.id });

    const row = rows[0];
    if (row === undefined) {
      throw new Error("issueBulkInviteCode: insert returned no row");
    }

    await writeAuditLog(tx, {
      actorUserId,
      action: "invite_code.issue",
      entity: "invite_code",
      entityId: row.id,
      payload: {
        eventId,
        shape: "bulk",
        maxUses,
        issuedToUserId: null,
        grantsCompanionOf: null,
      },
      at,
    });

    return { id: row.id, code };
  });
}

export async function issueCompanionInviteCode(
  db: DbClient["db"],
  actorUserId: string,
  eventId: string,
  hostUserId: string,
  expiresAt: Date,
  at: Date,
): Promise<IssuedInviteCode> {
  return db.transaction(async (tx) => {
    const code = generateInviteCode();
    const rows = await tx
      .insert(inviteCodes)
      .values({
        eventId,
        code,
        issuedToUserId: null,
        grantsCompanionOf: hostUserId,
        maxUses: 1,
        expiresAt,
      })
      .returning({ id: inviteCodes.id });

    const row = rows[0];
    if (row === undefined) {
      throw new Error("issueCompanionInviteCode: insert returned no row");
    }

    await writeAuditLog(tx, {
      actorUserId,
      action: "invite_code.issue",
      entity: "invite_code",
      entityId: row.id,
      payload: {
        eventId,
        shape: "companion",
        maxUses: 1,
        issuedToUserId: null,
        grantsCompanionOf: hostUserId,
      },
      at,
    });

    return { id: row.id, code };
  });
}

// ---------------------------------------------------------------------------
// §4.3 — deriveInviteCodeShape: a pure, columnless label function, exactly
// the four-row table the design specifies (no ambiguity left to the
// implementer). Never a stored discriminator (REQ-033 §2).
// ---------------------------------------------------------------------------
export type InviteCodeShape = "personal" | "bulk" | "companion";

export function deriveInviteCodeShape(
  issuedToUserId: string | null,
  grantsCompanionOf: string | null,
  maxUses: number,
): InviteCodeShape {
  if (issuedToUserId !== null) {
    return "personal";
  }
  if (grantsCompanionOf !== null) {
    return "companion";
  }
  return maxUses > 1 ? "bulk" : "personal";
}

// ---------------------------------------------------------------------------
// §4.1/§4.2 — usage visibility: read-only queries, no write to invite_codes
// on read (AC7).
// ---------------------------------------------------------------------------
export interface InviteCodeListItem {
  inviteCodeId: string;
  code: string;
  shape: InviteCodeShape;
  usedCount: number;
  maxUses: number;
  expiresAt: Date | null;
}

// §4.1 — plain SELECT on invite_codes filtered by eventId, ordered by
// createdAt. No join, never an UPDATE — invite_codes.updated_at is untouched
// by reading this list.
export async function listInviteCodesForEvent(
  db: DbClient["db"],
  eventId: string,
): Promise<InviteCodeListItem[]> {
  const rows = await db
    .select({
      id: inviteCodes.id,
      code: inviteCodes.code,
      issuedToUserId: inviteCodes.issuedToUserId,
      grantsCompanionOf: inviteCodes.grantsCompanionOf,
      maxUses: inviteCodes.maxUses,
      usedCount: inviteCodes.usedCount,
      expiresAt: inviteCodes.expiresAt,
    })
    .from(inviteCodes)
    .where(eq(inviteCodes.eventId, eventId))
    .orderBy(asc(inviteCodes.createdAt));

  return rows.map((row) => ({
    inviteCodeId: row.id,
    code: row.code,
    shape: deriveInviteCodeShape(row.issuedToUserId, row.grantsCompanionOf, row.maxUses),
    usedCount: row.usedCount,
    maxUses: row.maxUses,
    expiresAt: row.expiresAt,
  }));
}

export interface InviteCodeRow {
  id: string;
  eventId: string;
  code: string;
  issuedToUserId: string | null;
  grantsCompanionOf: string | null;
  maxUses: number;
  usedCount: number;
  expiresAt: Date | null;
}

// A single invite_codes row by id — used by the invite:open:<id> callback to
// re-derive the owning event's chapterId for the S2 re-check (same pattern
// getEventIdForRegistration/getEventById composes in organizerRequests.ts).
export async function getInviteCodeById(
  db: DbClient["db"],
  inviteCodeId: string,
): Promise<InviteCodeRow | null> {
  const rows = await db
    .select({
      id: inviteCodes.id,
      eventId: inviteCodes.eventId,
      code: inviteCodes.code,
      issuedToUserId: inviteCodes.issuedToUserId,
      grantsCompanionOf: inviteCodes.grantsCompanionOf,
      maxUses: inviteCodes.maxUses,
      usedCount: inviteCodes.usedCount,
      expiresAt: inviteCodes.expiresAt,
    })
    .from(inviteCodes)
    .where(eq(inviteCodes.id, inviteCodeId))
    .limit(1);

  return rows[0] ?? null;
}

export interface InviteCodeRedeemer {
  registrationId: string;
  displayName: string;
  company: string | null;
}

// §4.2's exact query shape: a plain SELECT joining registrations/profiles/
// users on invite_code_id, structurally excluding profiles.phone and
// profiles.email from the select clause (S3) -- never a runtime filter that
// could be bypassed. No UPDATE anywhere in this read path.
export async function listInviteCodeRedeemers(
  db: DbClient["db"],
  inviteCodeId: string,
  lang: BotLang,
): Promise<InviteCodeRedeemer[]> {
  const noNameFallback = getCatalog(lang).checkin.noNameFallback;

  const rows = await db
    .select({
      registrationId: registrations.id,
      firstName: profiles.firstName,
      lastName: profiles.lastName,
      tgUsername: users.tgUsername,
      company: profiles.company,
    })
    .from(registrations)
    .leftJoin(profiles, eq(profiles.userId, registrations.userId))
    .innerJoin(users, eq(users.id, registrations.userId))
    .where(eq(registrations.inviteCodeId, inviteCodeId))
    .orderBy(asc(registrations.createdAt));

  return rows.map((row) => ({
    registrationId: row.registrationId,
    displayName: deriveCheckinDisplayName(row.firstName, row.lastName, row.tgUsername, noNameFallback),
    company: row.company,
  }));
}

export interface InviteCodeDetail {
  inviteCodeId: string;
  code: string;
  shape: InviteCodeShape;
  usedCount: number;
  maxUses: number;
  expiresAt: Date | null;
  redeemers: InviteCodeRedeemer[];
}

// Composes the already-fetched invite_codes row (usedCount needs no join)
// with the separately-queried redeemer identities (§4.2's closing "why this
// is read-only" paragraph -- one combined query would force a wasted
// GROUP BY).
export async function getInviteCodeDetail(
  db: DbClient["db"],
  inviteCodeId: string,
  lang: BotLang,
): Promise<InviteCodeDetail | null> {
  const row = await getInviteCodeById(db, inviteCodeId);
  if (row === null) {
    return null;
  }
  const redeemers = await listInviteCodeRedeemers(db, inviteCodeId, lang);
  return {
    inviteCodeId: row.id,
    code: row.code,
    shape: deriveInviteCodeShape(row.issuedToUserId, row.grantsCompanionOf, row.maxUses),
    usedCount: row.usedCount,
    maxUses: row.maxUses,
    expiresAt: row.expiresAt,
    redeemers,
  };
}

// ---------------------------------------------------------------------------
// docs/agents/design/REQ-038.md — the redemption side of PRD FR-5. Framework-
// free (decisions/0004): no grammY import anywhere in this file.
// ---------------------------------------------------------------------------

// §3.1 step 1 — normalize: trim, then uppercase. Invite codes are generated
// exclusively from INVITE_CODE_ALPHABET's uppercase-only characters (§4
// above) -- a code copy-pasted in lowercase by some Telegram client must
// still resolve. Exported so both the lookup below and any caller that needs
// to resolve a raw, user-typed code string (display-data lookups included)
// apply the exact same rule rather than re-deriving it.
export function normalizeInviteCode(rawCode: string): string {
  return rawCode.trim().toUpperCase();
}

// §3.1 step 2 — the unlocked pre-check/by-code-string read. Deliberately
// cheap: never touches events, never opens a transaction. Mirrors
// getRegistrationByQrTokenForCheckin's identical "resolve to unknown fast"
// role (REQ-029 §2.1).
export async function getInviteCodeByCode(
  db: DbClient["db"],
  code: string,
): Promise<InviteCodeRow | null> {
  const rows = await db
    .select({
      id: inviteCodes.id,
      eventId: inviteCodes.eventId,
      code: inviteCodes.code,
      issuedToUserId: inviteCodes.issuedToUserId,
      grantsCompanionOf: inviteCodes.grantsCompanionOf,
      maxUses: inviteCodes.maxUses,
      usedCount: inviteCodes.usedCount,
      expiresAt: inviteCodes.expiresAt,
    })
    .from(inviteCodes)
    .where(eq(inviteCodes.code, code))
    .limit(1);

  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// §3.2 — validateInviteCodeForRedemption: pure, no I/O, no clock read
// (evaluationTime is an explicit parameter, decisions/0006). "Not found" is
// NOT a case of this function -- the caller (redeemInviteCode's step 2)
// already short-circuits before this function is ever reached, so it always
// receives a real, locked row's fields.
//
// Table order, exactly as the requirement states it (existence handled
// entirely outside this function -> expiry -> uses-remain -> event-match ->
// identity-match). Design §3.2's info-leakage analysis: the personal-code-
// redeemed-by-someone-else message is DELIBERATELY DISTINCT from "unknown
// code" -- the requirement's own text calls for each case's own stated
// reason, and codes carry >=128 bits of CSPRNG entropy (S4), so reaching this
// branch at all requires already possessing the exact code string. A
// distinct message therefore discloses nothing an attacker didn't already
// have.
// ---------------------------------------------------------------------------
export interface InviteCodeValidationInput {
  expiresAt: Date | null;
  usedCount: number;
  maxUses: number;
  codeEventId: string;
  issuedToUserId: string | null;
  targetEventId: string;
  redeemerUserId: string;
  evaluationTime: Date;
}

export type InviteCodeValidationResult =
  | { ok: true }
  | { ok: false; reason: "expired" | "spent" | "wrong-event" | "not-yours" };

export function validateInviteCodeForRedemption(
  input: InviteCodeValidationInput,
): InviteCodeValidationResult {
  // Row 1's expiresAt !== null guard is defensive-only: every issuing
  // function (issuePersonalInviteCode/issueBulkInviteCode/
  // issueCompanionInviteCode) takes a required, non-optional expiresAt, so no
  // row this requirement will ever read has a null expires_at in practice --
  // mirrors isRegistrationOpen's identical "null means no deadline"
  // convention (event.ts).
  if (input.expiresAt !== null && input.evaluationTime >= input.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (input.usedCount >= input.maxUses) {
    return { ok: false, reason: "spent" };
  }
  if (input.codeEventId !== input.targetEventId) {
    return { ok: false, reason: "wrong-event" };
  }
  if (input.issuedToUserId !== null && input.issuedToUserId !== input.redeemerUserId) {
    return { ok: false, reason: "not-yours" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §3.1 — redeemInviteCode: the transactional entry point shared by BOTH
// redemption routes (the i_<code> deep link and the typed /redeem command) --
// one decision function, two callers, per decisions/0004. Mirrors
// performQrCheckIn's two-phase discipline (unlocked pre-check, then a fresh
// LOCKED re-read inside the write transaction, REQ-029 §3.3) and
// registerForEvent's existing lock-then-decide shape (REQ-020 §3.2).
//
// `explicitEventId` is null for the i_<code> deep link (the target event is
// always the code's own event_id) and non-null for the typed
// /redeem <event_id> <code> command (§5.1).
// ---------------------------------------------------------------------------
export type InviteRedemptionOutcome =
  | RegisterForEventResult
  | { kind: "invite-code-not-found" }
  | { kind: "invite-code-expired" }
  | { kind: "invite-code-spent" }
  | { kind: "invite-code-wrong-event" }
  | { kind: "invite-code-not-yours" };

export async function redeemInviteCode(
  db: DbClient["db"],
  redeemerUserId: string,
  rawCode: string,
  explicitEventId: string | null,
  evaluationTime: Date,
): Promise<InviteRedemptionOutcome> {
  const normalizedCode = normalizeInviteCode(rawCode);

  // §3.1 step 2 — unlocked pre-check, fast fail on "unknown". Never touches
  // events, never opens a transaction.
  const precheck = await getInviteCodeByCode(db, normalizedCode);
  if (precheck === null) {
    return { kind: "invite-code-not-found" };
  }

  // §3.1 step 3 — resolve the target event id.
  const targetEventId = explicitEventId ?? precheck.eventId;

  return db.transaction(async (tx) => {
    // §3.1 step 4 — lock the events row, identical to registerForEvent's
    // existing step 2.
    const eventRows = await tx
      .select({
        id: events.id,
        status: events.status,
        requiresInvite: events.requiresInvite,
        requiresApproval: events.requiresApproval,
        registrationClosesAt: events.registrationClosesAt,
        endsAt: events.endsAt,
        capacity: events.capacity,
      })
      .from(events)
      .where(eq(events.id, targetEventId))
      .for("update");
    const event = eventRows[0];
    if (event === undefined) {
      return { kind: "not-found" };
    }

    // §3.1 step 5 — lock the invite_codes row FRESH, by id -- never reuse
    // step 2's unlocked read for the actual decision (same "never trust the
    // pre-tx read" discipline performQrCheckIn's token-currency recheck
    // already establishes). This is what makes AC4's concurrency property
    // hold: two concurrent redemptions of the same code's last use serialize
    // on this lock.
    const codeRows = await tx
      .select({
        id: inviteCodes.id,
        eventId: inviteCodes.eventId,
        issuedToUserId: inviteCodes.issuedToUserId,
        maxUses: inviteCodes.maxUses,
        usedCount: inviteCodes.usedCount,
        expiresAt: inviteCodes.expiresAt,
      })
      .from(inviteCodes)
      .where(eq(inviteCodes.id, precheck.id))
      .for("update");
    const codeRow = codeRows[0];
    if (codeRow === undefined) {
      // Defensive/unreachable: the precheck just found this row, and
      // invite_codes rows are never deleted anywhere in this codebase.
      return { kind: "invite-code-not-found" };
    }

    // §3.1 step 6 — run the pure validation table against the locked row's
    // CURRENT fields. Any non-ok result -> the matching refusal kind. No
    // write happens, used_count is untouched.
    const validation = validateInviteCodeForRedemption({
      expiresAt: codeRow.expiresAt,
      usedCount: codeRow.usedCount,
      maxUses: codeRow.maxUses,
      codeEventId: codeRow.eventId,
      issuedToUserId: codeRow.issuedToUserId,
      targetEventId,
      redeemerUserId,
      evaluationTime,
    });
    if (!validation.ok) {
      switch (validation.reason) {
        case "expired":
          return { kind: "invite-code-expired" };
        case "spent":
          return { kind: "invite-code-spent" };
        case "wrong-event":
          return { kind: "invite-code-wrong-event" };
        case "not-yours":
          return { kind: "invite-code-not-yours" };
      }
    }

    // §3.1 step 7 — the exact reads registerForEvent's existing steps 3-4
    // already perform on the (already-locked) event.
    const existingRows = await tx
      .select({ id: registrations.id, admission: registrations.admission })
      .from(registrations)
      .where(and(eq(registrations.eventId, targetEventId), eq(registrations.userId, redeemerUserId)))
      .limit(1);
    const existingRow = existingRows[0];
    const rawExistingAdmission = (existingRow?.admission as AdmissionState | undefined) ?? null;
    const existingAdmission = rawExistingAdmission === "withdrawn" ? null : rawExistingAdmission;
    const existingRegistrationId = rawExistingAdmission === "withdrawn" ? (existingRow?.id ?? null) : null;

    const admittedRows = await tx
      .select({ id: registrations.id })
      .from(registrations)
      .where(and(eq(registrations.eventId, targetEventId), eq(registrations.admission, "admitted")));
    const seatsLeft = computeSeatsLeft(event.capacity, admittedRows.length);

    // §3.1 step 8 — decide via the unchanged decideRegistrationOutcome, with
    // inviteSatisfied: true (the code just passed §3.2's table, so the gate
    // is cleared by construction).
    const outcome = decideRegistrationOutcome(
      {
        existingAdmission,
        eventStatus: event.status,
        requiresInvite: event.requiresInvite,
        requiresApproval: event.requiresApproval,
        registrationClosesAt: event.registrationClosesAt,
        endsAt: event.endsAt,
        seatsLeft,
        inviteSatisfied: true,
      },
      evaluationTime,
    );

    // §3.1 step 9 — every non-writing outcome returns unchanged. The code is
    // NOT consumed -- used_count stays untouched (a valid, unused code
    // presented against a cancelled/finished/closed event does not burn a
    // use).
    if (outcome.kind !== "admitted" && outcome.kind !== "waitlisted" && outcome.kind !== "requested") {
      return outcome;
    }

    // §3.1 step 10 — the writing outcomes, in the same transaction.
    const pendingSource = await getPendingSource(tx, redeemerUserId);
    const source = resolveRegistrationSource(pendingSource);
    const qrToken = outcome.kind === "admitted" ? generateQrToken() : null;

    let insertedRow: { id: string } | undefined;
    if (existingRegistrationId !== null) {
      const updated = await tx
        .update(registrations)
        .set({
          admission: outcome.kind,
          source,
          qrToken,
          inviteCodeId: codeRow.id,
        })
        .where(eq(registrations.id, existingRegistrationId))
        .returning({ id: registrations.id });
      insertedRow = updated[0];
    } else {
      const inserted = await tx
        .insert(registrations)
        .values({
          eventId: targetEventId,
          userId: redeemerUserId,
          admission: outcome.kind,
          source,
          qrToken,
          inviteCodeId: codeRow.id,
        })
        .returning({ id: registrations.id });
      insertedRow = inserted[0];
    }

    if (insertedRow === undefined) {
      // Unreachable in practice: RETURNING on a successful INSERT/UPDATE
      // always yields exactly one row (same no-speculation guard
      // registerForEvent/issuePersonalInviteCode already establish).
      throw new Error("redeemInviteCode: insert/update returned no row");
    }

    if (pendingSource !== null) {
      await clearPendingSource(tx, redeemerUserId);
    }

    // AC4/AC1 — the atomic used_count increment: the locked row's OWN
    // used_count (read at step 5) plus exactly 1, same transaction as the
    // registrations write above.
    await tx
      .update(inviteCodes)
      .set({ usedCount: codeRow.usedCount + 1 })
      .where(eq(inviteCodes.id, codeRow.id));

    // AC11 — exactly one audit_log row per successful redemption. No second,
    // separate invite_code.redeem row: traceability is carried by this row's
    // payload.inviteCodeId field instead (§3.1 step 10's explicit
    // resolution).
    await writeAuditLog(tx, {
      actorUserId: redeemerUserId,
      action:
        outcome.kind === "admitted"
          ? "registration.admit"
          : outcome.kind === "waitlisted"
            ? "registration.waitlist"
            : "registration.request",
      entity: "registration",
      entityId: insertedRow.id,
      payload: { eventId: targetEventId, inviteCodeId: codeRow.id },
      at: evaluationTime,
    });

    return {
      kind: outcome.kind,
      registrationId: insertedRow.id,
      ...(qrToken !== null ? { qrToken } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// §5.1 — parseRedeemArgs: /redeem <event_id> <code>, mirroring
// parseInvitePersonalArgs's exact two-token parse shape (splitInviteArgs,
// above) -- the "second token" here is the code itself rather than a user id.
// No optional third token (unlike the /invite_* family's expires_at
// override) -- this design defines no such override for redemption.
// ---------------------------------------------------------------------------
export type RedeemArgsValidation = { ok: true; eventId: string; code: string } | { ok: false };

export function parseRedeemArgs(raw: string): RedeemArgsValidation {
  const { eventId, second } = splitInviteArgs(raw);
  if (eventId === null || second === null || second.length === 0) {
    return { ok: false };
  }
  return { ok: true, eventId, code: second };
}
