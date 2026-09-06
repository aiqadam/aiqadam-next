import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { eventStaff } from "../db/schema.js";
import { writeAuditLog } from "./auditLog.js";

// REQ-018 §2 — EventStaff assign/remove domain logic. Framework-free
// (decisions/0004): no grammY import anywhere in this file. No schema change
// (design §1) — `event_staff` is used as-is; removal is a hard DELETE, the
// historical record lives entirely in `audit_log`.

// ---------------------------------------------------------------------------
// §2.1 — parseStaffCommandArgs: first two non-blank, whitespace-separated
// tokens. First = eventId (trimmed). Second = tgUsername (trimmed, one
// leading '@' stripped if present). Any further tokens are ignored. No
// case-folding (design §6.2 open question).
// ---------------------------------------------------------------------------
export interface ParsedStaffCommand {
  eventId: string;
  tgUsername: string;
}

export function parseStaffCommandArgs(text: string): ParsedStaffCommand | null {
  const tokens = text.split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length < 2) {
    return null;
  }
  const eventId = (tokens[0] as string).trim();
  let tgUsername = (tokens[1] as string).trim();
  if (tgUsername.startsWith("@")) {
    tgUsername = tgUsername.slice(1);
  }
  return { eventId, tgUsername };
}

// ---------------------------------------------------------------------------
// §2.3 — getEventStaffRow: existence check by exact (eventId, userId) pair.
// Used by (a) assign's "already assigned" pre-check, (b) remove's "not
// assigned" pre-check and delete-snapshot source, (c) the check-in
// authorization gate's existence check (eventStaffAuthorization.ts).
// ---------------------------------------------------------------------------
export interface EventStaffRow {
  id: string;
  eventId: string;
  userId: string;
}

export async function getEventStaffRow(
  db: DbClient["db"],
  eventId: string,
  userId: string,
): Promise<EventStaffRow | null> {
  const rows = await db
    .select({
      id: eventStaff.id,
      eventId: eventStaff.eventId,
      userId: eventStaff.userId,
    })
    .from(eventStaff)
    .where(and(eq(eventStaff.eventId, eventId), eq(eventStaff.userId, userId)))
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// §2.4 — addEventStaff: one INSERT + one AuditLog row, one transaction.
// Mirrors createVenue/createEvent's shape exactly. The caller is responsible
// for the "already assigned" pre-check (getEventStaffRow) BEFORE calling
// this — this function does not re-derive its own callers' pre-conditions.
// ---------------------------------------------------------------------------
export async function addEventStaff(
  db: DbClient["db"],
  actorUserId: string,
  eventId: string,
  targetUserId: string,
  eventTitle: string,
  at: Date,
): Promise<string> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(eventStaff)
      .values({ eventId, userId: targetUserId })
      .returning({ id: eventStaff.id });

    const row = rows[0];
    if (row === undefined) {
      // Unreachable in practice: RETURNING on a successful INSERT always
      // yields exactly one row (no-speculation guard, same discipline as
      // createVenue/createEvent).
      throw new Error("addEventStaff: insert returned no row");
    }

    await writeAuditLog(tx, {
      actorUserId,
      action: "event_staff.add",
      entity: "event_staff",
      entityId: row.id,
      payload: { eventId, targetUserId, eventTitle },
      at,
    });

    return row.id;
  });
}

// ---------------------------------------------------------------------------
// §2.4 — removeEventStaff: one DELETE + one AuditLog row, one transaction.
// Mirrors deleteVenue's hard-delete-with-audit-snapshot shape exactly.
// `staffRowSnapshot` is captured by the caller BEFORE this call, from the
// same getEventStaffRow read used for the "not assigned" pre-check, since
// the row no longer exists to read from afterward.
// ---------------------------------------------------------------------------
export async function removeEventStaff(
  db: DbClient["db"],
  actorUserId: string,
  staffRowSnapshot: EventStaffRow,
  eventTitle: string,
  at: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(eventStaff).where(eq(eventStaff.id, staffRowSnapshot.id));

    await writeAuditLog(tx, {
      actorUserId,
      action: "event_staff.remove",
      entity: "event_staff",
      entityId: staffRowSnapshot.id,
      payload: {
        eventId: staffRowSnapshot.eventId,
        userId: staffRowSnapshot.userId,
        eventTitle,
      },
      at,
    });
  });
}
