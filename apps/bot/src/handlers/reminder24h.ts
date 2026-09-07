import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { resolveActingUser } from "../domain/eventAuthorization.js";
import { reconfirmRegistration, withdrawRegistration } from "../domain/registration.js";
import type { NotificationSender } from "../domain/notification.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { getFlowUserByTgId } from "../domain/user.js";
import { resolveLang } from "../i18n/resolveLang.js";
import { sendPromotionNotification } from "./withdraw.js";

// docs/agents/design/REQ-026.md §7 — the two reminder24h:<action>:<id>
// callback handlers. Same `<domain>:<action>:<param>` convention
// withdraw.ts already establishes.

export const REMINDER24H_CONFIRM_PATTERN = /^reminder24h:confirm:(.+)$/;
export const REMINDER24H_DECLINE_PATTERN = /^reminder24h:decline:(.+)$/;

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
  return resolveLang(flowUser?.lang ?? null, flowUser?.chapterDefaultLang ?? null);
}

// §7.1 — "I'll be there" confirm handler.
export function makeReminder24hConfirmCallbackHandler(
  db: DbClient["db"],
): (ctx: Context) => Promise<void> {
  return async (ctx: Context): Promise<void> => {
    const match = REMINDER24H_CONFIRM_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const registrationId = match?.[1];
    if (registrationId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const actingUser = await resolveActingUser(db, BigInt(tgId));
    if (actingUser === null) {
      await ctx.answerCallbackQuery();
      await ctx.reply(catalog.profile.startFirst);
      return;
    }

    const outcome = await reconfirmRegistration(db, registrationId, actingUser.id, new Date());

    await ctx.answerCallbackQuery();

    switch (outcome.kind) {
      case "reconfirmed":
        await ctx.reply(catalog.reminder24h.reconfirmedReply);
        return;
      case "not-owner":
      case "not-found":
        await ctx.reply(catalog.withdraw.refusedNotFound);
        return;
      case "not-eligible":
        await ctx.reply(catalog.withdraw.refusedNotEligible);
        return;
    }
  };
}

// §7.2 — "Can't make it" decline handler. Reuses withdrawRegistration and
// the exported sendPromotionNotification, unchanged — no reimplementation of
// withdrawal/promotion logic here.
export function makeReminder24hDeclineCallbackHandler(
  db: DbClient["db"],
  sender: NotificationSender,
): (ctx: Context) => Promise<void> {
  return async (ctx: Context): Promise<void> => {
    const match = REMINDER24H_DECLINE_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const registrationId = match?.[1];
    if (registrationId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const actingUser = await resolveActingUser(db, BigInt(tgId));
    if (actingUser === null) {
      await ctx.answerCallbackQuery();
      await ctx.reply(catalog.profile.startFirst);
      return;
    }

    const outcome = await withdrawRegistration(db, registrationId, actingUser.id, new Date());

    await ctx.answerCallbackQuery();

    if (outcome.kind === "withdrawn" && outcome.promotion.kind === "promoted") {
      await sendPromotionNotification(
        db,
        sender,
        outcome.promotion.registrationId,
        outcome.promotion.promotedUserId,
        outcome.promotion.qrToken,
      );
    }

    switch (outcome.kind) {
      case "withdrawn":
        await ctx.reply(catalog.withdraw.confirmedReply);
        return;
      case "not-owner":
      case "not-found":
        await ctx.reply(catalog.withdraw.refusedNotFound);
        return;
      case "checked-in":
        await ctx.reply(catalog.withdraw.refusedCheckedIn);
        return;
      case "not-eligible":
        await ctx.reply(catalog.withdraw.refusedNotEligible);
        return;
    }
  };
}
