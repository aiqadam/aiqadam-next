import { and, asc, eq, isNull, notInArray } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { inviteCodes, inviteListEntries, profiles, registrations, users } from "../db/schema.js";
import type { BotLang } from "../i18n/catalog.js";
import { writeAuditLog } from "./auditLog.js";
import { getInviteCodeByCode, issuePersonalInviteCode, normalizeInviteCode, type IssuedInviteCode } from "./inviteCode.js";
import { isNonBlank } from "./profile.js";

// ---------------------------------------------------------------------------
// docs/agents/design/REQ-040.md / REQ-040-schema.md — the named invitation
// list (PRD FR-17). Framework-free (decisions/0004): no grammY import
// anywhere in this file. Every time-dependent write (audit `at`) takes the
// caller-supplied evaluation time as an explicit parameter (decisions/0006).
// ---------------------------------------------------------------------------

// §1 — createNamedGuestUser: a thin, one-purpose wrapper for the pre-created
// (tg_id NULL) guest row. NOT resolveOrCreateUser (which is keyed on tg_id,
// always required there) — this is a distinct creation path with no tg_id
// input at all. Called only from addInviteListEntry, inside the same
// transaction as the list-entry INSERT and the audit write.
export async function createNamedGuestUser(db: DbClient["db"]): Promise<{ id: string }> {
  const rows = await db
    .insert(users)
    .values({
      tgId: null,
      tgUsername: null,
      lang: null,
    })
    .returning({ id: users.id });

  const row = rows[0];
  if (row === undefined) {
    // Unreachable in practice: RETURNING on a successful INSERT always
    // yields exactly one row (no-speculation guard, this codebase's
    // established convention).
    throw new Error("createNamedGuestUser: insert returned no row");
  }
  return row;
}

// ---------------------------------------------------------------------------
// §4.1 — /invite_list_add <event_id> <name> | <company> | <position>
// ---------------------------------------------------------------------------
export type ParseInviteListAddResult =
  | { ok: true; eventId: string; name: string; company: string; position: string }
  | { ok: false; reason: "missing-event-id" | "missing-name" };

// Pipe-delimited remainder, mirroring parseCompanionFieldsMessage's
// established convention (domain/inviteCode.ts). `name` required; `company`/
// `position` optional, "" meaning "not given" (createWalkinProfile's own
// convention).
export function parseInviteListAddArgs(raw: string): ParseInviteListAddResult {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "missing-event-id" };
  }
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return { ok: false, reason: "missing-name" };
  }
  const eventId = trimmed.slice(0, firstSpace).trim();
  const rest = trimmed.slice(firstSpace + 1);
  const segments = rest.split("|");
  const name = (segments[0] ?? "").trim();
  const company = (segments[1] ?? "").trim();
  const position = (segments[2] ?? "").trim();

  if (eventId.length === 0) {
    return { ok: false, reason: "missing-event-id" };
  }
  if (!isNonBlank(name)) {
    return { ok: false, reason: "missing-name" };
  }
  return { ok: true, eventId, name, company, position };
}

export interface AddInviteListEntryResult {
  entryId: string;
  userId: string;
}

// §4.1 steps (one transaction): createNamedGuestUser -> INSERT
// invite_list_entries -> exactly one writeAuditLog call, action
// "invite_list.add". Never phone/email (§3.4 -- neither is ever collected by
// this command in the first place).
export async function addInviteListEntry(
  db: DbClient["db"],
  actorUserId: string,
  eventId: string,
  name: string,
  company: string,
  position: string,
  at: Date,
): Promise<AddInviteListEntryResult> {
  return db.transaction(async (tx) => {
    const guest = await createNamedGuestUser(tx);

    const rows = await tx
      .insert(inviteListEntries)
      .values({
        eventId,
        userId: guest.id,
        addedBy: actorUserId,
        inviteCodeId: null,
        openedAt: null,
        name,
        company: company === "" ? null : company,
        position: position === "" ? null : position,
      })
      .returning({ id: inviteListEntries.id });

    const row = rows[0];
    if (row === undefined) {
      throw new Error("addInviteListEntry: insert returned no row");
    }

    await writeAuditLog(tx, {
      actorUserId,
      action: "invite_list.add",
      entity: "invite_list_entry",
      entityId: row.id,
      payload: { eventId, userId: guest.id, name, company, position },
      at,
    });

    return { entryId: row.id, userId: guest.id };
  });
}

