import { and, eq, gt, isNotNull, lte, notInArray } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { events, feedback, registrations } from "../db/schema.js";
import {
  sendLedgeredNotification,
  type ComposedMessage,
  type NotificationButton,
  type NotificationSender,
} from "../domain/notification.js";
import { getRegistrationFeedbackContext } from "../domain/registration.js";
import { getEventById } from "../domain/event.js";
import { getFeedbackByRegistrationId } from "../domain/feedback.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import type { ScheduledJobDefinition } from "./runner.js";

// docs/agents/design/REQ-031.md §5 — the T+2h feedback-request job and the
// T+24h reminder job. Framework-free aside from the ScheduledJobDefinition
// shape itself (no grammy import), mirroring scheduler/reminderJobs.ts's own
// shape. Every time-dependent predicate takes evaluationTime as an explicit
// parameter (decisions/0006) — this file never calls SQL now()/
// current_timestamp inside a predicate.

export interface FeedbackJobCandidate {
  registrationId: string;
  userId: string;
}

const HOURS_2_MS = 2 * 60 * 60 * 1000;
const HOURS_24_MS = 24 * 60 * 60 * 1000;
// §5.2/§10 open question 3 — a generous multiple of the job's own 5-minute
// polling interval (REQ-025 §7/this design's own §5.7), comfortably covering
// any realistic scheduler downtime without letting the backward-looking
// query grow unbounded over the project's lifetime.
const CATCH_UP_WINDOW_MS = 2 * 60 * 60 * 1000;

