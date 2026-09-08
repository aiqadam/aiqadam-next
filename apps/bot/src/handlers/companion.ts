import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import {
  formatCompanionConfirmMessage,
  formatCompanionFieldsPrompt,
  getCompanionDisplayData,
  getInviteCodeById,
  parseCompanionConfirmMessage,
  parseCompanionFieldsMessage,
  parseCompanionReplyContext,
  redeemInviteCode,
} from "../domain/inviteCode.js";
import { sendLedgeredNotification, type NotificationSender } from "../domain/notification.js";
import { getEventByIdWithChapterTimezone } from "../domain/event.js";
import { getFlowUserByTgId } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";
import { composeRegistrationReply, resolveRegistrationOutcomeDisplayData } from "./registrationReply.js";

// docs/agents/design/REQ-039.md §3.2/§4/§6 -- the companion (+1)
// registration flow's own handler surface: the reply-to-message listener
// that catches the guest's free-text "Name | Company | Phone" answer to the
// prompt handlers/start.ts's resolveInviteDeepLink sends, the confirm-tap
// callback that performs the single combined write, and the shared host
// notification helper both this file's confirm callback AND
// handlers/start.ts's own returning-guest direct-redemption branch call
// (§2 Open Question 1 -- AC7 holds identically for both populations, the
// same "holds identically" reasoning the design's own §7 AC1 row already
// states). Framework code only (decisions/0004) -- every actual decision and
// write lives in domain/inviteCode.ts's redeemInviteCode.

export const COMPANION_CONFIRM_PATTERN = /^companion_confirm:(.+)$/;
export const COMPANION_CANCEL_CALLBACK = "companion:cancel";

function companyPlaceholder(company: string | null): string {
  return company !== null && company !== "" ? ` — ${company}` : "";
}

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
  return flowUser === null ? resolveLang(null, null) : resolveLang(flowUser.lang, flowUser.chapterDefaultLang);
}

// §6 -- shared by this file's own confirm-callback handler (a brand-new
// guest who just completed the reduced-field conversation) AND
// handlers/start.ts's resolveInviteDeepLink (a returning guest with an
// existing Profile row, redeemed directly per §2 Open Question 1's
// resolution) -- one notification mechanism, two call sites, per
// decisions/0004. `sendLedgeredNotification`'s own `(registrationId, kind)`
// unique-index idempotency (§0 table) makes a double-send structurally
// impossible even if both call sites somehow raced for the same
// registration.
export async function sendCompanionHostNotification(
  db: DbClient["db"],
  sender: NotificationSender,
  registrationId: string,
  hostUserId: string,
  guestUserId: string,
): Promise<void> {
  await sendLedgeredNotification({
    db,
    sender,
    registrationId,
    kind: "companion_registered",
    classification: "transactional",
    userId: hostUserId,
    composeMessage: async (lang) => {
      const catalog = getCatalog(lang);
      // §6 -- structurally incapable of reading phone/email: this query
      // (domain/inviteCode.ts's getCompanionDisplayData) never selects
      // either column at all (S3/S11).
      const display = await getCompanionDisplayData(db, guestUserId, lang);
      const text = catalog.companion.hostNotification
        .replace("{name}", display.displayName)
        .replace("{company}", companyPlaceholder(display.company));
      return { kind: "text" as const, text };
    },
  });
}

