import { and, eq, gt, lte } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { events, registrations } from "../db/schema.js";
import {
  sendLedgeredNotification,
  type ComposedMessage,
  type NotificationSender,
} from "../domain/notification.js";
import { getEventById } from "../domain/event.js";
import { getPrimaryOrganizerIdForChapter, getRegistrationAdmissionAndEvent } from "../domain/registration.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import type { ScheduledJobDefinition } from "./runner.js";

// docs/agents/design/REQ-036.md §2 — the T-48h urgency job. Framework-free
// (decisions/0004): no grammy import anywhere in this file. Every
// time-dependent predicate takes evaluationTime as an explicit parameter
// (decisions/0006) — this file never calls SQL now()/current_timestamp
// inside a predicate.

export interface UrgentRequestCandidate {
  registrationId: string;
  eventId: string;
  chapterId: string;
}

const URGENCY_WINDOW_MS = 48 * 60 * 60 * 1000;
// §2.1 — same reasoning noShowJobs.ts/feedbackJobs.ts already state for their
// own identical constant: a generous multiple of the job's own polling
// interval, comfortably covering any realistic scheduler downtime without
// letting the backward-looking query grow unbounded.
const CATCH_UP_WINDOW_MS = 2 * 60 * 60 * 1000;

// §2.1 — selection condition, stated exactly (restated as a direct
// comparison against events.startsAt, the same "JS-computed bound compared
// directly against the timestamp column" convention domain/reminders.ts's
// own selectRegistrationsForReminderWindow already establishes, rather than
// pushing date arithmetic into SQL):
// - registrations.admission = 'requested'
// - events.status = 'published'
// - events.startsAt - 48h <= evaluationTime, i.e. startsAt <= evaluationTime + 48h
//   (trigger instant reached)
// - events.startsAt - 48h > evaluationTime - CATCH_UP_WINDOW_MS, i.e.
//   startsAt > evaluationTime - CATCH_UP_WINDOW_MS + 48h (not stale)
export async function selectRegistrationsForUrgencyNotice(
  db: DbClient["db"],
  evaluationTime: Date,
): Promise<UrgentRequestCandidate[]> {
  const upperBound = new Date(evaluationTime.getTime() + URGENCY_WINDOW_MS);
  const lowerBound = new Date(evaluationTime.getTime() - CATCH_UP_WINDOW_MS + URGENCY_WINDOW_MS);

  const rows = await db
    .select({
      registrationId: registrations.id,
      eventId: registrations.eventId,
      chapterId: events.chapterId,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .where(
      and(
        eq(registrations.admission, "requested"),
        eq(events.status, "published"),
        lte(events.startsAt, upperBound),
        gt(events.startsAt, lowerBound),
      ),
    );

  return rows;
}

// §2.3 — the at-send-time recheck, same first-match-wins discipline
// composeNoShowReasonRequest/composeFeedbackNpsPrompt already use.
async function composeUrgencyNotice(
  db: DbClient["db"],
  registrationId: string,
  eventId: string,
  lang: BotLang,
): Promise<ComposedMessage> {
  const registration = await getRegistrationAdmissionAndEvent(db, registrationId);
  if (registration === null || registration.admission !== "requested") {
    return { kind: "skip" };
  }

  const event = await getEventById(db, eventId);
  if (event === null || event.status !== "published") {
    return { kind: "skip" };
  }

  const text = getCatalog(lang).organizerRequests.urgentNotification.replace("{event}", event.title);
  return { kind: "text", text };
}

// §2.5 — the job definition. Sent to exactly ONE organizer per candidate
// (§2.2's trace): getPrimaryOrganizerIdForChapter returning null means the
// candidate is skipped entirely — no sendLedgeredNotification call, no
// ledger row (design §7 open question 1).
export function makeUrgencyNoticeJob(
  db: DbClient["db"],
  sender: NotificationSender,
  intervalMs: number,
): ScheduledJobDefinition {
  return {
    name: "pendingRequestUrgencyNotice",
    intervalMs,
    async run(evaluationTime: Date): Promise<void> {
      const candidates = await selectRegistrationsForUrgencyNotice(db, evaluationTime);
      for (const candidate of candidates) {
        const organizerId = await getPrimaryOrganizerIdForChapter(db, candidate.chapterId);
        if (organizerId === null) {
          continue;
        }
        await sendLedgeredNotification({
          db,
          sender,
          registrationId: candidate.registrationId,
          kind: "pending_request_urgent",
          classification: "transactional",
          userId: organizerId,
          composeMessage: (lang) => composeUrgencyNotice(db, candidate.registrationId, candidate.eventId, lang),
        });
      }
    },
  };
}
