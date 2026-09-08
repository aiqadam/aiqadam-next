import { randomBytes } from "node:crypto";
import { asc, eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { inviteCodes, profiles, registrations, users } from "../db/schema.js";
import type { BotLang } from "../i18n/catalog.js";
import { getCatalog } from "../i18n/catalog.js";
import { writeAuditLog } from "./auditLog.js";
import { deriveCheckinDisplayName } from "./registration.js";

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
