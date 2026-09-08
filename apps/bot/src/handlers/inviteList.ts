import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { requireOrganizerForChapter } from "../domain/eventAuthorization.js";
import { getEventById } from "../domain/event.js";
import {
  addInviteListEntry,
  getEventIdForInviteListEntry,
  getInviteListEntryById,
  issueInviteListEntryCode,
  listInviteListEntries,
  parseInviteListAddArgs,
  removeInviteListEntry,
  type InviteListEntryView,
  type InviteListStatus,
} from "../domain/inviteList.js";
import { getUserWithChapterByTgId } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// docs/agents/design/REQ-040.md §4 -- the organizer-only named invitation
// list surface. Framework-free domain logic lives entirely in
// domain/inviteList.ts (decisions/0004) -- this file only sequences calls,
// checks authorization (S2), and sends replies, the same division
// organizerRequests.ts/inviteCodes.ts already establish.
//
// §6 -- no handler in this file ever sends a message to the list entry's own
// user_id. Every reply below is sent to ctx (the acting organizer's own
// chat) -- the code/link is displayed for the organizer to copy and share
// themselves.

export const INVITE_LIST_ISSUE_PATTERN = /^invite_list:issue:(.+)$/;
// Negative lookahead so this never also matches the confirm-step callback
// below (same "distinct, non-overlapping patterns" discipline
// organizerRequests.ts's req:approve vs req:approve_confirm already
// establishes).
export const INVITE_LIST_REMOVE_PATTERN = /^invite_list:remove:(?!confirm:)(.+)$/;
export const INVITE_LIST_REMOVE_CONFIRM_PATTERN = /^invite_list:remove:confirm:(.+)$/;

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const row = await getUserWithChapterByTgId(db, BigInt(tgId));
  return row === null ? resolveLang(null, null) : resolveLang(row.lang, row.chapterDefaultLang);
}

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

function statusLabelFor(status: InviteListStatus, catalog: ReturnType<typeof getCatalog>): string {
  switch (status) {
    case "invited":
      return catalog.inviteList.statusInvited;
    case "opened":
      return catalog.inviteList.statusOpened;
    case "registered":
      return catalog.inviteList.statusRegistered;
    case "attended":
      return catalog.inviteList.statusAttended;
  }
}

// §4.1 -- /invite_list_add <event_id> <name> | <company> | <position>
export function makeInviteListAddHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const parsed = parseInviteListAddArgs(matchText(ctx));
    if (!parsed.ok) {
      await ctx.reply(
        parsed.reason === "missing-event-id"
          ? catalog.inviteList.usageAddMissingEventId
          : catalog.inviteList.usageAddMissingName,
      );
      return;
    }

    const event = await getEventById(db, parsed.eventId);
    if (event === null) {
      await ctx.reply(catalog.inviteList.eventNotFound);
      return;
    }

    // §4 -- S2, checked on this handler before any write.
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.reply(catalog.inviteList.notAuthorized);
      return;
    }

    const result = await addInviteListEntry(
      db,
      authResult.user.id,
      event.id,
      parsed.name,
      parsed.company,
      parsed.position,
      new Date(),
    );

    await ctx.reply(
      catalog.inviteList.addedReply.replace("{name}", parsed.name).replace("{userId}", result.userId),
    );
  };
}

// §4.2 -- the S3-safe list view.
function renderInviteListMessage(
  eventTitle: string,
  items: InviteListEntryView[],
  lang: BotLang,
): { text: string; keyboard: InlineKeyboard } {
  const catalog = getCatalog(lang);
  const lines: string[] = [
    catalog.inviteList.listHeader.replace("{event}", eventTitle).replace("{count}", String(items.length)),
  ];
  const keyboard = new InlineKeyboard();

  if (items.length === 0) {
    lines.push(catalog.inviteList.listEmpty);
  } else {
    for (const item of items) {
      lines.push(
        catalog.inviteList.entryRowLabel
          .replace("{name}", item.name)
          .replace("{status}", statusLabelFor(item.status, catalog)),
      );
      // §4.2 -- Issue code appears only when invite_code_id IS NULL; Remove
      // always appears. Never a "Send" action (§6).
      if (item.inviteCodeId === null) {
        keyboard.text(catalog.inviteList.issueButtonLabel, `invite_list:issue:${item.entryId}`);
      }
      keyboard.text(catalog.inviteList.removeButtonLabel, `invite_list:remove:${item.entryId}`).row();
    }
  }

  return { text: lines.join("\n"), keyboard };
}

