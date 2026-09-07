import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, lt, or } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { chapters, events, registrations, users } from "../db/schema.js";
import { writeAuditLog } from "./auditLog.js";
import {
  computeSeatsLeft,
  getPendingSource,
  isAutoPromotionHalted,
  isFinished,
  isRegistrationOpen,
} from "./event.js";

// docs/agents/design/REQ-020.md — registration for an open event, atomic
// capacity enforcement, qr_token issuance. Framework-free (decisions/0004):
// no grammY import anywhere in this file. Every time-dependent predicate
// takes the evaluation time as an explicit parameter (decisions/0006) — this
// file never calls SQL now()/current_timestamp inside a predicate.

// ---------------------------------------------------------------------------
// §2 — the pure outcome decision (AC1, AC2, AC4, AC6).
// ---------------------------------------------------------------------------
export type AdmissionState =
  | "requested"
  | "waitlisted"
  | "admitted"
  | "rejected"
  | "withdrawn";

export interface RegistrationDecisionInput {
  existingAdmission: AdmissionState | null;
  eventStatus: "draft" | "published" | "cancelled";
  requiresInvite: boolean;
  requiresApproval: boolean;
  registrationClosesAt: Date | null;
  endsAt: Date;
  seatsLeft: number;
}

export type RegistrationOutcome =
  | { kind: "not-found" }
  | { kind: "already-registered"; admission: AdmissionState }
  | { kind: "event-cancelled" }
  | { kind: "event-finished" }
  | { kind: "registration-closed" }
  | { kind: "requires-invite" }
  | { kind: "requires-approval" }
  | { kind: "admitted" }
  | { kind: "waitlisted" };

// §2.2 — first-match-wins table, implemented in the exact stated order.
// "not-found" (§2.1's union member) is never returned by this pure function —
// it is produced only by registerForEvent itself.
export function decideRegistrationOutcome(
  input: RegistrationDecisionInput,
  evaluationTime: Date,
): RegistrationOutcome {
  if (input.existingAdmission !== null) {
    return { kind: "already-registered", admission: input.existingAdmission };
  }
  if (input.eventStatus === "cancelled") {
    return { kind: "event-cancelled" };
  }
  if (isFinished(input.endsAt, evaluationTime)) {
    return { kind: "event-finished" };
  }
  if (!isRegistrationOpen(input.registrationClosesAt, evaluationTime)) {
    return { kind: "registration-closed" };
  }
  if (input.requiresInvite) {
    return { kind: "requires-invite" };
  }
  if (input.requiresApproval) {
    return { kind: "requires-approval" };
  }
  if (input.seatsLeft > 0) {
    return { kind: "admitted" };
  }
  return { kind: "waitlisted" };
}

// ---------------------------------------------------------------------------
// §4 — qr_token generation (S4, AC3). One CSPRNG call, one encoding step, no
// loop, no parameters, no I/O. 32 bytes (256 bits) hex-encoded to a
// 64-character string. Never Math.random, never a counter, never a hash of
// any predictable input.
// ---------------------------------------------------------------------------
export function generateQrToken(): string {
  return randomBytes(32).toString("hex");
}

// ---------------------------------------------------------------------------
// §5.1 — resolveRegistrationSource: pendingSource unchanged when non-null,
// "direct" otherwise. No allow-list, no format validation.
// ---------------------------------------------------------------------------
export function resolveRegistrationSource(pendingSource: string | null): string {
  return pendingSource ?? "direct";
}

// ---------------------------------------------------------------------------
// §5.2 — clearPendingSource: one UPDATE, same shape as setPendingSource.
// ---------------------------------------------------------------------------
export async function clearPendingSource(db: DbClient["db"], userId: string): Promise<void> {
  await db.update(users).set({ pendingSource: null }).where(eq(users.id, userId));
}

// ---------------------------------------------------------------------------
// §3 — registerForEvent: the atomic write (AC1, AC2, AC3, AC5, AC6, AC7).
// ---------------------------------------------------------------------------
export type RegisterForEventResult = RegistrationOutcome & {
  registrationId?: string;
  qrToken?: string;
};