// ---------------------------------------------------------------------------
// §4.4 -- invite_list:remove:<entryId> -> invite_list:remove:confirm:<entryId>
// ---------------------------------------------------------------------------
export interface InviteListEntryForRemoval {
  entryId: string;
  eventId: string;
  userId: string;
}

// Read-only lookup the handler uses to re-derive the owning event's
// chapterId for the S2 re-check (same pattern getInviteCodeById composes).
export async function getInviteListEntryById(
  db: DbClient["db"],
  entryId: string,
): Promise<InviteListEntryForRemoval | null> {
  const rows = await db
    .select({
      entryId: inviteListEntries.id,
      eventId: inviteListEntries.eventId,
      userId: inviteListEntries.userId,
    })
    .from(inviteListEntries)
    .where(eq(inviteListEntries.id, entryId))
    .limit(1);
  return rows[0] ?? null;
}

export type RemoveInviteListEntryResult = { kind: "removed" } | { kind: "not-found" };

// Hard DELETE (REQ-040-schema.md §3) -- audit_log.entity_id carries no FK, so
// writing the audit row before/with the DELETE is safe (§3.1 of that
// artefact). Never touches the underlying `users` row.
export async function removeInviteListEntry(
  db: DbClient["db"],
  actorUserId: string,
  entryId: string,
  at: Date,
): Promise<RemoveInviteListEntryResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({ id: inviteListEntries.id, eventId: inviteListEntries.eventId, userId: inviteListEntries.userId })
      .from(inviteListEntries)
      .where(eq(inviteListEntries.id, entryId))
      .for("update");
    const row = rows[0];
    if (row === undefined) {
      return { kind: "not-found" };
    }

    await tx.delete(inviteListEntries).where(eq(inviteListEntries.id, entryId));

    await writeAuditLog(tx, {
      actorUserId,
      action: "invite_list.remove",
      entity: "invite_list_entry",
      entityId: row.id,
      payload: { eventId: row.eventId, userId: row.userId },
      at,
    });

    return { kind: "removed" };
  });
}

// ---------------------------------------------------------------------------
// §4.3 -- invite_list:issue:<entryId> callback -- composes REQ-037's
// issuePersonalInviteCode unchanged, then stamps invite_code_id on the entry,
// in the same transaction. No second, list-specific audit row (§5 --
// issuePersonalInviteCode's own invite_code.issue row already records it).
// ---------------------------------------------------------------------------
export async function issueInviteListEntryCode(
  db: DbClient["db"],
  actorUserId: string,
  eventId: string,
  entryId: string,
  targetUserId: string,
  expiresAt: Date,
  at: Date,
): Promise<IssuedInviteCode> {
  return db.transaction(async (tx) => {
    const issued = await issuePersonalInviteCode(tx, actorUserId, eventId, targetUserId, expiresAt, at);
    await tx.update(inviteListEntries).set({ inviteCodeId: issued.id }).where(eq(inviteListEntries.id, entryId));
    return issued;
  });
}

// ---------------------------------------------------------------------------
// §3.2 (REQ-040.md) -- markInviteListEntryOpened: the first-open-only write,
// matched by invite_code_id, guarded `opened_at IS NULL`. Called from
// handlers/start.ts's resolveInviteDeepLink, after the consent gate, at the
// same point that function already reads the code row for companion-shape
// detection. A no-op (zero rows matched) for a companion/bulk code, or a
// personal code with no matching list entry at all.
// ---------------------------------------------------------------------------
export async function markInviteListEntryOpened(db: DbClient["db"], inviteCodeId: string, at: Date): Promise<void> {
  await db
    .update(inviteListEntries)
    .set({ openedAt: at })
    .where(and(eq(inviteListEntries.inviteCodeId, inviteCodeId), isNull(inviteListEntries.openedAt)));
}

// ---------------------------------------------------------------------------
// §4.2 -- the S3-safe list view. registered/attended are DERIVED (§3.3), no
// column, no UPDATE anywhere in this query.
// ---------------------------------------------------------------------------
export type InviteListStatus = "invited" | "opened" | "registered" | "attended";

export interface InviteListEntryView {
  entryId: string;
  userId: string;
  name: string;
  company: string | null;
  position: string | null;
  status: InviteListStatus;
  inviteCodeId: string | null;
}

