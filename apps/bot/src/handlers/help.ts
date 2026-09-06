import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { getUserWithChapterByTgId } from "../domain/user.js";
import { getCatalog } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// REQ-014 §4 — `/help` neither creates nor mutates anything, so it reuses
// REQ-013's existing read-only lang-resolution helper rather than a new
// query. The entire visible response is one catalog lookup — no string
// concatenation, no literal appended (AC6).
export function makeHelpHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }

    const row = await getUserWithChapterByTgId(db, BigInt(tgId));
    const lang =
      row === null
        ? resolveLang(null, null)
        : resolveLang(row.lang, row.chapterDefaultLang);

    await ctx.reply(getCatalog(lang).help.body);
  };
}
