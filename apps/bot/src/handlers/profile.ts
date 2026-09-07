import { InlineKeyboard, Keyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { isChapterActive, listActiveChapters, assignChapter } from "../domain/chapter.js";
import { advanceOnboarding, determineOnboardingStep } from "../domain/onboarding.js";
import {
  formatProfileDump,
  getProfileByUserId,
  isNonBlank,
  isValidEmailFormat,
  markOptionalProfileFieldSkipped,
  parseProfileEditFields,
  validateProfileEditInput,
  writeOptionalProfileField,
  writeRequiredProfileField,
  type OptionalProfileField,
  type ProfileField,
} from "../domain/profile.js";
import { getFlowUserByTgId, type FlowUser } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";
import { assignChapterOrPrompt } from "./start.js";

// REQ-019 §4 — /profile, /profile_edit, /profile_chapter, the generic
// step-answer text/contact listeners, and the skip/student/experience
// callback handlers. This file only sequences calls and sends replies
// (decisions/0004) — all persistence/derivation lives in
// domain/profile.ts / domain/onboarding.ts.

const PROFILE_CHAPTER_CALLBACK_PATTERN = /^profile:chapter:(.+)$/;
const PROFILE_SKIP_CALLBACK_PATTERN =
  /^profile:skip:(phone|email|linksGithub|linksLinkedin|linksSite)$/;
const PROFILE_STUDENT_CALLBACK_PATTERN = /^profile:student:(yes|no)$/;
const PROFILE_EXPERIENCE_CALLBACK_PATTERN =
  /^profile:experience:(user|builder|advanced|expert)$/;

// ---------------------------------------------------------------------------
// §4.4 — the guided step-by-step prompts, one builder per field, sent by
// domain/onboarding.ts's advanceOnboarding (step 5).
// ---------------------------------------------------------------------------
function buildStudentKeyboard(lang: BotLang): InlineKeyboard {
  const catalog = getCatalog(lang).profile;
  return new InlineKeyboard()
    .text(catalog.studentYes, "profile:student:yes")
    .text(catalog.studentNo, "profile:student:no");
}

function buildExperienceKeyboard(lang: BotLang): InlineKeyboard {
  const catalog = getCatalog(lang).profile;
  return new InlineKeyboard()
    .text(catalog.experienceUser, "profile:experience:user")
    .row()
    .text(catalog.experienceBuilder, "profile:experience:builder")
    .row()
    .text(catalog.experienceAdvanced, "profile:experience:advanced")
    .row()
    .text(catalog.experienceExpert, "profile:experience:expert");
}

function buildOptionalSkipKeyboard(lang: BotLang, field: OptionalProfileField): InlineKeyboard {
  return new InlineKeyboard().text(getCatalog(lang).profile.skipButton, `profile:skip:${field}`);
}

// §4.4 / §8.4 — the phone step's Skip affordance is matched by literal
// button text, not callback_data, forced by the Telegram constraint that
// request_contact only exists on a reply KeyboardButton, which cannot be
// combined with inline callback buttons in the same message.
function buildPhoneKeyboard(lang: BotLang): Keyboard {
  const catalog = getCatalog(lang).profile;
  return new Keyboard()
    .requestContact(catalog.shareContactButton)
    .row()
    .text(catalog.skipButton)
    .resized()
    .oneTime();
}

/**
 * §4.4 — sends the prompt for exactly one field. Called by
 * domain/onboarding.ts's advanceOnboarding (step 5); never called directly by
 * any other handler in this file.
 */
export async function sendProfileFieldPrompt(
  ctx: Context,
  field: ProfileField,
  lang: BotLang,
): Promise<void> {
  const catalog = getCatalog(lang).profile;

  switch (field) {
    case "firstName":
      await ctx.reply(catalog.promptFirstName);
      return;
    case "lastName":
      await ctx.reply(catalog.promptLastName);
      return;
    case "company":
      await ctx.reply(catalog.promptCompany);
      return;
    case "position":
      await ctx.reply(catalog.promptPosition);
      return;
    case "isStudent":
      await ctx.reply(catalog.promptIsStudent, { reply_markup: buildStudentKeyboard(lang) });
      return;
    case "experienceLevel":
      await ctx.reply(catalog.promptExperienceLevel, {
        reply_markup: buildExperienceKeyboard(lang),
      });
      return;
    case "phone":
      await ctx.reply(catalog.promptPhone, { reply_markup: buildPhoneKeyboard(lang) });
      return;
    case "email":
      await ctx.reply(catalog.promptEmail, {
        reply_markup: buildOptionalSkipKeyboard(lang, "email"),
      });
      return;
    case "linksGithub":
      await ctx.reply(catalog.promptGithub, {
        reply_markup: buildOptionalSkipKeyboard(lang, "linksGithub"),
      });
      return;
    case "linksLinkedin":
      await ctx.reply(catalog.promptLinkedin, {
        reply_markup: buildOptionalSkipKeyboard(lang, "linksLinkedin"),
      });
      return;
    case "linksSite":
      await ctx.reply(catalog.promptSite, {
        reply_markup: buildOptionalSkipKeyboard(lang, "linksSite"),
      });
      return;
  }
}

// ---------------------------------------------------------------------------
// Shared resolution helper — §4.1 steps 1-3, reused by every handler below.
// ---------------------------------------------------------------------------
async function resolveFlowContext(
  db: DbClient["db"],
  tgId: number,
): Promise<{ flowUser: FlowUser; lang: BotLang } | null> {
  const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
  if (flowUser === null) {
    return null;
  }
  const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);
  return { flowUser, lang };
}