// §4.2 display-precedence: profiles data wins wherever a profiles row now
// exists (more authoritative, and the person's own, consented data),
// otherwise the entry's own organizer-entered snapshot. Same "firstName or
// lastName present" trigger deriveCheckinDisplayName already establishes.
function deriveInviteListDisplayName(
  profileFirstName: string | null,
  profileLastName: string | null,
  entryName: string,
): string {
  if (profileFirstName !== null && profileLastName !== null) {
    return `${profileFirstName} ${profileLastName}`;
  }
  if (profileFirstName !== null) {
    return profileFirstName;
  }
  if (profileLastName !== null) {
    return profileLastName;
  }
  return entryName;
}

// §4.2's exact select clause -- structurally excludes profiles.phone/
// profiles.email (S3): the query never names either column, so there is no
// runtime filter that could be bypassed.
export async function listInviteListEntries(db: DbClient["db"], eventId: string): Promise<InviteListEntryView[]> {
  const rows = await db
    .select({
      entryId: inviteListEntries.id,
      userId: inviteListEntries.userId,
      inviteCodeId: inviteListEntries.inviteCodeId,
      openedAt: inviteListEntries.openedAt,
      entryName: inviteListEntries.name,
      entryCompany: inviteListEntries.company,
      entryPosition: inviteListEntries.position,
      profileFirstName: profiles.firstName,
      profileLastName: profiles.lastName,
      profileCompany: profiles.company,
      profilePosition: profiles.position,
      registrationAdmission: registrations.admission,
      checkedInAt: registrations.checkedInAt,
    })
    .from(inviteListEntries)
    .leftJoin(profiles, eq(profiles.userId, inviteListEntries.userId))
    .leftJoin(
      registrations,
      and(eq(registrations.userId, inviteListEntries.userId), eq(registrations.eventId, inviteListEntries.eventId)),
    )
    .where(eq(inviteListEntries.eventId, eventId))
    .orderBy(asc(inviteListEntries.createdAt));

  return rows.map((row) => {
    // §3.3 -- "live admission" set reused unchanged from REQ-040.md's own
    // stated derivation.
    const isLive =
      row.registrationAdmission === "admitted" ||
      row.registrationAdmission === "waitlisted" ||
      row.registrationAdmission === "requested";

    let status: InviteListStatus;
    if (isLive) {
      status = row.checkedInAt !== null ? "attended" : "registered";
    } else if (row.openedAt !== null) {
      status = "opened";
    } else {
      status = "invited";
    }

    return {
      entryId: row.entryId,
      userId: row.userId,
      name: deriveInviteListDisplayName(row.profileFirstName, row.profileLastName, row.entryName),
      company: row.profileCompany ?? row.entryCompany,
      position: row.profilePosition ?? row.entryPosition,
      status,
      inviteCodeId: row.inviteCodeId,
    };
  });
}

// ---------------------------------------------------------------------------
// docs/agents/design/REQ-040.md §2 -- resolvePersonalCodeIdentity: the new
// pre-`resolveOrCreateUser` identity-resolution step, run only when
// parseStartPayload returns kind: "invite". §2.2's rule table, implemented
// exactly.
// ---------------------------------------------------------------------------
export type ResolvePersonalCodeIdentityResult =
  | { kind: "not-applicable" }
  | { kind: "linked"; userId: string }
  | { kind: "collision-relinked"; userId: string };

