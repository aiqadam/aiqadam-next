import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { requireOrganizerForChapter } from "../domain/eventAuthorization.js";
import { countAdmittedRegistrations, getEventById } from "../domain/event.js";
import {
  commitWalkin,
  formatWalkinConfirmMessage,
  formatWalkinOverrideMessage,
  parseWalkinArgs,
  parseWalkinMessageFields,
  validateWalkinFields,
} from "../domain/walkin.js";
import { getUserWithChapterByTgId } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// docs/agents/design/REQ-030.md §8 -- command wiring only: this file
// sequences calls into the framework-free domain module (domain/walkin.ts)
// and composes replies. No domain logic lives here (decisions/0004).

export const WALKIN_CONFIRM_PATTERN = /^walkin:confirm:(.+)$/;
export const WALKIN_OVERRIDE_PATTERN = /^walkin:override:(.+)$/;

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const row = await getUserWithChapterByTgId(db, BigInt(tgId));
  return row === null ? resolveLang(null, null) : resolveLang(row.lang, row.chapterDefaultLang);
}

// §7.2/AC2/AC5 -- "{company}" is omitted with its own separator when empty,
// same convention checkinQr.ts's companyPlaceholder already establishes.
function companyPlaceholder(company: string): string {
  return company !== "" ? ` — ${company}` : "";
}

// ---------------------------------------------------------------------------
// §8.1 -- /walkin <event_id> <name>|<company>|<phone>
// ---------------------------------------------------------------------------
export function makeWalkinCommandHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const parsed = parseWalkinArgs(matchText(ctx));
    if (!parsed.ok) {
      await ctx.reply(catalog.walkin.usage);
      return;
    }

    const event = await getEventById(db, parsed.args.eventId);
    if (event === null) {
      await ctx.reply(catalog.walkin.eventNotFound);
      return;
    }

    // §8.1 step 5 -- AC6's negative case: requireOrganizerForChapter, never
    // requireEventStaffForEvent.
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.reply(catalog.walkin.notAuthorized);
      return;
    }

    const fieldsValid = validateWalkinFields(parsed.args);
    if (!fieldsValid.ok) {
      await ctx.reply(
        fieldsValid.reason === "missing-name" ? catalog.walkin.missingName : catalog.walkin.missingPhone,
      );
      return;
    }

    // §8.1 step 7 -- NO write of any kind happens in this handler (AC1).
    const text = formatWalkinConfirmMessage(
      {
        eventTitle: event.title,
        name: parsed.args.name,
        company: parsed.args.company,
        phone: parsed.args.phone,
      },
      lang,
    );
    const keyboard = new InlineKeyboard()
      .text(catalog.walkin.confirmButtonLabel, `walkin:confirm:${event.id}`)
      .text(catalog.walkin.cancelButtonLabel, "walkin:cancel");
    await ctx.reply(text, { reply_markup: keyboard });
  };
}

