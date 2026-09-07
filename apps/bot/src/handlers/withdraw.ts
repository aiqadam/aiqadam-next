import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { resolveActingUser } from "../domain/eventAuthorization.js";
import { getEventById, getEventByIdWithChapterTimezone } from "../domain/event.js";
import {
  decideWithdrawOutcome,
  getEventIdForRegistration,
  getRegistrationForEventAndUser,
  withdrawRegistration,
} from "../domain/registration.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { getFlowUserByTgId, getUserForNotificationById } from "../domain/user.js";
import { resolveLang } from "../i18n/resolveLang.js";
import { formatDateTimeInTimezone } from "../i18n/formatTimeInTimezone.js";

// docs/agents/design/REQ-022.md §4 — /withdraw <event_id>, the standalone
// entry point (§0), and its two confirm/cancel callback handlers. Following
// the `<domain>:<action>:<param>` callback_data convention this codebase
// already uses (chapter:<id>, consent:agree(:<payload>), register:<eventId>).

export const WITHDRAW_CONFIRM_PATTERN = /^withdraw:confirm:(.+)$/;
export const WITHDRAW_CANCEL_PATTERN = /^withdraw:cancel:(.+)$/;

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
  return resolveLang(flowUser?.lang ?? null, flowUser?.chapterDefaultLang ?? null);
}

// §4.1 — /withdraw <event_id> command.
export function makeWithdrawCommandHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      // §4.1 step 1 — defensive, unreachable via Telegram.
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const eventId = matchText(ctx).trim();
    if (eventId.length === 0) {
      // §4.1 step 2
      await ctx.reply(catalog.withdraw.usageNoId);
      return;
    }

    // §4.1 step 3
    const actingUser = await resolveActingUser(db, BigInt(tgId));
    if (actingUser === null) {
      await ctx.reply(catalog.profile.startFirst);
      return;
    }

    // §4.1 step 4 — display-only read, no lock.
    const registration = await getRegistrationForEventAndUser(db, eventId, actingUser.id);

    // §4.1 step 5 — decide against that read; ownerUserId is always
    // actingUser.id by construction of the query, so "not-owner" can never
    // fire from this entry point.
    const outcome = decideWithdrawOutcome({
      registrationExists: registration !== null,
      ownerUserId: registration !== null ? actingUser.id : null,
      actingUserId: actingUser.id,
      admission: registration?.admission ?? null,
      checkedInAt: registration?.checkedInAt ?? null,
    });

    // §4.1 step 6 — no confirmation shown for a refusal that is already
    // certain.
    if (outcome.kind === "not-found") {
      await ctx.reply(catalog.withdraw.refusedNotFound);
      return;
    }
    if (outcome.kind === "checked-in") {
      await ctx.reply(catalog.withdraw.refusedCheckedIn);
      return;
    }
    if (outcome.kind === "not-eligible") {
      await ctx.reply(catalog.withdraw.refusedNotEligible);
      return;
    }
    if (outcome.kind === "not-owner" || registration === null) {
      // Defensive/unreachable per §4.1 step 5's own reasoning.
      await ctx.reply(catalog.withdraw.refusedNotFound);
      return;
    }

    // §4.1 step 7 — eligible: show the confirmation prompt.
    const event = await getEventById(db, eventId);
    const eventTitle = event?.title ?? "";
    const keyboard = new InlineKeyboard()
      .text(catalog.withdraw.confirmButton, `withdraw:confirm:${registration.id}`)
      .text(catalog.withdraw.cancelButton, `withdraw:cancel:${registration.id}`);
    await ctx.reply([catalog.withdraw.confirmPrompt, eventTitle].join("\n"), { reply_markup: keyboard });
  };
}

