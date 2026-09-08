import { Bot } from "grammy";
import { loadConfig, type BotConfig } from "./config.js";
import { createDbClient } from "./db/client.js";
import { createLogger } from "./log.js";
import {
  makeChapterCallbackHandler,
  makeConsentCallbackHandler,
  makeStartHandler,
} from "./handlers/start.js";
import { makeHelpHandler } from "./handlers/help.js";
import { makeLangCallbackHandler, makeLangCommandHandler } from "./handlers/lang.js";
import {
  makeVenueDeleteHandler,
  makeVenueEditHandler,
  makeVenueNewHandler,
  makeVenuesListHandler,
} from "./handlers/venue.js";
import {
  makeEventAgendaHandler,
  makeEventCancelHandler,
  makeEventEditHandler,
  makeEventNewHandler,
  makeEventPublishHandler,
  makeEventsListHandler,
} from "./handlers/event.js";
import { makeStaffAddHandler, makeStaffRemoveHandler } from "./handlers/staff.js";
import {
  CHECKIN_PAGE_PATTERN,
  CHECKIN_TOGGLE_PATTERN,
  makeCheckInHandler,
  makeCheckinPageCallbackHandler,
  makeCheckinToggleCallbackHandler,
} from "./handlers/checkin.js";
import { CHECKIN_OVERRIDE_PATTERN, makeCheckinOverrideCallbackHandler } from "./handlers/checkinQr.js";
import {
  makeWalkinCancelCallbackHandler,
  makeWalkinCommandHandler,
  makeWalkinConfirmCallbackHandler,
  makeWalkinOverrideCallbackHandler,
  WALKIN_CONFIRM_PATTERN,
  WALKIN_OVERRIDE_PATTERN,
} from "./handlers/walkin.js";
import {
  makeProfileChapterCallbackHandler,
  makeProfileChapterHandler,
  makeProfileCommandHandler,
  makeProfileContactHandler,
  makeProfileEditHandler,
  makeProfileExperienceCallbackHandler,
  makeProfileSkipCallbackHandler,
  makeProfileStudentCallbackHandler,
  makeProfileTextAnswerHandler,
} from "./handlers/profile.js";
import { makeRegisterCallbackHandler, REGISTER_CALLBACK_PATTERN } from "./handlers/registration.js";
import {
  makeWithdrawCancelCallbackHandler,
  makeWithdrawCommandHandler,
  makeWithdrawConfirmCallbackHandler,
  WITHDRAW_CANCEL_PATTERN,
  WITHDRAW_CONFIRM_PATTERN,
} from "./handlers/withdraw.js";
import { makeMyCommandHandler } from "./handlers/my.js";
import {
  makeReminder24hConfirmCallbackHandler,
  makeReminder24hDeclineCallbackHandler,
  REMINDER24H_CONFIRM_PATTERN,
  REMINDER24H_DECLINE_PATTERN,
} from "./handlers/reminder24h.js";
import { createRateLimitedSender, DEFAULT_RATE_LIMITER_CONFIG } from "./scheduler/rateLimiter.js";
import { startScheduledJobs } from "./scheduler/runner.js";
import { makeReminder24hJob, makeReminder3hJob } from "./scheduler/reminderJobs.js";
import { makeFeedbackReminderJob, makeFeedbackRequestJob } from "./scheduler/feedbackJobs.js";
import {
  FEEDBACK_BROADCAST_PATTERN,
  FEEDBACK_NPS_PATTERN,
  makeFeedbackBroadcastCallbackHandler,
  makeFeedbackNpsCallbackHandler,
  makeFeedbackTextReplyHandler,
} from "./handlers/feedback.js";
import { makeNoShowReasonRequestJob } from "./scheduler/noShowJobs.js";
import { makeUrgencyNoticeJob } from "./scheduler/urgencyJobs.js";
import { makeAutoDeclineJob } from "./scheduler/autoDeclineJobs.js";
import {
  NO_SHOW_OTHER_PATTERN,
  NO_SHOW_REASON_PATTERN,
  makeNoShowOtherCallbackHandler,
  makeNoShowReasonCallbackHandler,
  makeNoShowTextReplyHandler,
} from "./handlers/noShow.js";
import {
  REQ_APPROVE_CANCEL_PATTERN,
  REQ_APPROVE_CONFIRM_PATTERN,
  REQ_APPROVE_PATTERN,
  REQ_OPEN_PATTERN,
  REQ_PAGE_PATTERN,
  REQ_REJECT_PATTERN,
  makeRequestApproveCancelCallbackHandler,
  makeRequestApproveCallbackHandler,
  makeRequestApproveConfirmCallbackHandler,
  makeRequestDetailCallbackHandler,
  makeRequestRejectCallbackHandler,
  makeRequestRejectTextReplyHandler,
  makeRequestsListHandler,
  makeRequestsPageCallbackHandler,
} from "./handlers/organizerRequests.js";

