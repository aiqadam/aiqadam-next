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
import { makeCheckInHandler } from "./handlers/checkin.js";
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
bot.command("event_cancel", makeEventCancelHandler(db));

// REQ-017: /events — public, chapter-scoped upcoming-events list. Any
// member may run it (not organizer-gated, same precedent as /venues).
bot.command("events", makeEventsListHandler(db));

// REQ-018: organizer-only EventStaff assign/remove (chapter-scoped, reuses
// requireOrganizerForChapter unchanged), and the staff-only /checkin
// authorization-only stub gate (domain/eventStaffAuthorization.ts — a
// genuinely different predicate, no role short-circuit).
bot.command("staff_add", makeStaffAddHandler(db));
bot.command("staff_remove", makeStaffRemoveHandler(db));
bot.command("checkin", makeCheckInHandler(db));

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

bot.start();
