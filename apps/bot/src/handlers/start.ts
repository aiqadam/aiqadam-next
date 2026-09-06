import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { getUserWithChapterByTgId } from "../domain/user.js";
import { getCatalog } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// THROWAWAY STUB — REQ-013 §3. This is explicitly a minimal placeholder that
// REQ-014 replaces wholesale (its own /start handler deletes this stub's
// entire body and writes its own, reusing only resolveLang/getCatalog/
// getUserWithChapterByTgId). This stub does NOT and must NOT:
//   - INSERT/UPSERT into users (never creates a row, under any input)
//   - prompt for or read/write consent (consent_pd_at)
//   - assign or change chapter_id
//   - handle a deep-link (?start=e_<event_id>) payload
// It is read-only: look up an existing users/chapters row by tg_id, reply
// with the locale-resolved greeting, or the fixed "ru" fallback if no row
// exists (REQ-013 §3.2).
export function makeStartHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }

    const row = await getUserWithChapterByTgId(db, BigInt(tgId));

    if (row === null) {
      await ctx.reply(getCatalog("ru").start.greeting);
      return;
    }

    const lang = resolveLang(row.lang, row.chapterDefaultLang);
    await ctx.reply(getCatalog(lang).start.greeting);
  };
}