// DEVIATION NOTE (flagged in this run's handoff result.issues): the design's
// `advanceOnboarding` signature (REQ-019.md §3.2) is stated as returning
// `Promise<"prompted" | "ready">`, but its own step 4 requires the CALLER to
// run `assignChapterOrPrompt` on a "chapter-needed" outcome and call
// `advanceOnboarding` again — a third outcome the stated return type has no
// room for. `domain/onboarding.ts`'s `advanceOnboarding` in this
// implementation returns `"chapter-needed"` as a third literal so callers
// (this file) can actually implement §3.2 step 4 as written, rather than the
// literal 2-value type silently swallowing the case. `handlers/start.ts`'s
// own three call sites never observe this outcome in practice (their
// existing chapter gate already runs first, per §3.3), so this widening is
// invisible there; it is load-bearing here, for `/profile` and its siblings,
// which have no pre-existing chapter gate of their own.
//
// A second gap this helper resolves pragmatically rather than by invented
// business rule: the design's `hasChapter` boolean (`chapterId !== null`)
// does not by itself terminate for the pre-existing "zero active chapters"
// edge case (REQ-014's own `noActiveChapters` branch), where `chapterId`
// legitimately stays `null` forever. `handlers/start.ts`'s own established
// precedent treats `assignChapterOrPrompt`'s `"continue"` result as
// sufficient to proceed unconditionally (it never re-checks `chapterId`
// afterward) — this helper mirrors that same precedent for the onboarding
// engine, treating `"continue"` as satisfying the chapter step for the
// remainder of this one pass, rather than re-deriving `hasChapter` and
// risking an infinite "chapter-needed" loop for that edge case.
async function reachReadyOrPrompt(
  ctx: Context,
  db: DbClient["db"],
  flowUser: FlowUser,
  lang: BotLang,
): Promise<"ready" | "prompted"> {
  const hasConsented = flowUser.consentPdAt !== null;
  const hasChapter = flowUser.chapterId !== null;
  let outcome = await advanceOnboarding(ctx, db, flowUser.id, hasConsented, hasChapter, lang);

  if (outcome === "chapter-needed") {
    const chapterOutcome = await assignChapterOrPrompt(ctx, db, flowUser.id, lang);
    if (chapterOutcome === "stopped") {
      return "prompted"; // resumes in the chapter callback (handlers/start.ts §2.6)
    }
    outcome = await advanceOnboarding(ctx, db, flowUser.id, hasConsented, true, lang);
    if (outcome === "chapter-needed") {
      return "prompted"; // defensive — should be unreachable given the above
    }
  }

  return outcome === "ready" ? "ready" : "prompted";
}

