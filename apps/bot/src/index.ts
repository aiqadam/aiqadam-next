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
} from "./handlers/event.js";

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
bot.callbackQuery("consent:agree", makeConsentCallbackHandler(db));
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

bot.start();
