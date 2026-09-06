import type { BotLang } from "./catalog.js";

// REQ-017 §2.1 — chapter-timezone rendering mechanism. Framework-free (no
// grammY import, decisions/0004), no I/O, pure function: (Date, IANA tz
// string, BotLang) -> string.
//
// Rule stated exactly: `Intl.DateTimeFormat` is called with a locale tag
// resolved from `lang` (the table below) and an options object whose
// `timeZone` field is set from the `timezone` parameter — NEVER from
// `process.env.TZ`, and never omitted. This is the entire mechanism AC2
// verifies: an omitted/ambient `timeZone` would silently fall back to the
// runtime's default zone, which is exactly the failure mode AC2 tests
// against by deliberately mismatching the process's own TZ.
//
// REQ-017 design doc (data-mapping table, "Date/time in chapter timezone"
// row, and the worked example) specifies 24-hour wall-clock output
// literally, e.g. "Oct 1, 2026, 18:00". `hourCycle: "h23"` is set explicitly
// so this holds for every locale — `Intl` otherwise defaults en-US/en-CA/
// en-AU to a 12-hour AM/PM clock, which silently diverged from the design.

const LOCALE_BY_LANG: Record<BotLang, string> = {
  ru: "ru-RU",
  en: "en-US",
};

export function formatDateTimeInTimezone(at: Date, timezone: string, lang: BotLang): string {
  const formatter = new Intl.DateTimeFormat(LOCALE_BY_LANG[lang], {
    timeZone: timezone,
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return formatter.format(at);
}
