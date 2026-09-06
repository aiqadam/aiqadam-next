export type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

export interface BotConfig {
  botToken: string;
  databaseUrl: string;
  logLevel: LogLevel;
  defaultChapterCode: string | undefined;
}

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/**
 * Reads and validates the bot's environment variables.
 *
 * Pure function — no process side effects. Throws an Error naming only the
 * offending variable's NAME (never a value) when a required variable is
 * absent/empty (BOT_TOKEN, DATABASE_URL) or present but invalid (LOG_LEVEL
 * outside its closed set). Callers (e.g. index.ts) are responsible for
 * catching this and deciding what to do about it (e.g. process.exit).
 *
 * logLevel and defaultChapterCode have no requirement-stated business
 * default other than logLevel's own "info" fallback (REQ-012 §1.1) — no
 * literal default is invented for defaultChapterCode.
 */
export function loadConfig(env: NodeJS.ProcessEnv): BotConfig {
  const missing: string[] = [];
  const problems: string[] = [];

  if (!env.BOT_TOKEN) {
    missing.push("BOT_TOKEN");
  }
  if (!env.DATABASE_URL) {
    missing.push("DATABASE_URL");
  }
  if (missing.length > 0) {
    problems.push(`Missing required environment variable(s): ${missing.join(", ")}`);
  }

  let logLevel: LogLevel = "info";
  if (env.LOG_LEVEL) {
    if (isLogLevel(env.LOG_LEVEL)) {
      logLevel = env.LOG_LEVEL;
    } else {
      problems.push("invalid value for LOG_LEVEL");
    }
  }

  if (problems.length > 0) {
    throw new Error(problems.join("; "));
  }

  return {
    botToken: env.BOT_TOKEN as string,
    databaseUrl: env.DATABASE_URL as string,
    logLevel,
    defaultChapterCode: env.DEFAULT_CHAPTER_CODE || undefined,
  };
}
