import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import {
  getRegistrationNoShowContext,
  isNoShowReasonCode,
  writeNoShowReason,
} from "../domain/registration.js";
import { getFlowUserByTgId } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// docs/agents/design/REQ-032.md §4 — the five fixed-reason buttons, the
// "other" free-text option, and the generic reply-to-message text listener.
// This file only sequences calls and sends replies (decisions/0004) — all
// persistence/derivation lives in domain/registration.ts. Every handler
// follows the derive-current-state-first, then gate the write on it
// discipline (REQ-019/REQ-030/REQ-031's own precedent): resolve the tapping/
// replying person, re-derive the registration's current no_show_reason
// fresh from the database, and only then decide whether to write.

export const NO_SHOW_REASON_PATTERN = /^noshow:reason:([a-z_]+):(.+)$/;
export const NO_SHOW_OTHER_PATTERN = /^noshow:other:(.+)$/;

// §4.4 — the "No-show ref: " literal, a fixed, non-localized machine-
// parseable anchor (same treatment as feedback.ts's FEEDBACK_REF_LINE_PREFIX
// / walkin.ts's "Name: "/"Company: "/"Phone: " prefixes) — not a sentence
// meant to be read meaningfully by a person in their own language.
export const NO_SHOW_REF_LINE_PREFIX = "No-show ref: ";

// §4.4 — formatNoShowTextPrompt: promptBody, a blank line, then one fixed-
// prefix ref line. Used only for the "other" free-text prompt (§4.2) — the
// fixed-reason buttons and the "other" button itself carry the
// registrationId directly in callback_data and need no ref line.
export function formatNoShowTextPrompt(promptBody: string, registrationId: string): string {
  return [promptBody, "", `${NO_SHOW_REF_LINE_PREFIX}${registrationId}`].join("\n");
}

export type ParseNoShowReplyResult = { ok: true; registrationId: string } | { ok: false };

// §4.4 — parseNoShowReplyContext: split on newlines, find the first line
// starting with the fixed ref-line prefix; its value (trimmed) is the
// registrationId. No field-disambiguation needed (unlike REQ-031's
// parseFeedbackReplyContext) — this flow has only one free-text slot per
// registration.
export function parseNoShowReplyContext(repliedToText: string): ParseNoShowReplyResult {
  const lines = repliedToText.split("\n");
  const refLine = lines.find((line) => line.startsWith(NO_SHOW_REF_LINE_PREFIX));
  if (refLine === undefined) {
    return { ok: false };
  }
  const registrationId = refLine.slice(NO_SHOW_REF_LINE_PREFIX.length).trim();
  return { ok: true, registrationId };
}

// ---------------------------------------------------------------------------
// §4.1 — the five fixed-reason buttons' callback handler.
// ---------------------------------------------------------------------------
export function makeNoShowReasonCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = NO_SHOW_REASON_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    if (match === null) {
      // Defensive — unreachable in practice: grammY only dispatches this
      // handler for callback_data already matching NO_SHOW_REASON_PATTERN.
      await ctx.answerCallbackQuery();
      return;
    }
    const codeStr = match[1] as string;
    const registrationId = match[2] as string;

    if (!isNoShowReasonCode(codeStr)) {
      // Defensive — unreachable in practice: the five buttons this design
      // ever sends (noShowJobs.ts's buildNoShowReasonButtons) only ever emit
      // one of these five literals by construction.
      await ctx.answerCallbackQuery();
      return;
    }

    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      await ctx.answerCallbackQuery();
      return;
    }

    const context = await getRegistrationNoShowContext(db, registrationId);
    const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);
    if (context === null) {
      await ctx.answerCallbackQuery({ text: getCatalog(lang).noShow.staleMessage, show_alert: true });
      return;
    }

    // S3 ownership check: a forwarded or otherwise leaked button tapped by a
    // different Telegram user resolves to a different flowUser.id than
    // context.userId and is refused here, before any write is attempted.
    if (context.userId !== flowUser.id) {
      await ctx.answerCallbackQuery({ text: getCatalog(lang).noShow.notYours, show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    // Gate: only write when no answer already exists (already-answered is a
    // no-op, never a second write).
    if (context.noShowReason === null) {
      await writeNoShowReason(db, registrationId, codeStr, new Date());
    }

    await ctx.reply(getCatalog(lang).noShow.thanksMessage);
  };
}

// ---------------------------------------------------------------------------
// §4.2 — the "other" free-text option's callback handler.
// ---------------------------------------------------------------------------
export function makeNoShowOtherCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = NO_SHOW_OTHER_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    if (match === null) {
      await ctx.answerCallbackQuery();
      return;
    }
    const registrationId = match[1] as string;

    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      await ctx.answerCallbackQuery();
      return;
    }

    const context = await getRegistrationNoShowContext(db, registrationId);
    const lang: BotLang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);
    if (context === null) {
      await ctx.answerCallbackQuery({ text: getCatalog(lang).noShow.staleMessage, show_alert: true });
      return;
    }

    if (context.userId !== flowUser.id) {
      await ctx.answerCallbackQuery({ text: getCatalog(lang).noShow.notYours, show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    // Gate: an already-answered registration gets a short notice instead of
    // a fresh free-text prompt — no second question is ever sent.
    if (context.noShowReason !== null) {
      await ctx.reply(getCatalog(lang).noShow.alreadyAnswered);
      return;
    }

    await ctx.reply(formatNoShowTextPrompt(getCatalog(lang).noShow.otherPrompt, registrationId), {
      reply_markup: { force_reply: true },
    });
  };
}

// ---------------------------------------------------------------------------
// §4.3 — the generic reply-to-message text listener: the free-text answer
// path. A ref line is still needed (even though there is only one
// free-text slot per registration, unlike REQ-031's three sibling fields)
// because the same person can hold more than one admitted-but-never-
// checked-in registration across different events at once — the ref line
// resolves WHICH registration a bare reply belongs to.
// ---------------------------------------------------------------------------
export function makeNoShowTextReplyHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const text = ctx.message?.text;
    if (text === undefined || text.trim().length === 0 || text.startsWith("/")) {
      return;
    }

    const repliedToText = ctx.message?.reply_to_message?.text;
    if (repliedToText === undefined) {
      return;
    }

    const parsed = parseNoShowReplyContext(repliedToText);
    if (!parsed.ok) {
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

    const context = await getRegistrationNoShowContext(db, parsed.registrationId);
    if (context === null || context.userId !== flowUser.id) {
      return;
    }

    // Gate: already answered — a reply to a still-repliable but now-
    // superseded prompt is a silent no-op.
    if (context.noShowReason !== null) {
      return;
    }

    const value = text.trim();
    if (value.length === 0) {
      return;
    }

    await writeNoShowReason(db, parsed.registrationId, value, new Date());

    const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);
    await ctx.reply(getCatalog(lang).noShow.thanksMessage);
  };
}
