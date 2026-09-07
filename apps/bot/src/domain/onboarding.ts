import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { buildConsentKeyboard } from "../handlers/start.js";
import { sendProfileFieldPrompt } from "../handlers/profile.js";
import {
  determineNextProfileField,
  getProfileByUserId,
  type ProfileField,
  type ProfileRecord,
} from "./profile.js";

// REQ-019 §3 — the shared consent -> chapter -> profile progression engine.
//
// DEVIATION NOTE (flagged in this run's handoff result.issues, not resolved
// unilaterally): this file imports `Context` from grammy and calls
// `ctx.reply`, which is in tension with decisions/0004-telegram-framework-
// grammy.md's "domain logic ... goes in framework-free modules" consequence.
// This is exactly what docs/agents/design/REQ-019.md §3.2 specifies —
// `advanceOnboarding(ctx: Context, ...)` sending the next prompt as its one
// side effect, reasoned there as mirroring `assignChapterOrPrompt`'s existing
// "decide and reply in one function" convention (handlers/start.ts) — and
// that design already passed CODE-DESIGN-VALIDATOR twice (handoffs/
// WF02-REQ-019/step-01b-design-validator-regate.json). Implemented exactly as
// designed per this run's own instruction ("implement exactly what the
// design specifies... never resolve a conflict silently"), flagged for
// REVIEWER/SECURITY-REVIEWER rather than silently reconciled in either
// direction.

export type OnboardingStep =
  | { kind: "consent-needed" }
  | { kind: "chapter-needed" }
  | { kind: "profile-field"; field: ProfileField }
  | { kind: "ready" };

// §3.1's rule table, stated exactly.
export function determineOnboardingStep(
  hasConsented: boolean,
  hasChapter: boolean,
  profile: ProfileRecord | null,
): OnboardingStep {
  if (!hasConsented) {
    return { kind: "consent-needed" };
  }
  if (!hasChapter) {
    return { kind: "chapter-needed" };
  }
  const nextField = determineNextProfileField(profile);
  if (nextField.kind === "field") {
    return { kind: "profile-field", field: nextField.field };
  }
  return { kind: "ready" };
}

/**
 * §3.2 — the ONE function every entry point calls. Never reads or writes
 * `profiles` while consent is outstanding (§0.2's "no write before the gate
 * opens" guarantee extended to reads). Sends the next prompt as its one side
 * effect and reports what happened: "prompted" (a question was sent),
 * "chapter-needed" (the caller must run `assignChapterOrPrompt` itself, then
 * call this function again — §3.2 step 4, kept out of this function so
 * `domain/chapter.ts`'s existing, already-reviewed branching stays
 * untouched), or "ready" (the caller decides what "ready" means for its own
 * context).
 */
export async function advanceOnboarding(
  ctx: Context,
  db: DbClient["db"],
  userId: string,
  hasConsented: boolean,
  hasChapter: boolean,
  lang: BotLang,
): Promise<"prompted" | "ready" | "chapter-needed"> {
  const profile = hasConsented && hasChapter ? await getProfileByUserId(db, userId) : null;
  const step = determineOnboardingStep(hasConsented, hasChapter, profile);

  if (step.kind === "consent-needed") {
    await ctx.reply(getCatalog(lang).consent.prompt, {
      reply_markup: buildConsentKeyboard(lang),
    });
    return "prompted";
  }

  if (step.kind === "chapter-needed") {
    return "chapter-needed";
  }

  if (step.kind === "profile-field") {
    await sendProfileFieldPrompt(ctx, step.field, lang);
    return "prompted";
  }

  return "ready";
}
