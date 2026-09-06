import type { DbClient } from "../db/client.js";
import { auditLog } from "../db/schema.js";

// REQ-015 §6 — reused by every later requirement that writes audit rows, not
// just this one. Framework-free (decisions/0004).
//
// Exactly-once discipline (S8, AC5): this function is never called directly
// by a handler. It is called exactly once, from inside each mutation
// function (createVenue/updateVenue/deleteVenue and, later, other entities'
// mutation functions), in the SAME db.transaction(...) as the row mutation
// itself, so:
// - never on a refusal: the authorization/pre-condition checks return before
//   the mutation function (and therefore this write) is ever reached;
// - never twice: there is exactly one call site per successful operation;
// - atomic: if this insert fails, the transaction rolls back the mutation
//   too — never a changed row with zero audit rows.
export interface WriteAuditLogInput {
  actorUserId: string; // never null here — every venue mutation has an authenticated actor
  action: string; // e.g. "venue.create" | "venue.update" | "venue.delete"
  entity: string; // e.g. "venue"
  entityId: string;
  payload: Record<string, unknown> | null;
  // Caller-supplied evaluation time (decisions/0006), not defaultNow() — lets
  // a test control and assert the exact stored value, matching
  // recordConsent's own pattern (domain/consent.ts).
  at: Date;
}

// `db` here is typed loosely as DbClient["db"] but is called with either the
// top-level db client or a db.transaction(...) callback's `tx` argument —
// both expose the same drizzle query-builder surface this function uses.
export async function writeAuditLog(
  db: DbClient["db"],
  input: WriteAuditLogInput,
): Promise<void> {
  await db.insert(auditLog).values({
    actorUserId: input.actorUserId,
    action: input.action,
    entity: input.entity,
    entityId: input.entityId,
    payload: input.payload,
    at: input.at,
  });
}