export function makeInviteListHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const eventId = matchText(ctx).trim();
    if (eventId.length === 0) {
      await ctx.reply(catalog.inviteList.eventNotFound);
      return;
    }

    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.reply(catalog.inviteList.eventNotFound);
      return;
    }

    // §4 -- S2, checked here too, not only on the add command.
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.reply(catalog.inviteList.notAuthorized);
      return;
    }

    const items = await listInviteListEntries(db, event.id);
    const view = renderInviteListMessage(event.title, items, lang);
    await ctx.reply(view.text, { reply_markup: view.keyboard });
  };
}

// §4.3 -- invite_list:issue:<entryId> callback -- composes REQ-037's
// issuePersonalInviteCode, unchanged.
export function makeInviteListIssueCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = INVITE_LIST_ISSUE_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const entryId = match?.[1];
    if (entryId === undefined) {
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

    const entry = await getInviteListEntryById(db, entryId);
    if (entry === null) {
      await ctx.answerCallbackQuery({ text: catalog.inviteList.entryNotFound, show_alert: true });
      return;
    }
    const event = await getEventById(db, entry.eventId);
    if (event === null) {
      await ctx.answerCallbackQuery({ text: catalog.inviteList.eventNotFound, show_alert: true });
      return;
    }

    // §4.3 -- S2 re-checked on this action too.
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.inviteList.notAuthorized, show_alert: true });
      return;
    }

    const evaluationTime = new Date();
    const expiresAt = event.startsAt ?? evaluationTime;
    const issued = await issueInviteListEntryCode(
      db,
      authResult.user.id,
      event.id,
      entry.entryId,
      entry.userId,
      expiresAt,
      evaluationTime,
    );

    await ctx.answerCallbackQuery();
    const link = `https://t.me/${ctx.me.username}?start=i_${issued.code}`;
    await ctx.reply(catalog.inviteList.issuedReply.replace("{code}", issued.code).replace("{link}", link));
  };
}

// §4.4 -- invite_list:remove:<entryId> -- the two-step confirm prompt.
export function makeInviteListRemoveCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = INVITE_LIST_REMOVE_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const entryId = match?.[1];
    if (entryId === undefined) {
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

    const entry = await getInviteListEntryById(db, entryId);
    if (entry === null) {
      await ctx.answerCallbackQuery({ text: catalog.inviteList.entryNotFound, show_alert: true });
      return;
    }
    const event = await getEventById(db, entry.eventId);
    if (event === null) {
      await ctx.answerCallbackQuery({ text: catalog.inviteList.eventNotFound, show_alert: true });
      return;
    }

    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.inviteList.notAuthorized, show_alert: true });
      return;
    }

    const keyboard = new InlineKeyboard()
      .text(catalog.inviteList.removeConfirmButtonLabel, `invite_list:remove:confirm:${entryId}`)
      .text(catalog.inviteList.removeCancelButtonLabel, "invite_list:remove_cancel");

    await ctx.answerCallbackQuery();
    await ctx.reply(catalog.inviteList.removeConfirmPrompt, { reply_markup: keyboard });
  };
}

// §4.4 -- invite_list:remove:confirm:<entryId> -- performs the removal. S2
// re-checked here too (both steps).
export function makeInviteListRemoveConfirmCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = INVITE_LIST_REMOVE_CONFIRM_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const entryId = match?.[1];
    if (entryId === undefined) {
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

    const eventId = await getEventIdForInviteListEntry(db, entryId);
    if (eventId === null) {
      await ctx.answerCallbackQuery({ text: catalog.inviteList.entryNotFound, show_alert: true });
      return;
    }
    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.answerCallbackQuery({ text: catalog.inviteList.eventNotFound, show_alert: true });
      return;
    }

    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.inviteList.notAuthorized, show_alert: true });
      return;
    }

    const outcome = await removeInviteListEntry(db, authResult.user.id, entryId, new Date());
    await ctx.answerCallbackQuery();
    if (outcome.kind === "not-found") {
      await ctx.reply(catalog.inviteList.entryNotFound);
      return;
    }
    await ctx.reply(catalog.inviteList.removedReply);
  };
}

// The Cancel/dismiss button on the remove-confirm prompt -- performs NO
// domain call at all, same discipline
// organizerRequests.ts's makeRequestApproveCancelCallbackHandler already
// establishes for its own dismiss button.
export function makeInviteListRemoveCancelCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    await ctx.answerCallbackQuery();

    const tgId = ctx.from?.id;
    const lang = tgId !== undefined ? await resolveLangForTg(db, tgId) : resolveLang(null, null);
    await ctx.reply(getCatalog(lang).inviteList.removeCancelledNote);
  };
}