// ---------------------------------------------------------------------------
// §3.2 -- the generic reply-to-message text listener catching the guest's
// own "Name | Company | Phone" answer to the prompt resolveInviteDeepLink
// sent. Mirrors handlers/feedback.ts's makeFeedbackTextReplyHandler's exact
// shape (§6.3's own precedent): a stale/unrelated text message is silently
// ignored, never answered with an error.
// ---------------------------------------------------------------------------
export function makeCompanionTextReplyHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const text = ctx.message?.text;
    if (text === undefined || text.trim().length === 0 || text.startsWith("/")) {
      return;
    }

    const repliedToText = ctx.message?.reply_to_message?.text;
    if (repliedToText === undefined) {
      return;
    }
    const context = parseCompanionReplyContext(repliedToText);
    if (!context.ok) {
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
    const catalog = getCatalog(lang);

    const codeRow = await getInviteCodeById(db, context.inviteCodeId);
    if (codeRow === null || codeRow.grantsCompanionOf === null) {
      // Stale/forwarded reply against a code that no longer exists or is no
      // longer a companion code -- silently ignored, same discipline as an
      // unrecognized reply above.
      return;
    }

    const parsed = parseCompanionFieldsMessage(text);
    const event = await getEventByIdWithChapterTimezone(db, codeRow.eventId);
    const eventTitle = event?.title ?? "";

    if (!parsed.ok) {
      // §3.2 -- re-prompt, no write. Re-sends the SAME carrier (the ref
      // line encodes the same invite code id, formatCompanionFieldsPrompt
      // is the one function that composes it) so a subsequent reply keeps
      // resolving here.
      const errorLine =
        parsed.reason === "missing-name" ? catalog.companion.missingName : catalog.companion.missingPhone;
      await ctx.reply([errorLine, "", formatCompanionFieldsPrompt(eventTitle, codeRow.id, lang)].join("\n"), {
        reply_markup: { force_reply: true },
      });
      return;
    }

    // §4 -- no write here: renders the confirm message (the carrier for the
    // next, final step) with a single combined "Confirm & register" button.
    const confirmText = formatCompanionConfirmMessage(parsed.fields, eventTitle, lang);
    const keyboard = new InlineKeyboard()
      .text(catalog.companion.confirmButtonLabel, `companion_confirm:${codeRow.id}`)
      .text(catalog.companion.cancelButtonLabel, COMPANION_CANCEL_CALLBACK);
    await ctx.reply(confirmText, { reply_markup: keyboard });
  };
}

// ---------------------------------------------------------------------------
// §4 -- the companion_confirm:<inviteCodeId> callback: the single write
// trigger (§3.1 step 6).
// ---------------------------------------------------------------------------
export function makeCompanionConfirmCallbackHandler(db: DbClient["db"], sender: NotificationSender) {
  return async (ctx: Context): Promise<void> => {
    const match = COMPANION_CONFIRM_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const inviteCodeId = match?.[1];
    if (inviteCodeId === undefined) {
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

    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      await ctx.answerCallbackQuery();
      return;
    }

    // §4 step 1 -- re-parse the tapped message's own text. A stale/edited/
    // forwarded tap is refused with no write.
    const parsed = parseCompanionConfirmMessage(ctx.callbackQuery?.message?.text ?? "");
    if (!parsed.ok) {
      await ctx.answerCallbackQuery({ text: catalog.companion.staleMessage, show_alert: true });
      return;
    }

    const codeRow = await getInviteCodeById(db, inviteCodeId);
    if (codeRow === null || codeRow.grantsCompanionOf === null) {
      await ctx.answerCallbackQuery({ text: catalog.companion.staleMessage, show_alert: true });
      return;
    }

    // §4 step 2 -- the single shared transactional entry point (unchanged
    // for every other caller, extended in place per design §5).
    const outcome = await redeemInviteCode(
      db,
      flowUser.id,
      codeRow.code,
      codeRow.eventId,
      new Date(),
      parsed.fields,
    );
    await ctx.answerCallbackQuery();

    // §4 step 3 -- the guest's own result, via the SAME composeRegistrationReply
    // every other redemption outcome already uses (no new outcome kind).
    const display = await resolveRegistrationOutcomeDisplayData(db, outcome, codeRow.eventId, lang);
    await ctx.editMessageText(
      composeRegistrationReply(
        outcome,
        catalog,
        display.eventTitle,
        display.dateTimeText,
        display.waitlistPosition,
        display.registrationClosesAtText,
      ),
    );

    // §4 step 4 -- only on a writing outcome (a registration row was
    // actually created), the host is told.
    if (
      (outcome.kind === "admitted" || outcome.kind === "waitlisted" || outcome.kind === "requested") &&
      outcome.registrationId !== undefined
    ) {
      await sendCompanionHostNotification(db, sender, outcome.registrationId, codeRow.grantsCompanionOf, flowUser.id);
    }
  };
}

// ---------------------------------------------------------------------------
// §4 -- the Cancel button on the confirm message. Never reads or writes
// anything, same discipline as handlers/walkin.ts's own walkin:cancel
// handler.
// ---------------------------------------------------------------------------
export function makeCompanionCancelCallbackHandler() {
  return async (ctx: Context): Promise<void> => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(getCatalog(resolveLang(null, null)).companion.cancelled);
  };
}