// ---------------------------------------------------------------------------
// §4.1 — /profile
// ---------------------------------------------------------------------------
export function makeProfileCommandHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }

    const resolved = await resolveFlowContext(db, tgId);
    if (resolved === null) {
      await ctx.reply(getCatalog("en").profile.startFirst);
      return;
    }
    const { flowUser, lang } = resolved;

    const outcome = await reachReadyOrPrompt(ctx, db, flowUser, lang);
    if (outcome !== "ready") {
      return;
    }

    // "ready" — guaranteed non-null profile by definition (§3.1 step 4).
    const profile = await getProfileByUserId(db, flowUser.id);
    if (profile === null) {
      return; // unreachable per "ready"'s own definition
    }
    await ctx.reply(formatProfileDump(profile, getCatalog(lang)));
    await ctx.reply(getCatalog(lang).profile.editHint);
  };
}

// ---------------------------------------------------------------------------
// §4.2 — /profile_edit
// ---------------------------------------------------------------------------
export function makeProfileEditHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const resolved = await resolveFlowContext(db, tgId);
    if (resolved === null) {
      await ctx.reply(getCatalog("en").profile.startFirst);
      return;
    }
    const { flowUser, lang } = resolved;

    const outcome = await reachReadyOrPrompt(ctx, db, flowUser, lang);
    if (outcome !== "ready") {
      return; // not yet onboarded — whatever the gate already sent
    }

    const text = ctx.message?.text ?? "";
    const afterCommand = text.split("\n").slice(1).join("\n");
    const fields = parseProfileEditFields(afterCommand);
    const validation = validateProfileEditInput(fields);

    if (!validation.ok) {
      await ctx.reply(
        `${getCatalog(lang).profile.editRejectedPrefix} ${validation.invalid.join(", ")}`,
      );
      return;
    }

    const at = new Date();
    for (const [field, value] of Object.entries(validation.updates)) {
      if (value === "skip") {
        await markOptionalProfileFieldSkipped(db, flowUser.id, field as OptionalProfileField, at);
      } else if (
        field === "phone" ||
        field === "email" ||
        field === "linksGithub" ||
        field === "linksLinkedin" ||
        field === "linksSite"
      ) {
        await writeOptionalProfileField(db, flowUser.id, field, value as string, at);
      } else {
        await writeRequiredProfileField(
          db,
          flowUser.id,
          field as
            | "firstName"
            | "lastName"
            | "company"
            | "position"
            | "isStudent"
            | "experienceLevel",
          value as string | boolean,
          at,
        );
      }
    }

    const profile = await getProfileByUserId(db, flowUser.id);
    if (profile !== null) {
      await ctx.reply(formatProfileDump(profile, getCatalog(lang)));
    }
  };
}

// ---------------------------------------------------------------------------
// §4.3 — /profile_chapter and its callback
// ---------------------------------------------------------------------------
function buildProfileChapterKeyboard(options: { id: string; name: string }[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const option of options) {
    keyboard.text(option.name, `profile:chapter:${option.id}`).row();
  }
  return keyboard;
}

export function makeProfileChapterHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const resolved = await resolveFlowContext(db, tgId);
    if (resolved === null) {
      await ctx.reply(getCatalog("en").profile.startFirst);
      return;
    }
    const { flowUser, lang } = resolved;

    const outcome = await reachReadyOrPrompt(ctx, db, flowUser, lang);
    if (outcome !== "ready") {
      return;
    }

    const options = await listActiveChapters(db);
    await ctx.reply(getCatalog(lang).profile.chapterPrompt, {
      reply_markup: buildProfileChapterKeyboard(options),
    });
  };
}

export function makeProfileChapterCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    const match = PROFILE_CHAPTER_CALLBACK_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    if (tgId === undefined || match === null) {
      await ctx.answerCallbackQuery();
      return;
    }
    const chapterId = match[1];
    if (chapterId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      await ctx.answerCallbackQuery();
      return;
    }

    const active = await isChapterActive(db, chapterId);
    await ctx.answerCallbackQuery();
    if (!active) {
      return;
    }

    await assignChapter(db, flowUser.id, chapterId);

    const refreshed = await getFlowUserByTgId(db, BigInt(tgId));
    const lang = resolveLang(
      refreshed?.lang ?? flowUser.lang,
      refreshed?.chapterDefaultLang ?? null,
    );

    const chapterOption = (await listActiveChapters(db)).find((c) => c.id === chapterId);
    const chapterName = chapterOption?.name ?? chapterId;
    await ctx.reply(`${getCatalog(lang).profile.chapterUpdatedPrefix} ${chapterName}`);
  };
}

