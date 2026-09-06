export interface BotConfig {
  botToken: string;
  databaseUrl: string;
}

/**
 * Reads and validates the bot's required environment variables.
 *
 * Pure function — no process side effects. Throws an Error naming only the
 * missing variable's NAME (never a value) when a required variable is absent
 * or empty. Callers (e.g. index.ts) are responsible for catching this and
 * deciding what to do about it (e.g. process.exit).
 */
export function loadConfig(env: NodeJS.ProcessEnv): BotConfig {
  const missing: string[] = [];

  if (!env.BOT_TOKEN) {
    missing.push("BOT_TOKEN");
  }
  if (!env.DATABASE_URL) {
    missing.push("DATABASE_URL");
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  return {
    botToken: env.BOT_TOKEN as string,
    databaseUrl: env.DATABASE_URL as string,
  };
}
