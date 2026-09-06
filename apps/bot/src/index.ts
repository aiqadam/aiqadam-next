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

bot.start();
