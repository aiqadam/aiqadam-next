import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { users } from "../db/schema.js";

// REQ-015 §1 — the reusable, framework-free authorization predicate every
// venue-mutation handler calls FIRST, before any parsing, any read of the
// venue row, or any reply (decisions/0004: no domain logic in handler
// bodies; security-invariants.md S2: the check lives on the action, and the
// negative path must be provable on the handler, not the menu).

export interface ActingUser {
  id: string;
  role: "member" | "organizer" | "owner";
  chapterId: string | null;
}

export type AuthorizationResult =
  | { ok: true; user: ActingUser }
  | { ok: false; reason: "no-user" | "not-organizer" | "wrong-chapter" };

// Resolves ctx.from.id -> users.id/role/chapter_id. Same discipline as
// REQ-013/014's getFlowUserByTgId: tg_id is used only in this one lookup's
// WHERE clause; every later reference is user.id.
export async function resolveActingUser(
  db: DbClient["db"],
  tgId: bigint,
): Promise<ActingUser | null> {
  const rows = await db
    .select({ id: users.id, role: users.role, chapterId: users.chapterId })
    .from(users)
    .where(eq(users.tgId, tgId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    id: row.id,
    // users.role is a plain `text` column (REQ-010 schema.ts note: no
    // schema-level enum). Values written to it are validated elsewhere
    // (out of this requirement's scope); this module only reads it back.
    role: row.role as ActingUser["role"],
    chapterId: row.chapterId,
  };
}

// Pure predicate over already-resolved data — no I/O, unit-testable without
// a DB. Logic stated exactly per design §1 so it cannot be reinterpreted:
//
// 1. user === null                       -> { ok: false, reason: "no-user" }
// 2. user.role === "member"               -> { ok: false, reason: "not-organizer" }
// 3. user.role === "owner"                -> { ok: true, user } (all chapters)
// 4. user.role === "organizer"            -> ok only if user.chapterId ===
//    targetChapterId; otherwise "wrong-chapter".
//
// Step 4's null-chapter_id guard (Step 1b non-blocking note): an organizer
// row with a null chapter_id can never equal any real targetChapterId
// string, so it already falls through to "wrong-chapter" without a special
// case — stated explicitly here (rather than left as an accidental
// consequence of `===`) so a future refactor of this comparison doesn't
// silently reintroduce a path where a null chapterId is treated as
// "matches everything" or reaches a DB insert with a null chapter_id.
export function checkOrganizerForChapter(
  user: ActingUser | null,
  targetChapterId: string,
): AuthorizationResult {
  if (user === null) {
    return { ok: false, reason: "no-user" };
  }
  if (user.role === "member") {
    return { ok: false, reason: "not-organizer" };
  }
  if (user.role === "owner") {
    return { ok: true, user };
  }
  // role === "organizer"
  if (user.chapterId === null || user.chapterId !== targetChapterId) {
    return { ok: false, reason: "wrong-chapter" };
  }
  return { ok: true, user };
}

// Composed entry point every handler calls first.
export async function requireOrganizerForChapter(
  db: DbClient["db"],
  tgId: bigint,
  targetChapterId: string,
): Promise<AuthorizationResult> {
  const user = await resolveActingUser(db, tgId);
  return checkOrganizerForChapter(user, targetChapterId);
}