export async function registerForEvent(
  db: DbClient["db"],
  userId: string,
  eventId: string,
  evaluationTime: Date,
): Promise<RegisterForEventResult> {
  return db.transaction(async (tx) => {
    // §3.2 step 2 — lock the events row for the lifetime of this transaction.
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
      .where(eq(events.id, eventId))
      .for("update");

    const event = eventRows[0];
    if (event === undefined) {
      return { kind: "not-found" };
    }

    // §3.2 step 3 — any existing registration for this (event, user) pair.
    // docs/agents/design/REQ-022.md §3 point 1 — `id` is now selected too, so
    // a withdrawn row can be reused (UPDATEd) instead of re-inserted.
    const existingRows = await tx
      .select({ id: registrations.id, admission: registrations.admission })
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)))
      .limit(1);
    const existingRow = existingRows[0];
    const rawExistingAdmission = (existingRow?.admission as AdmissionState | undefined) ?? null;
    // docs/agents/design/REQ-022.md §3 point 2 — a withdrawn row is
    // normalized to null for the purposes of deciding the new outcome
    // (decideRegistrationOutcome itself is unchanged); every other non-null
    // admission value is passed through exactly as today.
    const existingAdmission = rawExistingAdmission === "withdrawn" ? null : rawExistingAdmission;
    // Only ever non-null when rawExistingAdmission === "withdrawn" — every
    // other non-null case returns "already-registered" below, before step 8
    // is reached.
    const existingRegistrationId = rawExistingAdmission === "withdrawn" ? (existingRow?.id ?? null) : null;

    // §3.2 step 4 — admitted count, against tx.
    const admittedRows = await tx
      .select({ id: registrations.id })
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.admission, "admitted")));
    const admittedCount = admittedRows.length;

    // §3.2 step 5 — seatsLeft.
    const seatsLeft = computeSeatsLeft(event.capacity, admittedCount);

    // §3.2 step 6 — decide the outcome (pure).
    const outcome = decideRegistrationOutcome(
      {
        existingAdmission,
        eventStatus: event.status,
        requiresInvite: event.requiresInvite,
        requiresApproval: event.requiresApproval,
        registrationClosesAt: event.registrationClosesAt,
        endsAt: event.endsAt,
        seatsLeft,
      },
      evaluationTime,
    );

    // §3.2 step 7 — every non-writing outcome returns unchanged.
    if (outcome.kind !== "admitted" && outcome.kind !== "waitlisted") {
      return outcome;
    }

    // §3.2 step 8 — the writing outcomes.
    const pendingSource = await getPendingSource(tx, userId);
    const source = resolveRegistrationSource(pendingSource);
    const qrToken = outcome.kind === "admitted" ? generateQrToken() : null;

    // docs/agents/design/REQ-022.md §3 point 3 — reuse (UPDATE) the existing
    // withdrawn row when one was found, instead of inserting a second row for
    // the same (event_id, user_id) pair; INSERT exactly as before otherwise.
    // The UPDATE's SET clause names only admission/source/qr_token — id and
    // created_at are never touched (§3.1).
    let insertedRow: { id: string } | undefined;
    if (existingRegistrationId !== null) {
      const updated = await tx
        .update(registrations)
        .set({
          admission: outcome.kind,
          source,
          qrToken,
        })
        .where(eq(registrations.id, existingRegistrationId))
        .returning({ id: registrations.id });
      insertedRow = updated[0];
    } else {
      const inserted = await tx
        .insert(registrations)
        .values({
          eventId,
          userId,
          admission: outcome.kind,
          source,
          qrToken,
        })
        .returning({ id: registrations.id });
      insertedRow = inserted[0];
    }

    if (insertedRow === undefined) {
      // Unreachable in practice: RETURNING on a successful INSERT/UPDATE
      // always yields exactly one row (same no-speculation guard
      // createEvent/createVenue already establish elsewhere in this
      // codebase).
      throw new Error("registerForEvent: insert/update returned no row");
    }

    if (pendingSource !== null) {
      await clearPendingSource(tx, userId);
    }

    await writeAuditLog(tx, {
      actorUserId: userId,
      action: outcome.kind === "admitted" ? "registration.admit" : "registration.waitlist",
      entity: "registration",
      entityId: insertedRow.id,
      payload: { eventId },
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
// docs/agents/design/REQ-021.md §2 — getWaitlistPosition: a pure, read-only,
// never-cached position computation (AC1, AC2, AC3). Performs exactly one
// SELECT ... LIMIT 1 (the target row) and one SELECT count(*)-shaped query
// (rows strictly ahead of it), both against the live state of `registrations`
// — no write, no stored/cached intermediate anywhere. Uses only plain
// Drizzle eq/lt/and/or filters (no raw SQL, no window function), matching
// the shape of `registrations_waitlist_order_idx` (event_id, created_at)
// WHERE admission = 'waitlisted'.
// ---------------------------------------------------------------------------
export async function getWaitlistPosition(
  db: DbClient["db"],
  eventId: string,
  registrationId: string,
): Promise<number | null> {
  // §2.2 step 1 — read the target row's own created_at/admission.
  const targetRows = await db
    .select({
      createdAt: registrations.createdAt,
      admission: registrations.admission,
    })
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);

  const target = targetRows[0];
  // §2.2 step 1 — defensive: no row found.
  if (target === undefined) {
    return null;
  }
  // §2.2 step 2 — defensive: the row is not (or no longer) waitlisted.
  if (target.admission !== "waitlisted") {
    return null;
  }

  // §2.2 step 3 — count rows strictly ahead: same event, waitlisted, and
  // (created_at earlier) OR (created_at equal AND id lower) — §2.3's
  // tie-break, making the ranking a total order.
  const aheadRows = await db
    .select({ id: registrations.id })
    .from(registrations)
    .where(
      and(
        eq(registrations.eventId, eventId),
        eq(registrations.admission, "waitlisted"),
        or(
          lt(registrations.createdAt, target.createdAt),
          and(eq(registrations.createdAt, target.createdAt), lt(registrations.id, registrationId)),
        ),
      ),
    );

  // §2.2 step 4 — 1-based position.
  return aheadRows.length + 1;
}

// ---------------------------------------------------------------------------
// docs/agents/design/REQ-023.md §2.2 — decidePromotionEligibility: pure, no
// I/O. First-match-wins table, same convention decideWithdrawOutcome/
// decideRegistrationOutcome already establish.
// ---------------------------------------------------------------------------
export interface PromotionEligibilityInput {
  eventStatus: "draft" | "published" | "cancelled";
  startsAt: Date;
  endsAt: Date;
  seatsLeft: number;
}

export type PromotionEligibility =
  | { ok: true }
  | { ok: false; reason: "event-not-eligible" }
  | { ok: false; reason: "halted-t24h" }
  | { ok: false; reason: "capacity-full" };

export function decidePromotionEligibility(
  input: PromotionEligibilityInput,
  evaluationTime: Date,
): PromotionEligibility {
  if (input.eventStatus !== "published" || isFinished(input.endsAt, evaluationTime)) {
    return { ok: false, reason: "event-not-eligible" };
  }
  if (isAutoPromotionHalted(input.startsAt, evaluationTime)) {
    return { ok: false, reason: "halted-t24h" };
  }
  if (input.seatsLeft <= 0) {
    return { ok: false, reason: "capacity-full" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// docs/agents/design/REQ-023.md §3 — promoteFromWaitlistIfEligible: the
// transactional actor (AC1, AC2, AC3, AC4, AC5, AC7). `tx` is always the same
// transaction handle the caller (withdrawRegistration) is already inside —
// this function never opens its own db.transaction(...).
// ---------------------------------------------------------------------------
export type PromotionOutcome =
  | { kind: "not-attempted" }
  | { kind: "event-not-found" }
  | { kind: "event-not-eligible" }
  | { kind: "halted-t24h" }
  | { kind: "capacity-full" }
  | { kind: "no-waitlist" }
  | { kind: "promoted"; registrationId: string; promotedUserId: string; qrToken: string };

export async function promoteFromWaitlistIfEligible(
  tx: DbClient["db"],
  eventId: string,
  evaluationTime: Date,
): Promise<PromotionOutcome> {
  // §3 step 1 — lock the events row FIRST, same discipline registerForEvent
  // (REQ-020 §3.2 step 2) already uses on this table (AC4's serialization).
  const eventRows = await tx
    .select({
      id: events.id,
      status: events.status,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      capacity: events.capacity,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .for("update");

  const event = eventRows[0];
  if (event === undefined) {
    return { kind: "event-not-found" };
  }

  // §3 step 2 — fresh admitted count, inside tx.
  const admittedRows = await tx
    .select({ id: registrations.id })
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.admission, "admitted")));
  const seatsLeft = computeSeatsLeft(event.capacity, admittedRows.length);

  // §3 step 3 — decide (pure). Not eligible -> no further reads, no write.
  const eligibility = decidePromotionEligibility(
    {
      eventStatus: event.status,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      seatsLeft,
    },
    evaluationTime,
  );
  if (!eligibility.ok) {
    return { kind: eligibility.reason };
  }

  // §3 step 4 — select rank 1 by the same (created_at, id) tie-break
  // getWaitlistPosition already establishes (REQ-021 §2.2/§2.3), FOR UPDATE
  // because this row is about to be written.
  const candidateRows = await tx
    .select({ id: registrations.id, userId: registrations.userId })
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.admission, "waitlisted")))
    .orderBy(asc(registrations.createdAt), asc(registrations.id))
    .limit(1)
    .for("update");

  const candidate = candidateRows[0];
  if (candidate === undefined) {
    return { kind: "no-waitlist" };
  }

  // §3 step 5 — the SET clause names only admission/qr_token.
  const qrToken = generateQrToken();
  await tx
    .update(registrations)
    .set({ admission: "admitted", qrToken })
    .where(eq(registrations.id, candidate.id));

  // §3 step 6 — exactly one audit_log row (S8, AC7's "exactly one row" half).
  await writeAuditLog(tx, {
    actorUserId: null,
    action: "registration.promote",
    entity: "registration",
    entityId: candidate.id,
    payload: { eventId },
    at: evaluationTime,
  });

  // §3 step 7.
  return {
    kind: "promoted",
    registrationId: candidate.id,
    promotedUserId: candidate.userId,
    qrToken,
  };
}