// ---------------------------------------------------------------------------
// §4.5 — the generic step-answer listeners.
// ---------------------------------------------------------------------------
async function advanceAfterWrite(
  ctx: Context,
  db: DbClient["db"],
  flowUser: FlowUser,
  lang: BotLang,
): Promise<void> {
  const outcome = await reachReadyOrPrompt(ctx, db, flowUser, lang);
  if (outcome === "ready") {
    await ctx.reply(getCatalog(lang).profile.completedNotice);
  }
}

const FREE_TEXT_REQUIRED_FIELDS = new Set(["firstName", "lastName", "company", "position"]);
const FREE_TEXT_OPTIONAL_FIELDS = new Set([
  "phone",
  "email",
  "linksGithub",
  "linksLinkedin",
  "linksSite",
]);

export function makeProfileTextAnswerHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const text = ctx.message?.text;
    if (text === undefined || text.trim().length === 0 || text.startsWith("/")) {
      return;
    }

    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      return;
    }
    const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);

    const hasConsented = flowUser.consentPdAt !== null;
    const hasChapter = flowUser.chapterId !== null;
    const profile = hasConsented && hasChapter ? await getProfileByUserId(db, flowUser.id) : null;

    // §4.6's derive-then-gate discipline, restated here for the text
    // listener too (§4.5 steps 4-5): state is derived FRESH from the
    // database on every single message, never trusted from process memory —
    // the exact property AC1 exercises.
    const step = determineOnboardingStep(hasConsented, hasChapter, profile);

    if (step.kind !== "profile-field") {
      return;
    }

    // §4.5 step 2 — the phone step's Skip button shares this listener,
    // matched by literal button text ahead of general handling.
    if (step.field === "phone" && text === getCatalog(lang).profile.skipButton) {
      await markOptionalProfileFieldSkipped(db, flowUser.id, "phone", new Date());
      await advanceAfterWrite(ctx, db, flowUser, lang);
      return;
    }

    if (FREE_TEXT_REQUIRED_FIELDS.has(step.field)) {
      if (!isNonBlank(text)) {
        await ctx.reply(getCatalog(lang).profile.invalidAnswerPrefix);
        await sendProfileFieldPrompt(ctx, step.field, lang);
        return;
      }
      await writeRequiredProfileField(
        db,
        flowUser.id,
        step.field as "firstName" | "lastName" | "company" | "position",
        text.trim(),
        new Date(),
      );
      await advanceAfterWrite(ctx, db, flowUser, lang);
      return;
    }

    if (FREE_TEXT_OPTIONAL_FIELDS.has(step.field)) {
      const optionalField = step.field as OptionalProfileField;
      if (optionalField === "email") {
        // AC5/AC6's concrete error path: the submitted value is used ONLY to
        // call isValidEmailFormat, never written anywhere, never echoed back,
        // and not passed to any log call in this file (§6).
        if (!isValidEmailFormat(text.trim())) {
          await ctx.reply(getCatalog(lang).profile.invalidEmailFormat);
          return;
        }
        await writeOptionalProfileField(db, flowUser.id, "email", text.trim(), new Date());
        await advanceAfterWrite(ctx, db, flowUser, lang);
        return;
      }
      await writeOptionalProfileField(db, flowUser.id, optionalField, text.trim(), new Date());
      await advanceAfterWrite(ctx, db, flowUser, lang);
      return;
    }
    // step.field is "isStudent" or "experienceLevel" — those are collected
    // only via their own callback keyboards (§4.4); a plain text message
    // while on one of those steps has no defined meaning here.
  };
}

export function makeProfileContactHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      return;
    }
    const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);

    const hasConsented = flowUser.consentPdAt !== null;
    const hasChapter = flowUser.chapterId !== null;
    const profile = hasConsented && hasChapter ? await getProfileByUserId(db, flowUser.id) : null;
    const step = determineOnboardingStep(hasConsented, hasChapter, profile);
    if (step.kind !== "profile-field" || step.field !== "phone") {
      return;
    }

    const contact = ctx.message?.contact;
    if (contact === undefined) {
      return;
    }
    await writeOptionalProfileField(db, flowUser.id, "phone", contact.phone_number, new Date());
    await advanceAfterWrite(ctx, db, flowUser, lang);
  };
}

