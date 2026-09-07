import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import {
  determineFeedbackFlowStep,
  formatFeedbackTextPrompt,
  getFeedbackByRegistrationId,
  isFeedbackSkipReply,
  isValidNpsValue,
  markFeedbackFieldSkipped,
  parseFeedbackReplyContext,
  parseTopicVotes,
  writeFeedbackNps,
  writeFeedbackOptionalField,
  type FeedbackOptionalField,
} from "../domain/feedback.js";
import { getRegistrationFeedbackContext } from "../domain/registration.js";
import {
  getFlowUserByTgId,
  getUserFeedbackStateById,
  writeBroadcastOptInAnswer,
  type FlowUser,
} from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// docs/agents/design/REQ-031.md §6 — the NPS callback, the broadcast-ask
// callback, and the generic reply-to-message text listener. This file only
// sequences calls and sends replies (decisions/0004) — all persistence/
// derivation lives in domain/feedback.ts, domain/registration.ts,
// domain/user.ts.

export const FEEDBACK_NPS_PATTERN = /^feedback:nps:(\d{1,2}):(.+)$/;
export const FEEDBACK_BROADCAST_PATTERN = /^feedback:broadcast:(yes|no):(.+)$/;

// ---------------------------------------------------------------------------
// §6.4 — advanceFeedbackFlow: the shared "send the next prompt, or announce
// completion" step. Called from every write path below, always as the final
// step, whether or not that path's own gate actually wrote anything.
// ---------------------------------------------------------------------------
function buildNpsKeyboard(registrationId: string): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (let value = 0; value <= 10; value += 1) {
    keyboard.text(String(value), `feedback:nps:${value}:${registrationId}`);
    if (value % 4 === 3) {
      keyboard.row();
    }
  }
  return keyboard;
}

function buildBroadcastAskKeyboard(registrationId: string, lang: BotLang): InlineKeyboard {
  const catalog = getCatalog(lang).feedback;
  return new InlineKeyboard()
    .text(catalog.broadcastYesLabel, `feedback:broadcast:yes:${registrationId}`)
    .text(catalog.broadcastNoLabel, `feedback:broadcast:no:${registrationId}`);
}

export async function advanceFeedbackFlow(
  ctx: Context,
  db: DbClient["db"],
  registrationId: string,
  userId: string,
  lang: BotLang,
): Promise<"prompted" | "complete"> {
  const catalog = getCatalog(lang).feedback;

  const feedback = await getFeedbackByRegistrationId(db, registrationId);
  const userState = await getUserFeedbackStateById(db, userId);
  const step = determineFeedbackFlowStep(feedback, userState?.broadcastOptInAskedAt ?? null);

  if (step.kind === "feedback-field") {
    if (step.field === "nps") {
      await ctx.reply(catalog.npsPrompt, { reply_markup: buildNpsKeyboard(registrationId) });
      return "prompted";
    }
    const promptBody =
      step.field === "liked"
        ? catalog.likedPrompt
        : step.field === "improve"
          ? catalog.improvePrompt
          : catalog.topicVotesPrompt;
    const text = formatFeedbackTextPrompt(
      promptBody,
      registrationId,
      step.field as FeedbackOptionalField,
    );
    await ctx.reply(text, { reply_markup: { force_reply: true } });
    return "prompted";
  }

  if (step.kind === "broadcast-ask") {
    await ctx.reply(catalog.broadcastAskPrompt, {
      reply_markup: buildBroadcastAskKeyboard(registrationId, lang),
    });
    return "prompted";
  }

  await ctx.reply(catalog.completedNotice);
  return "complete";
}

