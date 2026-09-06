import type { BotLang } from "./catalog.js";

// Pure, synchronous, no I/O resolution function (REQ-013 §1.3) — same shape
// discipline as config.ts's loadConfig. Handlers call this; the ru/en
// branching is never inlined in a handler body (decisions/0004).
//
// Order:
// 1. userLang exactly "ru" or "en" wins outright.
// 2. Else chapterDefaultLang exactly "ru" or "en" wins. chapters.default_lang
//    is unconstrained free text (schema.ts) — any other value (including a
//    non-bot locale like "uz") falls through to step 3 exactly like a
//    missing value; this function never assumes chapterDefaultLang is a
//    valid bot locale.
// 3. Else "ru" — the fixed final fallback, never configurable.
const BOT_LANGS: readonly BotLang[] = ["ru", "en"];

function isBotLang(value: string | null | undefined): value is BotLang {
  return value === "ru" || value === "en";
}

// REQ-014 §2.2 — maps Telegram's User.language_code (an optional IETF tag,
// e.g. "ru", "ru-RU", "en-US") to a BotLang at User-creation time, or null if
// unrecognized. Thin reuse of the same two-value recognition isBotLang
// performs (same BOT_LANGS list), extended with startsWith rather than exact
// equality because language_code carries a region subtag isBotLang's exact
// match (used for already-normalized stored/selected values) never has to
// handle. Not a second validation routine — one list of recognized values,
// two call shapes for two different input shapes.
export function mapTelegramLanguageCode(
  languageCode: string | null | undefined,
): BotLang | null {
  if (typeof languageCode !== "string") {
    return null;
  }
  for (const lang of BOT_LANGS) {
    if (languageCode.startsWith(lang)) {
      return lang;
    }
  }
  return null;
}

export function resolveLang(
  userLang: string | null | undefined,
  chapterDefaultLang: string | null | undefined,
): BotLang {
  if (isBotLang(userLang)) {
    return userLang;
  }
  if (isBotLang(chapterDefaultLang)) {
    return chapterDefaultLang;
  }
  return "ru";
}