// ---------------------------------------------------------------------------
// §4.6 — skip/student/experience callback handlers. Each follows the
// identical derive-current-step-first, then gate the write on it discipline,
// restated here in the same order as the design so no implementer reorders
// the write before the gate.
// ---------------------------------------------------------------------------
async function resolveCallbackFlowUser(
  db: DbClient["db"],
  ctx: Context,
): Promise<{ flowUser: FlowUser; lang: BotLang } | null> {
  const tgId = ctx.from?.id;
  if (tgId === undefined) {
    return null;
  }
  const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
  if (flowUser === null) {
    return null;
  }
  const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);
  return { flowUser, lang };
}

export function makeProfileSkipCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    // Step 1 — resolve the acting user.
    const match = PROFILE_SKIP_CALLBACK_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const resolved = await resolveCallbackFlowUser(db, ctx);
    if (resolved === null || match === null) {
      await ctx.answerCallbackQuery();
      return;
    }
    const { flowUser, lang } = resolved;

    // Step 2 — always answer the callback, regardless of what follows.
    await ctx.answerCallbackQuery();

    const claimedField = match[1] as OptionalProfileField;
    // Step 3 — read hasConsented/hasChapter directly off flowUser; profile
    // read never happens while !hasConsented (the ternary short-circuit).
    const hasConsented = flowUser.consentPdAt !== null;
    const hasChapter = flowUser.chapterId !== null;
    const profile = hasConsented && hasChapter ? await getProfileByUserId(db, flowUser.id) : null;
    // Step 4 — derive fresh, before any write function is named or called.
    const step = determineOnboardingStep(hasConsented, hasChapter, profile);

    // Step 5 — the gate: write iff step.kind === "profile-field" AND
    // step.field matches this callback's claimed field. Every other outcome
    // is a no-op — no write function is called at all.
    if (step.kind === "profile-field" && step.field === claimedField) {
      // Step 6 — only past the gate, the matching write.
      await markOptionalProfileFieldSkipped(db, flowUser.id, claimedField, new Date());
    }

    // Step 7 — re-run the onboarding advance regardless of whether step 5-6
    // ran, so a stale tap never dead-ends silently.
    await advanceAfterWrite(ctx, db, flowUser, lang);
  };
}

export function makeProfileStudentCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = PROFILE_STUDENT_CALLBACK_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const resolved = await resolveCallbackFlowUser(db, ctx);
    if (resolved === null || match === null) {
      await ctx.answerCallbackQuery();
      return;
    }
    const { flowUser, lang } = resolved;
    await ctx.answerCallbackQuery();

    const answer = match[1];
    const hasConsented = flowUser.consentPdAt !== null;
    const hasChapter = flowUser.chapterId !== null;
    const profile = hasConsented && hasChapter ? await getProfileByUserId(db, flowUser.id) : null;
    const step = determineOnboardingStep(hasConsented, hasChapter, profile);

    if (step.kind === "profile-field" && step.field === "isStudent") {
      await writeRequiredProfileField(db, flowUser.id, "isStudent", answer === "yes", new Date());
    }

    await advanceAfterWrite(ctx, db, flowUser, lang);
  };
}

export function makeProfileExperienceCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = PROFILE_EXPERIENCE_CALLBACK_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const resolved = await resolveCallbackFlowUser(db, ctx);
    if (resolved === null || match === null) {
      await ctx.answerCallbackQuery();
      return;
    }
    const { flowUser, lang } = resolved;
    await ctx.answerCallbackQuery();

    const level = match[1];
    const hasConsented = flowUser.consentPdAt !== null;
    const hasChapter = flowUser.chapterId !== null;
    const profile = hasConsented && hasChapter ? await getProfileByUserId(db, flowUser.id) : null;
    const step = determineOnboardingStep(hasConsented, hasChapter, profile);

    if (step.kind === "profile-field" && step.field === "experienceLevel" && level !== undefined) {
      await writeRequiredProfileField(db, flowUser.id, "experienceLevel", level, new Date());
    }

    await advanceAfterWrite(ctx, db, flowUser, lang);
  };
}
