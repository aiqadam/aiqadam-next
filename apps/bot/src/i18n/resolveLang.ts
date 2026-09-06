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
function isBotLang(value: string | null | undefined): value is BotLang {
  return value === "ru" || value === "en";
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
