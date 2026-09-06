import { and, asc, eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { chapters, users } from "../db/schema.js";

export interface ChapterOption {
  id: string;
  name: string;
}

// REQ-014 §2.3 / REQ-014-schema.md §4 — the three-way branch signal query:
// 0, 1, or 2-meaning-"2 or more" active chapters. Read by row count, not
// COUNT(*) (schema design's stated reasoning: the caller only ever needs to
// distinguish these three cases). Framework-free (decisions/0004).
export async function getActiveChapterSignal(
  db: DbClient["db"],
): Promise<{ id: string }[]> {
  return db
    .select({ id: chapters.id })
    .from(chapters)
    .where(eq(chapters.active, true))
    .limit(2);
}

// REQ-014 §2.3 — the full option set for the "ask once" branch (2+ active
// chapters), ordered by name for a stable keyboard layout.
export async function listActiveChapters(
  db: DbClient["db"],
): Promise<ChapterOption[]> {
  return db
    .select({ id: chapters.id, name: chapters.name })
    .from(chapters)
    .where(eq(chapters.active, true))
    .orderBy(asc(chapters.name));
}

// REQ-014 §2.6 step 2 — validates a chapter-callback's tapped id against the
// *currently* active chapter set before writing, so a stale keyboard (a
// chapter deactivated between prompt and tap) or a tampered callback_data
// value cannot assign a user to a nonexistent/inactive chapter.
export async function isChapterActive(
  db: DbClient["db"],
  chapterId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.id, chapterId), eq(chapters.active, true)))
    .limit(1);
  return rows.length > 0;
}

// REQ-014 §2.3/§2.6 — persists the chapter assignment, keyed on users.id
// (never tg_id, AC5/§6). Silent-assignment and chapter-callback branches
// both call this.
export async function assignChapter(
  db: DbClient["db"],
  userId: string,
  chapterId: string,
): Promise<void> {
  await db.update(users).set({ chapterId }).where(eq(users.id, userId));
}
