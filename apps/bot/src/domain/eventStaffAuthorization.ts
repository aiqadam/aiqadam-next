import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { users } from "../db/schema.js";
import { writeAuditLog, type WriteAuditLogInput } from "./auditLog.js";
import { getEventStaffRow, type EventStaffRow } from "./eventStaff.js";
import { isFinished } from "./event.js";

// REQ-018 §0.2/§3 — the check-in authorization gate. Parallel-copy shape per
// REQ-015/016's venueAuthorization.ts/eventAuthorization.ts precedent, but a
// genuinely different predicate: existence of an event_staff row for this
// exact (event_id, user_id) pair, plus the event not yet having ended. NO
// role short-circuit — being organizer/owner grants no check-in rights by
// itself (PRD 3: rights are "for that one event, nothing else," not a role).

export interface ActingUser {
  id: string;
  role: "member" | "organizer" | "owner";
  chapterId: string | null;
}

// Resolves ctx.from.id -> users.id/role/chapter_id. Same discipline as the
// other two authorization modules: tg_id is used only in this one lookup's
// WHERE clause; every later reference is user.id. `role` is read here only
// because ActingUser's shape is copied whole for consistency with the other
// two authorization modules (design §3.1) — §3.2's predicate never inspects
// it; it structurally cannot (PRD 3's "for that one event, nothing else").
export async function resolveActingUser(
  db: DbClient["db"],
  tgId: bigint,
): Promise<ActingUser | null> {
  const rows = await db
    .select({ id: users.id, role: users.role, chapterId: users.chapterId })
    .from(users)
    .where(eq(users.tgId, tgId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    role: row.role as ActingUser["role"],
    chapterId: row.chapterId,
  };
}

export type CheckInAuthorizationResult =
  | { ok: true }
  | { ok: false; reason: "no-user" | "not-staff-for-event" | "event-ended" };

// Pure predicate over already-resolved data — no I/O, unit-testable without
// a DB. Logic stated exactly per design §3.2 so it cannot be reinterpreted:
//
// 1. user === null                        -> { ok: false, reason: "no-user" }
// 2. staffRow === null (no event_staff row
//    for this exact (eventId, user.id) pair,
//    covers both "never staffed" and
//    "staffed for a different event")      -> { ok: false, reason: "not-staff-for-event" }
// 3. isFinished(eventEndsAt, evaluationTime)
//    (evaluationTime strictly after
//    eventEndsAt)                          -> { ok: false, reason: "event-ended" }
// 4. none of the above                     -> { ok: true }
//
// No step ever inspects user.role.
export function checkEventStaffAuthorization(
  user: ActingUser | null,
  staffRow: EventStaffRow | null,
  eventEndsAt: Date,
  evaluationTime: Date,
): CheckInAuthorizationResult {
  if (user === null) {
    return { ok: false, reason: "no-user" };
  }
  if (staffRow === null) {
    return { ok: false, reason: "not-staff-for-event" };
  }
  if (isFinished(eventEndsAt, evaluationTime)) {
    return { ok: false, reason: "event-ended" };
  }
  return { ok: true };
}

// SECURITY-REVIEWER Step 2c FAIL (S5, handoffs/WF02-REQ-018/step-02c-security-reviewer.json):
// every refusal branch of the check-in authorization gate (no-user,
// not-staff-for-event, event-ended) writes no AuditLog row, even though
// /checkin is a live, reachable command today. S5's negative case names this
// exactly: "the non-staff refusal that returns an error but writes no audit
// row -- the one case where the log matters most is an attempted
// unauthorized scan." Pure-function shape kept separate from the DB write
// itself (same discipline as checkEventStaffAuthorization above) so the
// payload/actor-resolution logic is unit-testable without a DB — only the
// single writeAuditLog call in requireEventStaffForEvent below needs a live
// DB to exercise.
//
// No audit row is written on the ok=true branch: S5's table only requires a
// log on a refusal ("scanner is not staff"); authorization succeeding here
// is not itself a status change (S8) and discloses nothing (S3) — the stub
// performs no check-in write of its own (design §0.3), so there is nothing
// yet to log on success. Adding one would be inventing a business rule the
// design/S5 does not ask for.
export function buildCheckinRefusalAudit(
  user: ActingUser | null,
  eventId: string,
  reason: Extract<CheckInAuthorizationResult, { ok: false }>["reason"],
): Omit<WriteAuditLogInput, "at"> {
  return {
    // null exactly when resolveActingUser found no User row at all
    // ("no-user") — there is no actor to attribute the attempt to. The
    // schema's own actor_user_id column is nullable for precisely this
    // reason (db/schema.ts).
    actorUserId: user === null ? null : user.id,
    action: "checkin.refused",
    entity: "event",
    entityId: eventId,
    // No PII (S11): eventId is already a non-secret identifier (matches
    // checkin.ts's own "not-found before authorization" precedent), and
    // `reason` is one of the three fixed CheckInAuthorizationResult strings
    // — never a free-text or user-supplied value.
    payload: { reason },
  };
}

// Composed entry point — the single function handlers/checkin.ts calls. No
// handler ever calls checkEventStaffAuthorization directly, the same "one
// composed entry point per handler" discipline requireOrganizerForChapter
// already established. Writing the audit row here (not duplicated in
// checkin.ts) means every future caller of this gate gets S5 coverage
// uniformly, per the security finding's own suggested alternative.
export async function requireEventStaffForEvent(
  db: DbClient["db"],
  tgId: bigint,
  eventId: string,
  eventEndsAt: Date,
  evaluationTime: Date,
): Promise<CheckInAuthorizationResult> {
  const user = await resolveActingUser(db, tgId);
  const staffRow = user === null ? null : await getEventStaffRow(db, eventId, user.id);
  const result = checkEventStaffAuthorization(user, staffRow, eventEndsAt, evaluationTime);
  if (!result.ok) {
    await writeAuditLog(db, {
      ...buildCheckinRefusalAudit(user, eventId, result.reason),
      at: evaluationTime,
    });
  }
  return result;
}
