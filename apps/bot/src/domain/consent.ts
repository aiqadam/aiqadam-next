import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { users } from "../db/schema.js";

// REQ-014 §2.4/§2.5 — the version identifier the server actually knows it is
// showing right now, per the consent prompt's own catalog wording (i18n
// ru.ts/en.ts consent.prompt "(v1)" tag). A single module-level constant, not
// read from callback_data, so the recorded version can never be
// client-influenced (§2.5's security note) — PLACEHOLDER, provisional
// pending the product owner (REQ-014 requirement text; see handoff
// result.issues).
export const CONSENT_WORDING_VERSION = "v1";

// REQ-014 §2.5 — records consent acceptance: sets consent_pd_at and
// consent_pd_version together, in one write (the "both-or-neither"
// discipline REQ-014-schema.md §10 leaves to the handler, since no DB
// constraint enforces the pairing). Keyed on users.id, never tg_id (AC5).
//
// `at` is supplied by the caller (decisions/0006: a time-dependent write is
// parameterized by the caller's clock, not a SQL now()), so a test can
// control it and assert the exact stored value.
//
// Returns false when the UPDATE affected zero rows (no users row for this
// id — mirrors setUserLang's "no row" contract).
export async function recordConsent(
  db: DbClient["db"],
  userId: string,
  at: Date,
): Promise<boolean> {
  const result = await db
    .update(users)
    .set({ consentPdAt: at, consentPdVersion: CONSENT_WORDING_VERSION })
    .where(eq(users.id, userId))
    .returning({ id: users.id });
  return result.length > 0;
}