let config: BotConfig;

try {
  config = loadConfig(process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const log = createLogger(config.logLevel);

// Pool is constructed after loadConfig succeeds, before bot.start() (REQ-012
// §2.3). REQ-013 is the first requirement to consume `db` from this client.
const { db } = createDbClient(config.databaseUrl);

log.info("bot starting");

const bot = new Bot(config.botToken);

// REQ-025 §5/§7 — the one process-wide NotificationSender (rate-limited,
// 429-backoff) and the scheduled-job runner. Passed to every present and
// future call site that sends a ledgered notification.
const notificationSender = createRateLimitedSender(bot, DEFAULT_RATE_LIMITER_CONFIG);

// docs/agents/design/REQ-026.md §8 — a real sequencing fix: the T-3h job's
// QR image needs botUsername, which only exists once grammY has fetched the
// bot's own identity. `bot.init()` is awaited HERE, before
// startScheduledJobs (whose "immediate first run" rule, REQ-025 §7, could
// otherwise fire a job before bot.botInfo is populated), and before
// bot.start(). bot.init() resolves quickly (one getMe call), unlike
// bot.start() itself, which does not resolve during normal long-polling
// operation.
await bot.init();
const botUsername = bot.botInfo.username;

// REQ-026 §5 — the two reminder jobs, 5-minute tick interval (§5's own
// "technical scheduling parameter, not a product ambiguity" reasoning).
// REQ-031 §5.7 — the two feedback jobs, same 5-minute tick interval as
// every other scheduled job in this codebase.
startScheduledJobs([
  makeReminder24hJob(db, notificationSender, 300000),
  makeReminder3hJob(db, notificationSender, botUsername, 300000),
  makeFeedbackRequestJob(db, notificationSender, 300000),
  makeFeedbackReminderJob(db, notificationSender, 300000),
  // REQ-032 §3.5 — the single no-show reason-request job, the fourth and
  // final Release-1 consumer of scheduler/runner.ts, same 5-minute interval.
  makeNoShowReasonRequestJob(db, notificationSender, 300000),
  // REQ-036 §0.1/§2.5/§3.6 — the T-48h urgency job and the
  // registration-close auto-decline job, same 5-minute interval as every
  // other scheduled job in this codebase.
  makeUrgencyNoticeJob(db, notificationSender, 300000),
  makeAutoDeclineJob(db, notificationSender, 300000),
]);

bot.command("health", (ctx) => ctx.reply("ok"));

// REQ-013: /lang command (mechanism + inline-keyboard selection +
// persistence).
bot.command("lang", makeLangCommandHandler(db));
bot.callbackQuery(/^lang:(ru|en)$/, makeLangCallbackHandler(db));

// REQ-014: real /start (User creation, chapter assignment, consent gate),
// its two callback handlers, and /help.
bot.command("start", makeStartHandler(db));
bot.callbackQuery(/^chapter:(.+)$/, makeChapterCallbackHandler(db));
// WF02-REQ-016 SECURITY REWORK — the callback_data may now carry a deep-link
// payload appended after a `:` (see handlers/start.ts's own header note), so
// this needs a pattern, not the old exact string; the handler itself
// re-derives the exact match via its own regex against ctx.callbackQuery.data
// (same discipline as the chapter:<id> callback below).
bot.callbackQuery(/^consent:agree(?::.+)?$/, makeConsentCallbackHandler(db));
bot.command("help", makeHelpHandler(db));

// REQ-015: organizer-only venue CRUD, chapter-scoped.
bot.command("venue_new", makeVenueNewHandler(db));
bot.command("venue_edit", makeVenueEditHandler(db));
bot.command("venue_delete", makeVenueDeleteHandler(db));
bot.command("venues", makeVenuesListHandler(db));

// REQ-016: organizer-only event CRUD, chapter-scoped, draft/published/
// cancelled transitions, publish validation, agenda validation. The
// `?start=e_<id>[__channel]` deep link rides the existing /start
// registration above (handlers/start.ts) — no new command for it.
bot.command("event_new", makeEventNewHandler(db));
bot.command("event_edit", makeEventEditHandler(db));
bot.command("event_agenda", makeEventAgendaHandler(db));
bot.command("event_publish", makeEventPublishHandler(db));
// REQ-027 — cancellation notifies every non-withdrawn registrant, so
// makeEventCancelHandler now needs the process-wide notificationSender too
// (same single instance already passed to the reminder jobs and withdraw's
// confirm handler above).
bot.command("event_cancel", makeEventCancelHandler(db, notificationSender));

// REQ-017: /events — public, chapter-scoped upcoming-events list. Any
// member may run it (not organizer-gated, same precedent as /venues).
bot.command("events", makeEventsListHandler(db));

// REQ-018: organizer-only EventStaff assign/remove (chapter-scoped, reuses
// requireOrganizerForChapter unchanged), and the staff-only check-in
// authorization gate (domain/eventStaffAuthorization.ts — a genuinely
// different predicate, no role short-circuit).
bot.command("staff_add", makeStaffAddHandler(db));
bot.command("staff_remove", makeStaffRemoveHandler(db));
// REQ-028: /checkin <event_id> [query] now renders the manual check-in door
// list (design §4.1), plus its toggle and pagination callbacks.
bot.command("checkin", makeCheckInHandler(db));
bot.callbackQuery(CHECKIN_TOGGLE_PATTERN, makeCheckinToggleCallbackHandler(db));
bot.callbackQuery(CHECKIN_PAGE_PATTERN, makeCheckinPageCallbackHandler(db));

// REQ-029: `/start ci_<qr_token>` QR check-in deep link (dispatched from
// handlers/start.ts's makeStartHandler -- no new command registered here,
// AC7), plus the organizer-only checkin:override:<registrationId> callback.
bot.callbackQuery(CHECKIN_OVERRIDE_PATTERN, makeCheckinOverrideCallbackHandler(db));

// REQ-022: /withdraw <event_id> -- withdraw from a registration and free the
// seat, gated by a two-step confirm/cancel callback prompt. Registered here,
// alongside the other id-parameterized commands and before the message:text/
// message:contact generic listeners below, per this file's own ordering
// discipline for bot.command(...) registrations.
bot.command("withdraw", makeWithdrawCommandHandler(db));
bot.callbackQuery(WITHDRAW_CONFIRM_PATTERN, makeWithdrawConfirmCallbackHandler(db, notificationSender));
bot.callbackQuery(WITHDRAW_CANCEL_PATTERN, makeWithdrawCancelCallbackHandler(db));

// REQ-026: T-24h "Still coming?" reconfirmation callbacks.
bot.callbackQuery(REMINDER24H_CONFIRM_PATTERN, makeReminder24hConfirmCallbackHandler(db));
bot.callbackQuery(REMINDER24H_DECLINE_PATTERN, makeReminder24hDeclineCallbackHandler(db, notificationSender));

// REQ-019: profile capture as a resumable step-by-step form, the consent
// gate, and the optional-field rule (design §4). The two generic listeners
// (message:text, message:contact) MUST be registered after every
// bot.command(...) registration above — grammY's command matcher and this
// generic text listener both react to text messages, and a `/`-prefixed
// message is excluded by the listener's own guard (handlers/profile.ts
// §4.5 step 1), not by registration order, but registering the generic
// listeners last keeps every command handler's own dispatch unambiguous.
bot.command("profile", makeProfileCommandHandler(db));
bot.command("profile_edit", makeProfileEditHandler(db));
bot.command("profile_chapter", makeProfileChapterHandler(db));
bot.callbackQuery(/^profile:chapter:(.+)$/, makeProfileChapterCallbackHandler(db));
bot.callbackQuery(
  /^profile:skip:(phone|email|linksGithub|linksLinkedin|linksSite)$/,
  makeProfileSkipCallbackHandler(db),
);
bot.callbackQuery(/^profile:student:(yes|no)$/, makeProfileStudentCallbackHandler(db));
bot.callbackQuery(
  /^profile:experience:(user|builder|advanced|expert)$/,
  makeProfileExperienceCallbackHandler(db),
);
bot.on("message:contact", makeProfileContactHandler(db));
bot.on("message:text", makeProfileTextAnswerHandler(db));

// REQ-020: registration for an open event, atomic capacity enforcement,
// qr_token issuance. The Register button lives on the event card the
// existing /start deep-link resolution already sends (handlers/start.ts).
bot.callbackQuery(REGISTER_CALLBACK_PATTERN, makeRegisterCallbackHandler(db));

// REQ-024: /my -- the caller's own registrations, live status, computed
// waitlist position, the QR pass. An id-less, non-organizer-gated read
// command, same precedent as /events (REQ-017) and /withdraw (REQ-022)
// above.
bot.command("my", makeMyCommandHandler(db));

// REQ-030: /walkin <event_id> <name>|<company>|<phone> -- walk-in
// registration at the door. Registered alongside the other
// organizer-authorized, id-parameterized commands. The confirm/override/
// cancel callbacks carry their state in the message text itself (§1.1) --
// walkin:cancel is shared by both the initial Cancel and the override
// step's Dismiss button.
bot.command("walkin", makeWalkinCommandHandler(db));
bot.callbackQuery(WALKIN_CONFIRM_PATTERN, makeWalkinConfirmCallbackHandler(db));
bot.callbackQuery(WALKIN_OVERRIDE_PATTERN, makeWalkinOverrideCallbackHandler(db));
bot.callbackQuery("walkin:cancel", makeWalkinCancelCallbackHandler());

// REQ-031: post-event feedback (T+2h request / T+24h reminder, both
// scheduled above), the NPS/broadcast-ask callbacks, and the generic
// reply-to-message text listener (design §6.3) -- registered after every
// bot.command(...) registration, alongside the other generic message:text
// listener (handlers/profile.ts's makeProfileTextAnswerHandler above), same
// ordering discipline that file's own header note establishes. Both
// listeners react to text messages and independently no-op on a message
// they do not recognize -- no explicit next() is ever called by either.
bot.callbackQuery(FEEDBACK_NPS_PATTERN, makeFeedbackNpsCallbackHandler(db));
bot.callbackQuery(FEEDBACK_BROADCAST_PATTERN, makeFeedbackBroadcastCallbackHandler(db));
bot.on("message:text", makeFeedbackTextReplyHandler(db));

// REQ-032: no-show reason capture (the T-relative-time job registered
// above) -- the five fixed-reason buttons, the "other" free-text option, and
// its own generic reply-to-message text listener (design §4), registered
// after every bot.command(...) registration, alongside the other generic
// message:text listeners (handlers/profile.ts, handlers/feedback.ts above),
// same ordering discipline those files' own header notes establish. This
// listener reacts to text messages and independently no-ops on a message it
// does not recognize -- no explicit next() is ever called.
bot.callbackQuery(NO_SHOW_REASON_PATTERN, makeNoShowReasonCallbackHandler(db));
bot.callbackQuery(NO_SHOW_OTHER_PATTERN, makeNoShowOtherCallbackHandler(db));
bot.on("message:text", makeNoShowTextReplyHandler(db));

// REQ-035: organizer approve/reject surface for pending requests
// (/requests <event_id> [query]) -- the list/detail/pagination callbacks,
// the approve + capacity-override-confirm/cancel callbacks, the reject
// prompt callback, and its own generic reply-to-message text listener
// (handlers/organizerRequests.ts), registered after every bot.command(...)
// registration, alongside the other generic message:text listeners above,
// same ordering discipline those files' own header notes establish.
bot.command("requests", makeRequestsListHandler(db));
bot.callbackQuery(REQ_PAGE_PATTERN, makeRequestsPageCallbackHandler(db));
bot.callbackQuery(REQ_OPEN_PATTERN, makeRequestDetailCallbackHandler(db));
bot.callbackQuery(REQ_APPROVE_CONFIRM_PATTERN, makeRequestApproveConfirmCallbackHandler(db, notificationSender));
bot.callbackQuery(REQ_APPROVE_CANCEL_PATTERN, makeRequestApproveCancelCallbackHandler(db));
bot.callbackQuery(REQ_APPROVE_PATTERN, makeRequestApproveCallbackHandler(db, notificationSender));
bot.callbackQuery(REQ_REJECT_PATTERN, makeRequestRejectCallbackHandler(db));
bot.on("message:text", makeRequestRejectTextReplyHandler(db, notificationSender));

bot.start();
