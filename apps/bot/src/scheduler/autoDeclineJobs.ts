import { and, eq, isNotNull, isNull, lte, or } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { events, registrations } from "../db/schema.js";
import {
  sendLedgeredNotification,
  type ComposedMessage,
  type NotificationSender,
} from "../domain/notification.js";
import { autoDeclineRequest } from "../domain/registration.js";
import { getEventById } from "../domain/event.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import type { ScheduledJobDefinition } from "./runner.js";

// docs/agents/design/REQ-036.md §3 — the registration-close auto-decline
// job. Framework-free (decisions/0004): no grammy import anywhere in this
// file. Every time-dependent predicate takes evaluationTime as an explicit
// parameter (decisions/0006) — this file never calls SQL now()/
// current_timestamp inside a predicate.

export interface AutoDeclineCandidate {
  registrationId: string;
  eventId: string;
}

// §3.2 — same reasoning as urgencyJobs.ts's own CATCH_UP_WINDOW_MS, kept as
// this file's own module constant (not shared) per this codebase's existing
// convention of each scheduler file owning its own identically-reasoned
// constant.
const CATCH_UP_WINDOW_MS = 2 * 60 * 60 * 1000;

// §3.2 — selection condition, stated exactly:
// - registrations.admission = 'requested'
// - events.status = 'published'
// - close instant reached (§3.1's ends_at fallback when registrationClosesAt
//   is NULL):
//   (registrationClosesAt IS NOT NULL AND registrationClosesAt <= evaluationTime)
//   OR (registrationClosesAt IS NULL AND endsAt <= evaluationTime)
// - not stale: the relevant close instant (whichever branch matched) is
//   still within CATCH_UP_WINDOW_MS of evaluationTime.
export async function selectRegistrationsForAutoDecline(
  db: DbClient["db"],
  evaluationTime: Date,
): Promise<AutoDeclineCandidate[]> {
  const windowStart = new Date(evaluationTime.getTime() - CATCH_UP_WINDOW_MS);

  const rows = await db
    .select({
      registrationId: registrations.id,
      eventId: registrations.eventId,
      registrationClosesAt: events.registrationClosesAt,
      endsAt: events.endsAt,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .where(
      and(
        eq(registrations.admission, "requested"),
        eq(events.status, "published"),
        or(
          and(isNotNull(events.registrationClosesAt), lte(events.registrationClosesAt, evaluationTime)),
          and(isNull(events.registrationClosesAt), lte(events.endsAt, evaluationTime)),
        ),
      ),
    );

  // The catch-up (not-stale) clause needs whichever close instant actually
  // matched (registrationClosesAt or the endsAt fallback) — applied here in
  // JS rather than as a third SQL branch, since the "relevant" column
  // differs per row and drizzle has no CASE-based column selection this
  // codebase already uses elsewhere.
  return rows
    .filter((row) => {
      const closeInstant = row.registrationClosesAt ?? row.endsAt;
      return closeInstant.getTime() > windowStart.getTime();
    })
    .map((row) => ({ registrationId: row.registrationId, eventId: row.eventId }));
}

// §3.5 — the notification: honest, blame-free (STORY-DETAILS B6's "honest
// message"), reuses catalog.event.deepLinkSeeUpcoming unchanged (REQ-035
// §0.4's onward-path decision, inherited not re-decided here).
async function composeAutoDeclineNotice(
  db: DbClient["db"],
  eventId: string,
  lang: BotLang,
): Promise<ComposedMessage> {
  const catalog = getCatalog(lang);
  const event = await getEventById(db, eventId);
  const eventTitle = event?.title ?? "";

  const text = [
    catalog.autoDecline.notification.replace("{event}", eventTitle),
    catalog.event.deepLinkSeeUpcoming,
  ].join("\n");

  return { kind: "text", text };
}

// §3.6 — the job definition. `outcome.kind !== "reject"` (the row was
// already decided by an organizer or a prior tick, Mechanism 2 in action)
// moves to the next candidate with no notification call at all — no ledger
// row is written for a registration whose state never actually transitioned
// here.
export function makeAutoDeclineJob(
  db: DbClient["db"],
  sender: NotificationSender,
  intervalMs: number,
): ScheduledJobDefinition {
  return {
    name: "registrationAutoDecline",
    intervalMs,
    async run(evaluationTime: Date): Promise<void> {
      const candidates = await selectRegistrationsForAutoDecline(db, evaluationTime);
      for (const candidate of candidates) {
        const outcome = await autoDeclineRequest(db, candidate.registrationId, evaluationTime);
        if (outcome.kind !== "reject" || outcome.userId === undefined) {
          continue;
        }
        const eventId = outcome.eventId ?? candidate.eventId;
        await sendLedgeredNotification({
          db,
          sender,
          registrationId: candidate.registrationId,
          kind: "registration_auto_declined",
          classification: "transactional",
          userId: outcome.userId,
          composeMessage: (lang) => composeAutoDeclineNotice(db, eventId, lang),
        });
      }
    },
  };
}
