import { Bot } from "grammy";
import { loadConfig, type BotConfig } from "./config.js";
import { createDbClient } from "./db/client.js";
import { createLogger } from "./log.js";

let config: BotConfig;

try {
  config = loadConfig(process.env);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const log = createLogger(config.logLevel);

// Pool is constructed after loadConfig succeeds, before bot.start() (REQ-012
// §2.3). Not yet used by any handler in this requirement's scope — later
// requirements (REQ-013+) consume `db` from this client.
const { pool } = createDbClient(config.databaseUrl);
void pool;

log.info("bot starting");

const bot = new Bot(config.botToken);

bot.command("health", (ctx) => ctx.reply("ok"));

bot.start();
