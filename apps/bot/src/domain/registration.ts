import { randomBytes } from "node:crypto";
import { and, eq, lt, or } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { events, registrations, users } from "../db/schema.js";
import { writeAuditLog } from "./auditLog.js";
import { computeSeatsLeft, getPendingSource, isFinished, isRegistrationOpen } from "./event.js";

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
    const existingRows = await tx
      .select({ admission: registrations.admission })
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)))
      .limit(1);
    const existingAdmission = (existingRows[0]?.admission as AdmissionState | undefined) ?? null;

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

    const insertedRow = inserted[0];
    if (insertedRow === undefined) {
      // Unreachable in practice: RETURNING on a successful INSERT always
      // yields exactly one row (same no-speculation guard createEvent/
      // createVenue already establish elsewhere in this codebase).
      throw new Error("registerForEvent: insert returned no row");
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
