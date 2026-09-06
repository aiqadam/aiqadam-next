import { Bot } from "grammy";
import { loadConfig } from "./config.js";

let botToken: string;
let databaseUrl: string;

try {
  const config = loadConfig(process.env);
  botToken = config.botToken;
  databaseUrl = config.databaseUrl;
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

// databaseUrl is validated for presence only at this stage (REQ-009) — no
// Drizzle/pg client is instantiated here until a schema exists (REQ-010+).
void databaseUrl;

console.log("bot starting");

const bot = new Bot(botToken);

bot.command("health", (ctx) => ctx.reply("ok"));

bot.start();
