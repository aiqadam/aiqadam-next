import type { LogLevel } from "./config.js";

// Structured logging wrapper (REQ-012 §5). No new dependency — plain
// single-line JSON via console.log/console.error, the appropriate ceiling
// for PRD 11's small-scale, single-process deployment. Never logs the
// database URL, bot token, or phone/email values: callers only ever have
// access to variable NAMES in this requirement's scope (mirrors config.ts's
// thrown-Error convention), and this module additionally redacts a fixed set
// of field names as defense in depth.

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const REDACTED_KEYS = new Set([
  "databaseUrl",
  "connectionString",
  "botToken",
  "token",
  "phone",
  "email",
]);

export type LogFields = Record<string, unknown>;

function redact(fields: LogFields | undefined): LogFields | undefined {
  if (!fields) {
    return fields;
  }
  const safe: LogFields = {};
  for (const [key, value] of Object.entries(fields)) {
    safe[key] = REDACTED_KEYS.has(key) ? "[redacted]" : value;
  }
  return safe;
}

function write(
  method: "log" | "error",
  level: LogLevel,
  msg: string,
  fields: LogFields | undefined,
): void {
  const line = JSON.stringify({
    level,
    msg,
    ...redact(fields),
    time: new Date().toISOString(),
  });
  console[method](line);
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

/** Creates a leveled logger gated on the configured logLevel threshold. */
export function createLogger(logLevel: LogLevel): Logger {
  const threshold = LEVEL_ORDER[logLevel];
  const at = (level: LogLevel, method: "log" | "error") => (msg: string, fields?: LogFields) => {
    if (LEVEL_ORDER[level] < threshold) {
      return;
    }
    write(method, level, msg, fields);
  };

  return {
    debug: at("debug", "log"),
    info: at("info", "log"),
    warn: at("warn", "log"),
    error: at("error", "error"),
  };
}
