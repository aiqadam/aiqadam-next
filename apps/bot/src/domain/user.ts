import { eq, sql } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { chapters, users } from "../db/schema.js";
import type { BotLang } from "../i18n/catalog.js";

export interface UserWithChapterLang {
  lang: string | null;
  chapterDefaultLang: string | null;
}

export interface ResolvedUser {
  id: string;
  tgUsername: string | null;
  lang: string | null;
  chapterId: string | null;
  consentPdAt: Date | null;
}

export interface ResolveOrCreateUserInput {
  tgId: bigint;
  tgUsername: string | null;
  lang: BotLang | null;
}

// REQ-014 §2.2 — resolve-or-create the User row by tg_id. Framework-free
// (decisions/0004); the /start handler calls this, never inlines the SQL.
//
// Concurrency: an INSERT ... ON CONFLICT (tg_id) DO UPDATE, where the
// "update" sets tg_id back to its own (excluded) value — a genuine no-op on
// the columns that matter (tg_username, lang are never overwritten on an
// existing row) — makes the create-if-missing step atomic against
// users_tg_id_unique. Two near-simultaneous /start taps race safely: exactly
// one row ever exists per tg_id, and RETURNING always yields a row (freshly
// inserted or pre-existing) in a single statement, with no separate
// SELECT-then-INSERT window for the unique index to reject.
export async function resolveOrCreateUser(
  db: DbClient["db"],
  input: ResolveOrCreateUserInput,
): Promise<ResolvedUser> {
  const rows = await db
    .insert(users)
    .values({
      tgId: input.tgId,
      tgUsername: input.tgUsername,
      lang: input.lang,
    })
    .onConflictDoUpdate({
      target: users.tgId,
      set: { tgId: sql`excluded.tg_id` },
    })
    .returning({
      id: users.id,
      tgUsername: users.tgUsername,
      lang: users.lang,
      chapterId: users.chapterId,
      consentPdAt: users.consentPdAt,
    });

  const row = rows[0];
  if (row === undefined) {
    // Unreachable in practice: RETURNING on an INSERT ... ON CONFLICT DO
    // UPDATE always yields exactly one row. Guarded rather than asserted
    // with a non-null assertion, per this codebase's no-speculation stance.
    throw new Error("resolveOrCreateUser: insert-or-update returned no row");
  }
  return row;
}

// Framework-free, read-only query helper (REQ-013 §3.2, decisions/0004).
// Used by the /start stub and the /lang command to resolve the caller's
// current language. Never a business key: resolves tg_id -> the internal
// users.id/chapter_id relationship, but returns only the two fields
// resolveLang needs — no PII value is read or returned here.
export interface FlowUser {
  id: string;
  lang: string | null;
  chapterId: string | null;
  consentPdAt: Date | null;
  chapterDefaultLang: string | null;
}

// REQ-014 — resolves the fields the /start flow's callback handlers
// (chapter selection, consent acceptance) need to decide what to do/say
// next: users.id (the only key ever written after this point, AC5), the
// current chapter/consent gate state, and the chapter's default_lang for
// resolveLang. tg_id is used only in the WHERE clause of this single
// entry-point lookup, per §6's allowed-exception reading.
export async function getFlowUserByTgId(
  db: DbClient["db"],
  tgId: bigint,
): Promise<FlowUser | null> {
  const rows = await db
    .select({
      id: users.id,
      lang: users.lang,
      chapterId: users.chapterId,
      consentPdAt: users.consentPdAt,
      chapterDefaultLang: chapters.defaultLang,
    })
    .from(users)
    .leftJoin(chapters, eq(users.chapterId, chapters.id))
    .where(eq(users.tgId, tgId))
    .limit(1);

  return rows[0] ?? null;
}

// REQ-018 §2.2 — resolve a user by their tg_username. General user-lookup
// concern, not staff-specific (same reasoning that keeps getFlowUserByTgId/
// getUserWithChapterByTgId here rather than in a feature handler).
//
// Open question (design §6.3, not silently assumed): users.tg_username has
// no unique index (schema.ts — only tg_id is uniquely indexed). If two rows
// somehow share the same tg_username, this query returns whichever row the
// database happens to return first for an unordered LIMIT 1 — not a
// specified "most recent" or "first ever" row. Not exercised by any
// acceptance criterion.
//
// tgId is typed nullable even though every row reaching this lookup today
// was created by resolveOrCreateUser (which always sets tgId and tgUsername
// together) — typed nullable anyway because the column itself is nullable
// (schema.ts: "nullable so an organizer can pre-create a User row before the
// person's first /start") and no future requirement should be able to
// violate this design's safety by assuming otherwise.
export interface UserWithTelegram {
  id: string;
  tgId: bigint | null;
  tgUsername: string | null;
}

export async function getUserByTgUsername(
  db: DbClient["db"],
  tgUsername: string,
): Promise<UserWithTelegram | null> {
  const rows = await db
    .select({ id: users.id, tgId: users.tgId, tgUsername: users.tgUsername })
    .from(users)
    .where(eq(users.tgUsername, tgUsername))
    .limit(1);
  return rows[0] ?? null;
}

// docs/agents/design/REQ-023.md §6.1 — resolve the fields the promotion
// notification (handlers/withdraw.ts) needs, starting FROM an internal
// users.id rather than a caller's own ctx.from.id: the promoted person is a
// different Telegram user than the one who triggered the withdrawal. Same
// join shape as getFlowUserByTgId (users left-joined to chapters for the
// default-lang fallback), filtered by users.id instead. Plain read, no lock
// (the authoritative write already committed inside
// promoteFromWaitlistIfEligible's transaction before this is ever called).
// security-invariants.md S10: "blocked users are skipped in both
// [transactional and marketing] cases" -- projecting the flag here is what
// lets the one call site that sends to this user (sendPromotionNotification)
// honor that clause; it previously had no way to.
export interface UserForNotification {
  tgId: bigint | null;
  lang: string | null;
  chapterDefaultLang: string | null;
  blocked: boolean;
}

export async function getUserForNotificationById(
  db: DbClient["db"],
  userId: string,
): Promise<UserForNotification | null> {
  const rows = await db
    .select({
      tgId: users.tgId,
      lang: users.lang,
      chapterDefaultLang: chapters.defaultLang,
      blocked: users.blocked,
    })
    .from(users)
    .leftJoin(chapters, eq(users.chapterId, chapters.id))
    .where(eq(users.id, userId))
    .limit(1);

  return rows[0] ?? null;
}

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
