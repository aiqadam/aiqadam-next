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
  });
  return formatter.format(at);
}