// §4.2 — withdraw:confirm:<registrationId> callback.
export function makeWithdrawConfirmCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = WITHDRAW_CONFIRM_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const registrationId = match?.[1];
    if (registrationId === undefined) {
      // Defensive, unreachable in practice.
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

    // §4.2 step 1
    const actingUser = await resolveActingUser(db, BigInt(tgId));
    if (actingUser === null) {
      await ctx.answerCallbackQuery();
      await ctx.reply(catalog.profile.startFirst);
      return;
    }

    // §4.2 step 2 — the single authoritative check-and-write.
    const outcome = await withdrawRegistration(db, registrationId, actingUser.id, new Date());

    // §4.2 step 3
    await ctx.answerCallbackQuery();

    // docs/agents/design/REQ-023.md §6.2 — post-commit promotion
    // notification, sent to the PROMOTED person (a different Telegram user
    // than ctx.from), never gated on their broadcast_opt_in (S10:
    // transactional). This never blocks or affects the withdrawer's own
    // reply below.
    if (outcome.kind === "withdrawn" && outcome.promotion.kind === "promoted") {
      await sendPromotionNotification(
        db,
        ctx,
        registrationId,
        outcome.promotion.promotedUserId,
        outcome.promotion.qrToken,
      );
    }

    // §4.2 step 4 — reply per outcome.
    switch (outcome.kind) {
      case "withdrawn":
        await ctx.reply(catalog.withdraw.confirmedReply);
        return;
      case "not-owner":
        // One generic string — same non-disclosure discipline
        // resolveActingUser's other callers already follow (checkin.ts).
        await ctx.reply(catalog.withdraw.refusedNotFound);
        return;
      case "checked-in":
        await ctx.reply(catalog.withdraw.refusedCheckedIn);
        return;
      case "not-eligible":
        await ctx.reply(catalog.withdraw.refusedNotEligible);
        return;
      case "not-found":
        await ctx.reply(catalog.withdraw.refusedNotFound);
        return;
    }
  };
}

// docs/agents/design/REQ-023.md §6.2 — composes and sends the promotion
// notification to the promoted person's own tgId, using the PROMOTED
// person's own language, never the withdrawer's. The one call site in this
// codebase that addresses a chat other than the current update's own (ctx.api
// is bound to the bot instance, not to ctx's own chat).
async function sendPromotionNotification(
  db: DbClient["db"],
  ctx: Context,
  withdrawnRegistrationId: string,
  promotedUserId: string,
  qrToken: string,
): Promise<void> {
  const promotedUser = await getUserForNotificationById(db, promotedUserId);
  // Defensive guard (design §6.2 step 1): every row reaching 'admitted' was
  // created through a Telegram flow that always sets tgId — kept as a guard
  // rather than an assumption, per this codebase's no-speculation discipline.
  if (promotedUser === null || promotedUser.tgId === null) {
    return;
  }
  const lang = resolveLang(promotedUser.lang, promotedUser.chapterDefaultLang);
  const catalog = getCatalog(lang);

  const eventId = await getEventIdForRegistration(db, withdrawnRegistrationId);
  let eventTitle = "";
  let dateTimeText = "";
  if (eventId !== null) {
    const event = await getEventByIdWithChapterTimezone(db, eventId);
    if (event !== null) {
      eventTitle = event.title;
      const startsAtText =
        event.startsAt !== null ? formatDateTimeInTimezone(event.startsAt, event.chapterTimezone, lang) : "";
      const endsAtText =
        event.endsAt !== null ? formatDateTimeInTimezone(event.endsAt, event.chapterTimezone, lang) : "";
      dateTimeText = `${startsAtText}–${endsAtText}`;
    }
  }

  const text = [
    catalog.promotion.admittedPrefix,
    eventTitle,
    dateTimeText,
    `${catalog.promotion.qrLabel} ${qrToken}`,
    catalog.promotion.whatNext,
  ].join("\n");

  await ctx.api.sendMessage(promotedUser.tgId.toString(), text);
}

// §4.3 — withdraw:cancel:<registrationId> callback. No domain call of any
// kind — this is what makes AC1's dismissal path true by construction.
export function makeWithdrawCancelCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    await ctx.answerCallbackQuery();

    const tgId = ctx.from?.id;
    const lang = tgId !== undefined ? await resolveLangForTg(db, tgId) : resolveLang(null, null);
    await ctx.reply(getCatalog(lang).withdraw.cancelledReply);
  };
}