// §5.2 — selection condition for the T+2h feedback request. AC1's entire
// mechanism is the checked_in_at IS NOT NULL clause: an admitted-but-never-
// checked-in registration is excluded by construction.
export async function selectRegistrationsForFeedbackRequest(
  db: DbClient["db"],
  evaluationTime: Date,
): Promise<FeedbackJobCandidate[]> {
  const windowEnd = new Date(evaluationTime.getTime() - HOURS_2_MS);
  const windowStart = new Date(windowEnd.getTime() - CATCH_UP_WINDOW_MS);

  const rows = await db
    .select({
      registrationId: registrations.id,
      userId: registrations.userId,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .where(
      and(
        isNotNull(registrations.checkedInAt),
        eq(events.status, "published"),
        isNotNull(events.endsAt),
        lte(events.endsAt, windowEnd),
        gt(events.endsAt, windowStart),
      ),
    );

  return rows;
}

// §5.3 — selection condition for the T+24h reminder: identical shape to
// §5.2, with the elapsed-time threshold widened to 24h and an additional
// NOT EXISTS clause excluding anyone who already has a feedback row (they
// engaged, so they did not "ignore the request" — §5.3's own named reading).
export async function selectRegistrationsForFeedbackReminder(
  db: DbClient["db"],
  evaluationTime: Date,
): Promise<FeedbackJobCandidate[]> {
  const windowEnd = new Date(evaluationTime.getTime() - HOURS_24_MS);
  const windowStart = new Date(windowEnd.getTime() - CATCH_UP_WINDOW_MS);

  const existingFeedbackRegistrationIds = db
    .select({ registrationId: feedback.registrationId })
    .from(feedback);

  const rows = await db
    .select({
      registrationId: registrations.id,
      userId: registrations.userId,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .where(
      and(
        isNotNull(registrations.checkedInAt),
        eq(events.status, "published"),
        isNotNull(events.endsAt),
        lte(events.endsAt, windowEnd),
        gt(events.endsAt, windowStart),
        notInArray(registrations.id, existingFeedbackRegistrationIds),
      ),
    );

  return rows;
}

// §3.2 — the NPS prompt: eleven buttons, labels "0" through "10", no Skip
// button anywhere (§1.3/§2.1 — nps is the only unskippable question, made
// structural by there being no Skip affordance of any kind on this step).
function buildNpsButtons(registrationId: string): NotificationButton[] {
  const buttons: NotificationButton[] = [];
  for (let value = 0; value <= 10; value += 1) {
    buttons.push({
      label: String(value),
      callbackData: `feedback:nps:${value}:${registrationId}`,
    });
  }
  return buttons;
}

// §5.4 step 1-4 / §5.5 — shared compose logic for both jobs. `promptText` is
// the only difference between the T+2h request and the T+24h reminder (the
// reminder prepends catalog.feedback.reminderPrefix, §5.5) — everything else
// (the at-send-time rechecks) is identical.
async function composeFeedbackNpsPrompt(
  db: DbClient["db"],
  registrationId: string,
  lang: BotLang,
  withReminderPrefix: boolean,
): Promise<ComposedMessage> {
  const catalog = getCatalog(lang);

  // §5.4 step 1 — the at-send-time recheck this codebase's existing jobs
  // already perform (REQ-026 §5.1/§5.2's own composeReminder24h/3h).
  const context = await getRegistrationFeedbackContext(db, registrationId);
  if (context === null || context.admission !== "admitted" || context.checkedInAt === null) {
    return { kind: "skip" };
  }

  // §5.4 step 2.
  const event = await getEventById(db, context.eventId);
  if (event === null || event.status !== "published") {
    return { kind: "skip" };
  }

  // §5.4 step 3 / §5.5 — a feedback row already exists (NPS already
  // answered through some other path, or between selection and send): this
  // job's only job is to START the flow, so there is nothing left to send.
  const existingFeedback = await getFeedbackByRegistrationId(db, registrationId);
  if (existingFeedback !== null) {
    return { kind: "skip" };
  }

  const text = withReminderPrefix
    ? `${catalog.feedback.reminderPrefix}${catalog.feedback.npsPrompt}`
    : catalog.feedback.npsPrompt;

  return {
    kind: "text",
    text,
    buttons: buildNpsButtons(registrationId),
  };
}

// §5.4 — the T+2h job. `classification: "transactional"` is what satisfies
// AC7 structurally: sendLedgeredNotification never reads broadcastOptIn for
// a transactional send.
export function makeFeedbackRequestJob(
  db: DbClient["db"],
  sender: NotificationSender,
  intervalMs: number,
): ScheduledJobDefinition {
  return {
    name: "feedbackRequest",
    intervalMs,
    async run(evaluationTime: Date): Promise<void> {
      const candidates = await selectRegistrationsForFeedbackRequest(db, evaluationTime);
      for (const candidate of candidates) {
        await sendLedgeredNotification({
          db,
          sender,
          registrationId: candidate.registrationId,
          kind: "feedback_request",
          classification: "transactional",
          userId: candidate.userId,
          composeMessage: (lang) =>
            composeFeedbackNpsPrompt(db, candidate.registrationId, lang, false),
        });
      }
    },
  };
}

// §5.5 — the T+24h job. Distinct NotificationKind ("feedback_reminder") is
// the entire mechanism behind AC4's "exactly one reminder, nothing
// thereafter" together with sendLedgeredNotification's own
// UNIQUE(registration_id, kind) ledger constraint (REQ-025).
export function makeFeedbackReminderJob(
  db: DbClient["db"],
  sender: NotificationSender,
  intervalMs: number,
): ScheduledJobDefinition {
  return {
    name: "feedbackReminder",
    intervalMs,
    async run(evaluationTime: Date): Promise<void> {
      const candidates = await selectRegistrationsForFeedbackReminder(db, evaluationTime);
      for (const candidate of candidates) {
        await sendLedgeredNotification({
          db,
          sender,
          registrationId: candidate.registrationId,
          kind: "feedback_reminder",
          classification: "transactional",
          userId: candidate.userId,
          composeMessage: (lang) =>
            composeFeedbackNpsPrompt(db, candidate.registrationId, lang, true),
        });
      }
    },
  };
}