// design §8.2/§8.3's shared outcome-to-reply handling, used by both the
// confirm and override callback handlers (identical beyond the
// overrideConfirmed flag passed into commitWalkin).
async function handleWalkinCommit(
  ctx: Context,
  db: DbClient["db"],
  eventId: string,
  organizerUserId: string,
  lang: BotLang,
  parsedFields: { name: string; company: string; phone: string },
  overrideConfirmed: boolean,
): Promise<void> {
  const catalog = getCatalog(lang);
  const outcome = await commitWalkin(db, eventId, organizerUserId, parsedFields, overrideConfirmed, new Date());

  if (outcome.kind === "event-not-ready") {
    await ctx.answerCallbackQuery({ text: catalog.walkin.eventNotReady, show_alert: true });
    return;
  }
  if (outcome.kind === "event-cancelled") {
    await ctx.answerCallbackQuery({ text: catalog.walkin.eventCancelled, show_alert: true });
    return;
  }
  if (outcome.kind === "event-finished") {
    await ctx.answerCallbackQuery({ text: catalog.walkin.eventFinished, show_alert: true });
    return;
  }
  if (outcome.kind === "already-checked-in") {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(catalog.walkin.alreadyCheckedIn);
    return;
  }
  if (outcome.kind === "check-in-existing-admitted" || outcome.kind === "admit-and-check-in") {
    await ctx.answerCallbackQuery();
    const text = catalog.walkin.success
      .replace("{name}", parsedFields.name)
      .replace("{company}", companyPlaceholder(parsedFields.company));
    await ctx.editMessageText(text);
    return;
  }
  // "needs-override-confirmation" -- only reachable from the confirm tap
  // (§8.2 step 10); overrideConfirmed: true makes this structurally
  // unreachable from the override tap (§8.3).
  const event = await getEventById(db, eventId);
  const admittedCount = await countAdmittedRegistrations(db, eventId);
  await ctx.answerCallbackQuery();
  const text = formatWalkinOverrideMessage(
    {
      eventTitle: event?.title ?? "",
      name: parsedFields.name,
      company: parsedFields.company,
      phone: parsedFields.phone,
    },
    admittedCount,
    event?.capacity ?? 0,
    lang,
  );
  const keyboard = new InlineKeyboard()
    .text(catalog.walkin.overrideConfirmButtonLabel, `walkin:override:${eventId}`)
    .text(catalog.walkin.overrideDismissButtonLabel, "walkin:cancel");
  await ctx.editMessageText(text, { reply_markup: keyboard });
}

// ---------------------------------------------------------------------------
// §8.2 -- walkin:confirm:<eventId> callback
// ---------------------------------------------------------------------------
export function makeWalkinConfirmCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = WALKIN_CONFIRM_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const eventId = match?.[1];
    if (eventId === undefined) {
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

    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.answerCallbackQuery({ text: catalog.walkin.eventNotFound, show_alert: true });
      return;
    }

    // §8.2 step 4 -- re-authorization, mirrors REQ-028/029's discipline.
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.walkin.notAuthorized, show_alert: true });
      return;
    }

    const parsed = parseWalkinMessageFields(ctx.callbackQuery?.message?.text ?? "");
    if (!parsed.ok) {
      await ctx.answerCallbackQuery({ text: catalog.walkin.staleMessage, show_alert: true });
      return;
    }

    await handleWalkinCommit(ctx, db, eventId, authResult.user.id, lang, parsed.fields, false);
  };
}

// ---------------------------------------------------------------------------
// §8.3 -- walkin:override:<eventId> callback
// ---------------------------------------------------------------------------
export function makeWalkinOverrideCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = WALKIN_OVERRIDE_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const eventId = match?.[1];
    if (eventId === undefined) {
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

    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.answerCallbackQuery({ text: catalog.walkin.eventNotFound, show_alert: true });
      return;
    }

    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.walkin.notAuthorized, show_alert: true });
      return;
    }

    const parsed = parseWalkinMessageFields(ctx.callbackQuery?.message?.text ?? "");
    if (!parsed.ok) {
      await ctx.answerCallbackQuery({ text: catalog.walkin.staleMessage, show_alert: true });
      return;
    }

    await handleWalkinCommit(ctx, db, eventId, authResult.user.id, lang, parsed.fields, true);
  };
}

// ---------------------------------------------------------------------------
// §8.4 -- walkin:cancel callback, shared by both the initial Cancel button
// and the override step's Dismiss button. Never reads or writes anything.
// ---------------------------------------------------------------------------
export function makeWalkinCancelCallbackHandler() {
  return async (ctx: Context): Promise<void> => {
    await ctx.answerCallbackQuery();
    // No `db` parameter (§8.4) -- the message's own text carries no locale
    // hint, so this falls back to resolveLang's fixed final fallback ("ru"),
    // same shape every other lang-less path in this codebase uses.
    await ctx.editMessageText(getCatalog(resolveLang(null, null)).walkin.cancelled);
  };
}
