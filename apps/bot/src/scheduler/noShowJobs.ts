import { and, eq, gt, isNotNull, isNull, lte } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { events, registrations } from "../db/schema.js";
import {
  sendLedgeredNotification,
  type ComposedMessage,
  type NotificationButton,
  type NotificationSender,
} from "../domain/notification.js";
import {
  getRegistrationNoShowContext,
  isNoShow,
  NO_SHOW_REASON_CODES,
} from "../domain/registration.js";
import { getEventById } from "../domain/event.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import type { ScheduledJobDefinition } from "./runner.js";

// docs/agents/design/REQ-032.md §3 — the single T-relative-time job (the
// fourth and final Release-1 consumer of scheduler/runner.ts). Unlike
// REQ-031's request+reminder pair, this requirement needs exactly ONE job —
// there is no second, reminder job (STORY-DETAILS D3's own refusal of
// reminding, AC3). Framework-free (decisions/0004): no grammy import
// anywhere in this file. Every time-dependent predicate takes
// evaluationTime as an explicit parameter (decisions/0006) — this file
// never calls SQL now()/current_timestamp inside a predicate.

export interface NoShowJobCandidate {
  registrationId: string;
  userId: string;
}

// §3.2/§8 open question 2 — same reasoning REQ-031 §5.2/§10 item 3 already
// states for its own analogous constant: a generous multiple of the job's
// own 5-minute polling interval, comfortably covering any realistic
// scheduler downtime without letting the backward-looking query grow
// unbounded over the project's lifetime.
const CATCH_UP_WINDOW_MS = 2 * 60 * 60 * 1000;

// §3.2 — selection condition, stated exactly. AC1's entire mechanism is the
// checked_in_at IS NULL / admission = 'admitted' / ends_at <= evaluationTime
// clauses together: a checked-in registration, or a non-admitted one, is
// never a candidate.
export async function selectRegistrationsForNoShowReasonRequest(
  db: DbClient["db"],
  evaluationTime: Date,
): Promise<NoShowJobCandidate[]> {
  const windowStart = new Date(evaluationTime.getTime() - CATCH_UP_WINDOW_MS);

  const rows = await db
    .select({
      registrationId: registrations.id,
      userId: registrations.userId,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .where(
      and(
        isNull(registrations.checkedInAt),
        eq(registrations.admission, "admitted"),
        eq(events.status, "published"),
        isNotNull(events.endsAt),
        lte(events.endsAt, evaluationTime),
        gt(events.endsAt, windowStart),
      ),
    );

  return rows;
}

// §4.4's prompt keyboard — five fixed-reason buttons plus one "other"
// button. Longest instance ("noshow:reason:lost_interest:" + a 36-byte UUID)
// is exactly at, not over, Telegram's 64-byte callback_data cap.
function buildNoShowReasonButtons(registrationId: string, lang: BotLang): NotificationButton[] {
  const catalog = getCatalog(lang).noShow;
  const labels: Record<(typeof NO_SHOW_REASON_CODES)[number], string> = {
    work_ran_over: catalog.reasonWorkRanOver,
    illness: catalog.reasonIllness,
    forgot: catalog.reasonForgot,
    transport: catalog.reasonTransport,
    lost_interest: catalog.reasonLostInterest,
  };
  const buttons: NotificationButton[] = NO_SHOW_REASON_CODES.map((code) => ({
    label: labels[code],
    callbackData: `noshow:reason:${code}:${registrationId}`,
  }));
  buttons.push({
    label: catalog.otherLabel,
    callbackData: `noshow:other:${registrationId}`,
  });
  return buttons;
}

// §3.4 — the at-send-time recheck. Re-verifies §1's own isNoShow derivation
// directly at send time, not merely trusting the selection query, and
// re-checks that no answer already exists (defensive — unreachable in
// practice for this single-send job, same convention REQ-016/018/029/030/031
// already document explicitly).
async function composeNoShowReasonRequest(
  db: DbClient["db"],
  registrationId: string,
  lang: BotLang,
  evaluationTime: Date,
): Promise<ComposedMessage> {
  const context = await getRegistrationNoShowContext(db, registrationId);
  if (context === null || context.admission !== "admitted" || context.checkedInAt !== null) {
    return { kind: "skip" };
  }

  const event = await getEventById(db, context.eventId);
  if (event === null || event.status !== "published") {
    return { kind: "skip" };
  }

  if (!isNoShow(context.admission, context.checkedInAt, event.endsAt, evaluationTime)) {
    return { kind: "skip" };
  }

  if (context.noShowReason !== null) {
    return { kind: "skip" };
  }

  return {
    kind: "text",
    text: getCatalog(lang).noShow.prompt,
    buttons: buildNoShowReasonButtons(registrationId, lang),
  };
}

// §3.3 — the job definition. classification: "transactional" is what
// satisfies AC6 structurally: sendLedgeredNotification never reads
// broadcastOptIn for a transactional send.
export function makeNoShowReasonRequestJob(
  db: DbClient["db"],
  sender: NotificationSender,
  intervalMs: number,
): ScheduledJobDefinition {
  return {
    name: "noShowReasonRequest",
    intervalMs,
    async run(evaluationTime: Date): Promise<void> {
      const candidates = await selectRegistrationsForNoShowReasonRequest(db, evaluationTime);
      for (const candidate of candidates) {
        await sendLedgeredNotification({
          db,
          sender,
          registrationId: candidate.registrationId,
          kind: "no_show_reason_request",
          classification: "transactional",
          userId: candidate.userId,
          composeMessage: (lang) =>
            composeNoShowReasonRequest(db, candidate.registrationId, lang, evaluationTime),
        });
      }
    },
  };
}
