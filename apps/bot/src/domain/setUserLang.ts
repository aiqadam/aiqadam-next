import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { users } from "../db/schema.js";
import type { BotLang } from "../i18n/catalog.js";

// Framework-free persistence module (REQ-013 §2.3, decisions/0004) — the
// /lang callbackQuery handler calls this, never an inline query in the
// handler body. A single UPDATE against the already-existing users
// table/tgId/lang columns; no schema change.
//
// Returns false when the UPDATE affected zero rows (no users row exists for
// this tg_id — the expected state for anyone who has never sent the stub
// /start). The caller uses this to decide whether to reply with
// catalog.lang.noProfile instead of catalog.lang.confirmed.
export async function setUserLang(
  db: DbClient["db"],
  tgId: bigint,
  lang: BotLang,
): Promise<boolean> {
  const result = await db
    .update(users)
    .set({ lang })
    .where(eq(users.tgId, tgId))
    .returning({ id: users.id });
  return result.length > 0;
}
