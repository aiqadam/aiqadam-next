import { and, eq, gt, lte } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { events, registrations } from "../db/schema.js";

// docs/agents/design/REQ-026.md §3.1 — candidate selection for the T-24h and
// T-3h reminder jobs. Framework-free (decisions/0004): no grammy import
// anywhere in this file. Evaluation-time-as-parameter (decisions/0006) —
// neither query ever calls SQL now()/current_timestamp.
//
// Both are a selection WINDOW, not a single-instant match — deliberately
// over-inclusive. `sendLedgeredNotification`'s UNIQUE(registration_id, kind)
// ledger constraint is what actually enforces "sent at most once"; this
// query's only job is "don't miss the window."

export interface ReminderCandidate {
  registrationId: string;
  userId: string;
}

const HOURS_24_MS = 24 * 60 * 60 * 1000;
const HOURS_3_MS = 3 * 60 * 60 * 1000;

async function selectRegistrationsForReminderWindow(
  db: DbClient["db"],
  evaluationTime: Date,
  windowMs: number,
): Promise<ReminderCandidate[]> {
  const windowEnd = new Date(evaluationTime.getTime() + windowMs);
  const rows = await db
    .select({
      registrationId: registrations.id,
      userId: registrations.userId,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .where(
      and(
        eq(registrations.admission, "admitted"),
        eq(events.status, "published"),
        gt(events.startsAt, evaluationTime),
        lte(events.startsAt, windowEnd),
      ),
    );

  return rows;
}

export async function selectRegistrationsForReminder24h(
  db: DbClient["db"],
  evaluationTime: Date,
): Promise<ReminderCandidate[]> {
  return selectRegistrationsForReminderWindow(db, evaluationTime, HOURS_24_MS);
}

export async function selectRegistrationsForReminder3h(
  db: DbClient["db"],
  evaluationTime: Date,
): Promise<ReminderCandidate[]> {
  return selectRegistrationsForReminderWindow(db, evaluationTime, HOURS_3_MS);
}