// ---------------------------------------------------------------------------
// docs/agents/design/REQ-022.md §2 — the withdraw domain logic (AC1-AC5).
// Framework-free (decisions/0004). checkedInAt/admission never read via
// SQL now()/current_timestamp — the evaluation time is supplied by the
// caller for the audit-log write only (decisions/0006 exempts audit/
// bookkeeping defaults).
// ---------------------------------------------------------------------------

export interface WithdrawDecisionInput {
  registrationExists: boolean;
  ownerUserId: string | null;
  actingUserId: string;
  admission: AdmissionState | null;
  checkedInAt: Date | null;
}

export type WithdrawOutcome =
  | { kind: "not-found" }
  | { kind: "not-owner" }
  | { kind: "checked-in" }
  | { kind: "not-eligible"; admission: AdmissionState }
  | { kind: "withdrawn"; promotion: PromotionOutcome };

// §2.1 — first-match-wins table, implemented in the exact stated order.
export function decideWithdrawOutcome(input: WithdrawDecisionInput): WithdrawOutcome {
  if (!input.registrationExists) {
    return { kind: "not-found" };
  }
  if (input.ownerUserId !== input.actingUserId) {
    return { kind: "not-owner" };
  }
  if (input.checkedInAt !== null) {
    return { kind: "checked-in" };
  }
  const admission = input.admission as AdmissionState;
  if (admission !== "requested" && admission !== "waitlisted" && admission !== "admitted") {
    return { kind: "not-eligible", admission };
  }
  // docs/agents/design/REQ-023.md §4 — decideWithdrawOutcome is pure (no I/O)
  // and cannot know the promotion outcome, which requires a DB transaction.
  // "not-attempted" is the same fixed sentinel the design already defines
  // for "promotion was never attempted" (§0 step 7) — this pure decision
  // never actually attempts a promotion itself, so it is the correct value
  // here too. No caller of decideWithdrawOutcome inspects `.promotion` on the
  // "withdrawn" branch (the command handler's §4.1 step 5 only checks
  // outcome.kind); the real, I/O-derived promotion outcome is produced only
  // by withdrawRegistration itself, further down this file.
  return { kind: "withdrawn", promotion: { kind: "not-attempted" } };
}

