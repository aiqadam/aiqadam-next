import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { getUserWithChapterByTgId } from "../domain/user.js";
import { setUserLang } from "../domain/setUserLang.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// REQ-013 §2. grammY core only — InlineKeyboard is exported by the `grammy`
// package itself, not a separate plugin (matches REQ-009's "no grammY
// plugins at this stage" boundary).

const LANG_KEYBOARD = new InlineKeyboard()
  .text("Русский", "lang:ru")
  .text("English", "lang:en");

/** `/lang` — prompts with the caller's current language + the two-option keyboard. */
export function makeLangCommandHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }

    const row = await getUserWithChapterByTgId(db, BigInt(tgId));
    const lang = row === null ? resolveLang(null, null) : resolveLang(row.lang, row.chapterDefaultLang);

    await ctx.reply(getCatalog(lang).lang.prompt, { reply_markup: LANG_KEYBOARD });
  };
}

/** Handles the `lang:ru` / `lang:en` callback tap — persists and confirms. */
export function makeLangCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    const match = ctx.match;
    if (tgId === undefined || typeof match !== "object" || match === null) {
      await ctx.answerCallbackQuery();
      return;
    }

    const chosen = match[1] as BotLang;
    const persisted = await setUserLang(db, BigInt(tgId), chosen);

    await ctx.answerCallbackQuery();

    if (!persisted) {
      // No existing users row (§2.3's no-user-row case) — reply with the
      // catalog's noProfile string, resolved via resolveLang(null, null)
      // (deterministically "ru", per §1.3 step 3), not a hardcoded literal.
      await ctx.reply(getCatalog(resolveLang(null, null)).lang.noProfile);
      return;
    }

    // Confirmation text is read from the NEWLY-chosen language's catalog,
    // not the pre-selection one (§2.2's closing note / AC3).
    await ctx.reply(getCatalog(chosen).lang.confirmed);
  };
}