export async function resolvePersonalCodeIdentity(
  db: DbClient["db"],
  rawCode: string,
  callerTgId: bigint,
  callerTgUsername: string | null,
  callerLang: BotLang | null,
  at: Date,
): Promise<ResolvePersonalCodeIdentityResult> {
  const normalizedCode = normalizeInviteCode(rawCode);
  const codeRow = await getInviteCodeByCode(db, normalizedCode);
  // Rule table row 1 -- code not found, or found but issuedToUserId is null
  // (bulk/companion shape).
  if (codeRow === null || codeRow.issuedToUserId === null) {
    return { kind: "not-applicable" };
  }
  const targetUserId = codeRow.issuedToUserId;

  return db.transaction(async (tx) => {
    const aRows = await tx
      .select({ id: users.id, tgId: users.tgId })
      .from(users)
      .where(eq(users.id, targetUserId))
      .for("update");
    const a = aRows[0];
    // Rule table row 2 -- target row A not found (defensive; FK guarantees
    // this in practice). Rule table row 3 -- A.tgId already non-null
    // (already linked, or targets an existing member).
    if (a === undefined || a.tgId !== null) {
      return { kind: "not-applicable" };
    }

    const bRows = await tx.select({ id: users.id }).from(users).where(eq(users.tgId, callerTgId)).limit(1);
    const b = bRows[0];

    if (b === undefined) {
      // §2.3 -- the normal case: link, don't create. WHERE ... AND tg_id IS
      // NULL is the concurrency guard.
      const updated = await tx
        .update(users)
        .set({ tgId: callerTgId, tgUsername: callerTgUsername, lang: callerLang })
        .where(and(eq(users.id, a.id), isNull(users.tgId)))
        .returning({ id: users.id });
      if (updated[0] !== undefined) {
        return { kind: "linked", userId: a.id };
      }
      // Concurrency fallback (§2.3): re-read -- if the row's tg_id now
      // equals callerTgId, the flow is idempotent and proceeds as linked
      // anyway; otherwise treat as not-applicable and let
      // resolveOrCreateUser + the existing "not-yours" refusal handle it.
      const recheck = await tx.select({ tgId: users.tgId }).from(users).where(eq(users.id, a.id)).limit(1);
      if (recheck[0]?.tgId === callerTgId) {
        return { kind: "linked", userId: a.id };
      }
      return { kind: "not-applicable" };
    }

    if (b.id === a.id) {
      // Defensive/unreachable: a.tgId is null (checked above), so no row
      // holding callerTgId can equal a.id.
      return { kind: "not-applicable" };
    }

    // §2.4 -- the hard case: relink the list entries and the outstanding
    // personal code(s), never a data merge, never a refusal. A is left
    // inert, permanently tg_id NULL.
    return relinkToExistingAccount(tx, a.id, b.id, at);
  });
}

// §2.4's exact two-step, conflict-free relink (REQ-040-schema.md §4.2),
// scoped to ALL of A's invite_list_entries across every event (§2.4 point
// 2), plus A's outstanding personal invite code(s) (§2.4 point 1). One
// audit_log row per entry A held, whether it ends as an UPDATE or a DELETE
// (REQ-040-schema.md §4.3).
async function relinkToExistingAccount(
  tx: DbClient["db"],
  aUserId: string,
  bUserId: string,
  at: Date,
): Promise<ResolvePersonalCodeIdentityResult> {
  const aEntries = await tx
    .select({ id: inviteListEntries.id, eventId: inviteListEntries.eventId })
    .from(inviteListEntries)
    .where(eq(inviteListEntries.userId, aUserId));

  const bEventRows = await tx
    .select({ eventId: inviteListEntries.eventId })
    .from(inviteListEntries)
    .where(eq(inviteListEntries.userId, bUserId));
  const bEventIds = bEventRows.map((row) => row.eventId);

  // Step 1 -- conditional repoint: every row currently pointing at A moves to
  // B, except where B already has an entry for that same event.
  const repointWhere =
    bEventIds.length > 0
      ? and(eq(inviteListEntries.userId, aUserId), notInArray(inviteListEntries.eventId, bEventIds))
      : eq(inviteListEntries.userId, aUserId);
  await tx.update(inviteListEntries).set({ userId: bUserId }).where(repointWhere);

  // Step 2 -- cleanup of the leftovers: delete every remaining row still
  // pointing at A (exactly the rows step 1's condition skipped).
  await tx.delete(inviteListEntries).where(eq(inviteListEntries.userId, aUserId));

  // §2.4 point 1 -- repoint A's outstanding personal invite code(s).
  await tx.update(inviteCodes).set({ issuedToUserId: bUserId }).where(eq(inviteCodes.issuedToUserId, aUserId));

  for (const entry of aEntries) {
    await writeAuditLog(tx, {
      actorUserId: bUserId,
      action: "invite_list.entry_relinked",
      entity: "invite_list_entry",
      entityId: entry.id,
      payload: { fromUserId: aUserId, toUserId: bUserId, eventId: entry.eventId },
      at,
    });
  }

  return { kind: "collision-relinked", userId: bUserId };
}

// Re-exported so handlers/inviteList.ts can resolve the owning event's
// chapterId for an entry without a second, ad-hoc query -- same "read only
// what the S2 re-check needs" precedent getInviteCodeById/
// getEventIdForRegistration already establish.
export async function getEventIdForInviteListEntry(db: DbClient["db"], entryId: string): Promise<string | null> {
  const rows = await db
    .select({ eventId: inviteListEntries.eventId })
    .from(inviteListEntries)
    .where(eq(inviteListEntries.id, entryId))
    .limit(1);
  return rows[0]?.eventId ?? null;
}