// §2.2 — the transactional write (AC2, AC3, AC5).
export async function withdrawRegistration(
  db: DbClient["db"],
  registrationId: string,
  actingUserId: string,
  at: Date,
): Promise<WithdrawOutcome> {
  return db.transaction(async (tx) => {
    // §2.2 step 1 — row lock, fresh read inside this transaction (§2.3: never
    // reused from whatever data populated the confirmation prompt).
    const rows = await tx
      .select({
        id: registrations.id,
        eventId: registrations.eventId,
        userId: registrations.userId,
        admission: registrations.admission,
        checkedInAt: registrations.checkedInAt,
      })
      .from(registrations)
      .where(eq(registrations.id, registrationId))
      .for("update");

    const row = rows[0];

    // §2.2 step 2 — build the decision input and decide (pure, no I/O).
    const outcome = decideWithdrawOutcome({
      registrationExists: row !== undefined,
      ownerUserId: row?.userId ?? null,
      actingUserId,
      admission: (row?.admission as AdmissionState | undefined) ?? null,
      checkedInAt: row?.checkedInAt ?? null,
    });

    // §2.2 step 3 — every non-"withdrawn" outcome returns unchanged: no
    // write, no audit row.
    if (outcome.kind !== "withdrawn" || row === undefined) {
      return outcome;
    }

    // docs/agents/design/REQ-023.md §0 — capture the pre-withdrawal admission
    // before the UPDATE below overwrites it; only an 'admitted' row frees a
    // seat, so promotion is only attempted in that case.
    const wasAdmitted = row.admission === "admitted";

    // §2.2 step 4 — the one-column UPDATE.
    await tx.update(registrations).set({ admission: "withdrawn" }).where(eq(registrations.id, row.id));

    // §2.2 step 5 — exactly one audit_log row, same transaction (S8).
    await writeAuditLog(tx, {
      actorUserId: actingUserId,
      action: "registration.withdraw",
      entity: "registration",
      entityId: row.id,
      payload: { eventId: row.eventId },
      at,
    });

    // docs/agents/design/REQ-023.md §0 steps 6-7 — promotion is attempted
    // only when the withdrawn row was previously 'admitted' (a freed seat),
    // using the SAME tx so the withdrawal and the promotion commit/rollback
    // together atomically.
    const promotion: PromotionOutcome = wasAdmitted
      ? await promoteFromWaitlistIfEligible(tx, row.eventId, at)
      : { kind: "not-attempted" };

    return { kind: "withdrawn", promotion };
  });
}