// ---------------------------------------------------------------------------
// §6.1 — the NPS callback.
// ---------------------------------------------------------------------------
export function makeFeedbackNpsCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = FEEDBACK_NPS_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    if (match === null) {
      await ctx.answerCallbackQuery();
      return;
    }
    const npsStr = match[1] as string;
    const registrationId = match[2] as string;
    const nps = Number(npsStr);

    if (!isValidNpsValue(nps)) {
      // Defensive — unreachable in practice (§2.3): the eleven buttons this
      // design ever sends already emit exactly these eleven values.
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

    const context = await getRegistrationFeedbackContext(db, registrationId);
    const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);
    if (context === null) {
      await ctx.answerCallbackQuery({ text: getCatalog(lang).feedback.staleMessage, show_alert: true });
      return;
    }

    // S3 ownership check: a forwarded or otherwise leaked button tapped by a
    // different Telegram user resolves to a different flowUser.id than
    // context.userId and is refused here, before any write is attempted.
    if (context.userId !== flowUser.id) {
      await ctx.answerCallbackQuery({
        text: getCatalog(lang).feedback.notYourFeedback,
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    const feedback = await getFeedbackByRegistrationId(db, registrationId);
    const userState = await getUserFeedbackStateById(db, flowUser.id);
    const step = determineFeedbackFlowStep(feedback, userState?.broadcastOptInAskedAt ?? null);

    if (step.kind === "feedback-field" && step.field === "nps") {
      await writeFeedbackNps(db, registrationId, nps, new Date());
    }

    await advanceFeedbackFlow(ctx, db, registrationId, flowUser.id, lang);
  };
}

// ---------------------------------------------------------------------------
// §6.2 — the broadcast-ask callback. AC5's "does not ask again" is a
// structural impossibility: a stale re-tap after broadcast_opt_in_asked_at
// is already set re-derives step.kind === "complete" here, never
// "broadcast-ask" again, failing this gate and writing nothing.
// ---------------------------------------------------------------------------
export function makeFeedbackBroadcastCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = FEEDBACK_BROADCAST_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    if (match === null) {
      await ctx.answerCallbackQuery();
      return;
    }
    const answerToken = match[1] as string;
    const registrationId = match[2] as string;

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

    const context = await getRegistrationFeedbackContext(db, registrationId);
    const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);
    if (context === null) {
      await ctx.answerCallbackQuery({ text: getCatalog(lang).feedback.staleMessage, show_alert: true });
      return;
    }

    if (context.userId !== flowUser.id) {
      await ctx.answerCallbackQuery({
        text: getCatalog(lang).feedback.notYourFeedback,
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    const feedback = await getFeedbackByRegistrationId(db, registrationId);
    const userState = await getUserFeedbackStateById(db, flowUser.id);
    const step = determineFeedbackFlowStep(feedback, userState?.broadcastOptInAskedAt ?? null);

    if (step.kind === "broadcast-ask") {
      await writeBroadcastOptInAnswer(db, flowUser.id, answerToken === "yes", new Date());
    }

    await advanceFeedbackFlow(ctx, db, registrationId, flowUser.id, lang);
  };
}

// ---------------------------------------------------------------------------
// §6.3 — the generic reply-to-message text listener. §1.2's fix: step 8's
// field-match gate is what makes "a stale reply to an already-superseded
// prompt is silently ignored" actually true.
// ---------------------------------------------------------------------------
export function makeFeedbackTextReplyHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const text = ctx.message?.text;
    if (text === undefined || text.trim().length === 0 || text.startsWith("/")) {
      return;
    }

    const repliedToText = ctx.message?.reply_to_message?.text;
    if (repliedToText === undefined) {
      return;
    }

    const parsed = parseFeedbackReplyContext(repliedToText);
    if (!parsed.ok) {
      return;
    }

    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const flowUser: FlowUser | null = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      return;
    }

    const context = await getRegistrationFeedbackContext(db, parsed.registrationId);
    if (context === null || context.userId !== flowUser.id) {
      return;
    }

    const feedback = await getFeedbackByRegistrationId(db, parsed.registrationId);
    const userState = await getUserFeedbackStateById(db, flowUser.id);
    const step = determineFeedbackFlowStep(feedback, userState?.broadcastOptInAskedAt ?? null);

    // §1.2's field-match gate: the first two clauses match §1.2/§3.2 (nps is
    // never text-answerable); the third clause is the fix itself — a stale
    // reply naming a different, still-valid sibling field than the one the
    // flow currently expects is a no-op, never misattributed to the wrong
    // field.
    if (step.kind !== "feedback-field" || step.field === "nps" || step.field !== parsed.field) {
      return;
    }

    const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);

    if (isFeedbackSkipReply(text, getCatalog(lang).feedback.skipButton)) {
      await markFeedbackFieldSkipped(db, parsed.registrationId, step.field, new Date());
    } else {
      const value = step.field === "topicVotes" ? parseTopicVotes(text) : text.trim();
      await writeFeedbackOptionalField(db, parsed.registrationId, step.field, value, new Date());
    }

    await advanceFeedbackFlow(ctx, db, parsed.registrationId, flowUser.id, lang);
  };
}
