import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { chapters, users } from "../db/schema.js";

export interface UserWithChapterLang {
  lang: string | null;
  chapterDefaultLang: string | null;
}

// Framework-free, read-only query helper (REQ-013 §3.2, decisions/0004).
// Used by the /start stub and the /lang command to resolve the caller's
// current language. Never a business key: resolves tg_id -> the internal
// users.id/chapter_id relationship, but returns only the two fields
// resolveLang needs — no PII value is read or returned here.
export async function getUserWithChapterByTgId(
  db: DbClient["db"],
  tgId: bigint,
): Promise<UserWithChapterLang | null> {
  const rows = await db
    .select({
      lang: users.lang,
      chapterDefaultLang: chapters.defaultLang,
    })
    .from(users)
    .leftJoin(chapters, eq(users.chapterId, chapters.id))
    .where(eq(users.tgId, tgId))
    .limit(1);

  return rows[0] ?? null;
}