// §4.1 step 4 — the display-only read backing the /withdraw command's
// confirmation prompt. Plain SELECT, no lock (the authoritative, lock-taking
// read happens later inside withdrawRegistration itself, per §2.3).
export interface RegistrationForEventAndUser {
  id: string;
  admission: AdmissionState;
  checkedInAt: Date | null;
}

// docs/agents/design/REQ-023.md §6.2 — plumbing read needed by the confirm
// callback handler: given the WITHDRAWN registration's own id (already in
// scope from the callback_data match), resolve its eventId so the promotion
// notification can fetch that event's title/date-time. Plain read, no lock —
// the authoritative writes have already committed by the time this runs.
export async function getEventIdForRegistration(
  db: DbClient["db"],
  registrationId: string,
): Promise<string | null> {
  const rows = await db
    .select({ eventId: registrations.eventId })
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .limit(1);
  return rows[0]?.eventId ?? null;
}

// ---------------------------------------------------------------------------
// docs/agents/design/REQ-024.md §1 — getMyRegistrations: the caller's own
// registrations, every admission state, no filter beyond ownership (§0.3).
// One SELECT, two joins (registrations -> events -> chapters), the same
// two-join shape getEventByIdWithChapterTimezone already uses (REQ-017 §2.2),
// applied per-registration here. `userId` is the ONLY parameter -- no
// eventId/registrationId or any other caller-suppliable identifier appears
// anywhere in this signature, making the privacy scoping structural (§0.3
// point 2). Ordered by registrations.created_at DESC (most recent first) —
// no acceptance criterion specifies an ordering; this is the simplest one
// that needs no extra join or derived value (design §1).
// ---------------------------------------------------------------------------
export interface MyRegistrationListItem {
  registrationId: string;
  eventId: string;
  eventTitle: string;
  admission: AdmissionState;
  checkedInAt: Date | null;
  qrToken: string | null;
  startsAt: Date;
  endsAt: Date;
  chapterTimezone: string;
}

export async function getMyRegistrations(
  db: DbClient["db"],
  userId: string,
): Promise<MyRegistrationListItem[]> {
  const rows = await db
    .select({
      registrationId: registrations.id,
      eventId: events.id,
      eventTitle: events.title,
      admission: registrations.admission,
      checkedInAt: registrations.checkedInAt,
      qrToken: registrations.qrToken,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      chapterTimezone: chapters.timezone,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .innerJoin(chapters, eq(chapters.id, events.chapterId))
    .where(eq(registrations.userId, userId))
    .orderBy(desc(registrations.createdAt));

  return rows.map((row) => ({
    registrationId: row.registrationId,
    eventId: row.eventId,
    eventTitle: row.eventTitle,
    admission: row.admission as AdmissionState,
    checkedInAt: row.checkedInAt,
    qrToken: row.qrToken,
    startsAt: row.startsAt as Date,
    endsAt: row.endsAt as Date,
    chapterTimezone: row.chapterTimezone,
  }));
}

export async function getRegistrationForEventAndUser(
  db: DbClient["db"],
  eventId: string,
  userId: string,
): Promise<RegistrationForEventAndUser | null> {
  const rows = await db
    .select({
      id: registrations.id,
      admission: registrations.admission,
      checkedInAt: registrations.checkedInAt,
    })
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    admission: row.admission as AdmissionState,
    checkedInAt: row.checkedInAt,
  };
}
