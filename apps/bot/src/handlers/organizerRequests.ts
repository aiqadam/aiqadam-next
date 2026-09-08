import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { requireOrganizerForChapter } from "../domain/eventAuthorization.js";
import { countAdmittedRegistrations, getEventById, getEventByIdWithChapterTimezone } from "../domain/event.js";
import {
  approveRequest,
  getEventIdForRegistration,
  getPendingRequestForOrganizer,
  listPendingRequestsForOrganizer,
  rejectRequest,
  type ApproveRequestResult,
  type PendingRequestListItem,
} from "../domain/registration.js";
import { sendLedgeredNotification, type NotificationSender } from "../domain/notification.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";
import { getUserWithChapterByTgId } from "../domain/user.js";
import { PAGE_SIZE, SEARCH_RESULT_LIMIT } from "./checkin.js";

// docs/agents/design/REQ-035.md -- the organizer-facing approve/reject
// surface for pending requests (admission='requested'). Framework-free
// domain logic lives entirely in domain/registration.ts (decisions/0004) --
// this file only sequences calls, checks authorization, and sends replies,
// the same division every other handler file in this codebase already
// follows.

export const REQ_OPEN_PATTERN = /^req:open:(.+)$/;
export const REQ_PAGE_PATTERN = /^req:page:([^:]+):(\d+)$/;
export const REQ_APPROVE_PATTERN = /^req:approve:(.+)$/;
export const REQ_APPROVE_CONFIRM_PATTERN = /^req:approve_confirm:(.+)$/;
export const REQ_APPROVE_CANCEL_PATTERN = /^req:approve_cancel:(.+)$/;
export const REQ_REJECT_PATTERN = /^req:reject:(.+)$/;

// design §6.4 -- the free-text reject-reason capture, same "force_reply +
// fixed ref-line prefix" mechanism handlers/noShow.ts already establishes
// for its own single free-text slot per registration (design §6.4/Open
// Question 5).
export const REJECT_REF_LINE_PREFIX = "Reject ref: ";

export function formatRejectReasonPrompt(promptBody: string, registrationId: string): string {
  return [promptBody, "", `${REJECT_REF_LINE_PREFIX}${registrationId}`].join("\n");
}

export type ParseRejectReplyResult = { ok: true; registrationId: string } | { ok: false };

export function parseRejectReplyContext(repliedToText: string): ParseRejectReplyResult {
  const lines = repliedToText.split("\n");
  const refLine = lines.find((line) => line.startsWith(REJECT_REF_LINE_PREFIX));
  if (refLine === undefined) {
    return { ok: false };
  }
  const registrationId = refLine.slice(REJECT_REF_LINE_PREFIX.length).trim();
  return { ok: true, registrationId };
}

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const row = await getUserWithChapterByTgId(db, BigInt(tgId));
  return row === null ? resolveLang(null, null) : resolveLang(row.lang, row.chapterDefaultLang);
}

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

// design §6.1 step 2 -- first-token-plus-remainder parse, the identical shape
// handlers/checkin.ts's own parseCheckinCommandArgs already establishes for
// the same "<event_id> [free-text search query]" command shape (Open
// Question 2 -- an implementation plumbing choice with no behavioral
// consequence either way).
function parseRequestsCommandArgs(raw: string): { eventId: string; query: string | null } {
  const trimmed = raw.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return { eventId: trimmed, query: null };
  }
  const eventId = trimmed.slice(0, firstSpace).trim();
  const query = trimmed.slice(firstSpace + 1).trim();
  return { eventId, query: query.length === 0 ? null : query };
}

function buildRequestsHeaderLine(lang: BotLang, eventTitle: string, count: number): string {
  return getCatalog(lang)
    .organizerRequests.listHeader.replace("{event}", eventTitle)
    .replace("{count}", String(count));
}

function buildRequestRowLabel(item: PendingRequestListItem): string {
  return item.company !== null ? `${item.displayName} — ${item.company}` : item.displayName;
}

export interface RequestsListView {
  text: string;
  keyboard: InlineKeyboard;
}

// design §6.1 step 5/step 6 -- renderRequestsListMessage: mirrors
// renderCheckinListMessage's shape (handlers/checkin.ts) -- header line with
// the event title and pending count, one inline-keyboard row per request
// (req:open:<registrationId>), pagination for the unfiltered view, a search
// hint on every render.
export function renderRequestsListMessage(
  eventTitle: string,
  eventId: string,
  items: PendingRequestListItem[],
  totalPending: number,
  page: { current: number; total: number } | null,
  truncatedCount: number | null,
  lang: BotLang,
): RequestsListView {
  const catalog = getCatalog(lang);
  const lines: string[] = [buildRequestsHeaderLine(lang, eventTitle, totalPending)];
  const keyboard = new InlineKeyboard();

  if (items.length === 0) {
    lines.push(page !== null ? catalog.organizerRequests.listEmpty : catalog.organizerRequests.searchNoMatches);
  } else {
    for (const item of items) {
      keyboard.text(buildRequestRowLabel(item), `req:open:${item.registrationId}`).row();
    }
  }

  if (page !== null) {
    if (page.current > 0) {
      keyboard.text("◀", `req:page:${eventId}:${page.current - 1}`);
    }
    keyboard.text(
      catalog.checkin.pageIndicator.replace("{current}", String(page.current + 1)).replace("{total}", String(page.total)),
      "req:page:noop",
    );
    if (page.current < page.total - 1) {
      keyboard.text("▶", `req:page:${eventId}:${page.current + 1}`);
    }
    keyboard.row();
  }

  if (truncatedCount !== null && truncatedCount > 0) {
    lines.push(catalog.checkin.searchTruncatedNote.replace("{count}", String(truncatedCount)));
  }

  lines.push(catalog.organizerRequests.searchHint);

  return { text: lines.join("\n"), keyboard };
}

// design §6.2 -- renderRequestDetailMessage: all six PendingRequestListItem
// fields (still never phone/email), plus Approve/Reject buttons.
export function renderRequestDetailMessage(
  eventTitle: string,
  item: PendingRequestListItem,
  lang: BotLang,
): RequestsListView {
  const catalog = getCatalog(lang);
  const studentText =
    item.isStudent === null
      ? catalog.profile.fieldNotSet
      : item.isStudent
        ? catalog.profile.studentYes
        : catalog.profile.studentNo;

  const lines = [
    eventTitle,
    item.displayName,
    `${catalog.profile.labelCompany} ${item.company ?? catalog.profile.fieldNotSet}`,
    `${catalog.profile.labelPosition} ${item.position ?? catalog.profile.fieldNotSet}`,
    `${catalog.profile.labelIsStudent} ${studentText}`,
    `${catalog.organizerRequests.detailSourceLabel} ${item.source}`,
  ];

  const keyboard = new InlineKeyboard()
    .text(catalog.organizerRequests.approveButton, `req:approve:${item.registrationId}`)
    .text(catalog.organizerRequests.rejectButton, `req:reject:${item.registrationId}`);

  return { text: lines.join("\n"), keyboard };
}

// design §1.1 -- fetch once, filter/derive in memory (the pending set for
// one event is bounded by that event's own capacity, same reasoning REQ-028's
// design states for its own check-in list). Composes the full list read, the
// search filter, and pagination into one RequestsListView.
async function buildRequestsView(
  db: DbClient["db"],
  eventId: string,
  eventTitle: string,
  query: string | null,
  page: number,
  lang: BotLang,
): Promise<RequestsListView> {
  const all = await listPendingRequestsForOrganizer(db, eventId, lang);

  if (query !== null) {
    const lowerQuery = query.toLowerCase();
    const matches = all.filter(
      (item) =>
        item.displayName.toLowerCase().includes(lowerQuery) ||
        (item.company !== null && item.company.toLowerCase().includes(lowerQuery)),
    );
    const truncatedCount = matches.length > SEARCH_RESULT_LIMIT ? matches.length - SEARCH_RESULT_LIMIT : null;
    const shown = matches.slice(0, SEARCH_RESULT_LIMIT);
    return renderRequestsListMessage(eventTitle, eventId, shown, all.length, null, truncatedCount, lang);
  }

  const pageCount = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 0), pageCount - 1);
  const start = clampedPage * PAGE_SIZE;
  const pageItems = all.slice(start, start + PAGE_SIZE);
  return renderRequestsListMessage(
    eventTitle,
    eventId,
    pageItems,
    all.length,
    { current: clampedPage, total: pageCount },
    null,
    lang,
  );
}

// design §6.1 -- /requests <event_id> [query] -- the list command.
export function makeRequestsListHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const { eventId, query } = parseRequestsCommandArgs(matchText(ctx));
    if (eventId.length === 0) {
      await ctx.reply(catalog.organizerRequests.usageNoId);
      return;
    }

    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.reply(catalog.organizerRequests.eventNotFound);
      return;
    }

    // design §6.1 step 4 -- S2: checked HERE, on the command handler, before
    // any list data is fetched.
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.reply(catalog.organizerRequests.notAuthorized);
      return;
    }

    const view = await buildRequestsView(db, event.id, event.title, query, 0, lang);
    await ctx.reply(view.text, { reply_markup: view.keyboard });
  };
}

// design §4.3-equivalent -- req:page:<eventId>:<pageNumber> callback. S2 is
// re-run here too, not only at the /requests entry point.
export function makeRequestsPageCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = REQ_PAGE_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const eventId = match?.[1];
    const pageNumberRaw = match?.[2];
    if (eventId === undefined || pageNumberRaw === undefined) {
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
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.notAuthorized, show_alert: true });
      return;
    }
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.notAuthorized, show_alert: true });
      return;
    }

    const pageNumber = Number(pageNumberRaw);
    const view = await buildRequestsView(db, eventId, event.title, null, pageNumber, lang);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
  };
}

// design §6.2 -- req:open:<registrationId> callback -- detail view.
export function makeRequestDetailCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = REQ_OPEN_PATTERN.exec(ctx.callbackQuery?.data ?? "");
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

    const eventId = await getEventIdForRegistration(db, registrationId);
    if (eventId === null) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.noLongerPending, show_alert: true });
      return;
    }
    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.noLongerPending, show_alert: true });
      return;
    }

    // design §6.2 -- re-run requireOrganizerForChapter on this action too,
    // not only the list entry (S2).
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.notAuthorized, show_alert: true });
      return;
    }

    const item = await getPendingRequestForOrganizer(db, registrationId, lang);
    if (item === null) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.noLongerPending, show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    const view = renderRequestDetailMessage(event.title, item, lang);
    await ctx.reply(view.text, { reply_markup: view.keyboard });
  };
}

// Shared by both the initial approve tap and the override-confirm tap
// (design §6.3 steps 3-5).
async function handleApprovalOutcome(
  ctx: Context,
  db: DbClient["db"],
  sender: NotificationSender,
  catalog: ReturnType<typeof getCatalog>,
  eventId: string,
  eventCapacity: number | null,
  registrationId: string,
  outcome: ApproveRequestResult,
): Promise<void> {
  if (outcome.kind === "not-found" || outcome.kind === "not-requested") {
    await ctx.answerCallbackQuery({ text: catalog.organizerRequests.noLongerPending, show_alert: true });
    return;
  }

  if (outcome.kind === "needs-override-confirmation") {
    const admittedCount = await countAdmittedRegistrations(db, eventId);
    const prompt = catalog.organizerRequests.overrideConfirmPrompt
      .replace("{admittedCount}", String(admittedCount))
      .replace("{capacity}", String(eventCapacity ?? 0));
    const keyboard = new InlineKeyboard()
      .text(catalog.organizerRequests.overrideConfirmButton, `req:approve_confirm:${registrationId}`)
      .text(catalog.organizerRequests.overrideCancelButton, `req:approve_cancel:${registrationId}`);
    await ctx.answerCallbackQuery();
    await ctx.reply(prompt, { reply_markup: keyboard });
    return;
  }

  // "approve" / "approve-override" -- send the approval notification (§5),
  // then reply to the organizer confirming the action.
  await ctx.answerCallbackQuery();
  if (outcome.userId !== undefined) {
    await sendApprovalNotification(db, sender, registrationId, outcome.userId);
  }
  await ctx.reply(catalog.organizerRequests.approvedReplyToOrganizer);
}

// design §6.3 -- req:approve:<registrationId> callback (overrideConfirmed
// always false here).
export function makeRequestApproveCallbackHandler(db: DbClient["db"], sender: NotificationSender) {
  return async (ctx: Context): Promise<void> => {
    const match = REQ_APPROVE_PATTERN.exec(ctx.callbackQuery?.data ?? "");
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

    const eventId = await getEventIdForRegistration(db, registrationId);
    if (eventId === null) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.noLongerPending, show_alert: true });
      return;
    }
    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.noLongerPending, show_alert: true });
      return;
    }

    // design §6.3 step 1 -- re-run against the registration's OWN event's
    // chapterId, not the caller's (AC7).
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.notAuthorized, show_alert: true });
      return;
    }

    const outcome = await approveRequest(db, registrationId, authResult.user.id, false, new Date());
    await handleApprovalOutcome(ctx, db, sender, catalog, eventId, event.capacity, registrationId, outcome);
  };
}

// design §6.3 step 4 -- req:approve_confirm:<registrationId> callback
// (re-invokes the same write with overrideConfirmed:true).
export function makeRequestApproveConfirmCallbackHandler(db: DbClient["db"], sender: NotificationSender) {
  return async (ctx: Context): Promise<void> => {
    const match = REQ_APPROVE_CONFIRM_PATTERN.exec(ctx.callbackQuery?.data ?? "");
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

    const eventId = await getEventIdForRegistration(db, registrationId);
    if (eventId === null) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.noLongerPending, show_alert: true });
      return;
    }
    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.noLongerPending, show_alert: true });
      return;
    }

    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.notAuthorized, show_alert: true });
      return;
    }

    const outcome = await approveRequest(db, registrationId, authResult.user.id, true, new Date());
    await handleApprovalOutcome(ctx, db, sender, catalog, eventId, event.capacity, registrationId, outcome);
  };
}

// design §6.3 step 4 -- req:approve_cancel:<registrationId> callback: the
// Cancel/dismiss button. Performs NO domain call at all (AC4's "dismissing it
// leaves admission='requested' unchanged" -- true by construction, since no
// approveRequest/writeAuditLog call site exists on this path).
export function makeRequestApproveCancelCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    await ctx.answerCallbackQuery();

    const tgId = ctx.from?.id;
    const lang = tgId !== undefined ? await resolveLangForTg(db, tgId) : resolveLang(null, null);
    await ctx.reply(getCatalog(lang).organizerRequests.overrideCancelledNote);
  };
}

// design §5 -- the approval notification, kind: 'admission_result',
// classification: 'transactional' (S10 -- reaches a user with
// broadcast_opt_in=false, since a transactional send never reads that flag).
async function sendApprovalNotification(
  db: DbClient["db"],
  sender: NotificationSender,
  registrationId: string,
  userId: string,
): Promise<void> {
  await sendLedgeredNotification({
    db,
    sender,
    registrationId,
    kind: "admission_result",
    classification: "transactional",
    userId,
    composeMessage: async (lang) => {
      const catalog = getCatalog(lang);
      const eventId = await getEventIdForRegistration(db, registrationId);
      let eventTitle = "";
      if (eventId !== null) {
        const event = await getEventByIdWithChapterTimezone(db, eventId);
        if (event !== null) {
          eventTitle = event.title;
        }
      }
      const text = catalog.organizerRequests.approvedNotification.replace("{event}", eventTitle);
      return { kind: "text" as const, text };
    },
  });
}

// design §5 -- the rejection notification, same kind/classification. The
// composed text ALWAYS carries both the organizer's verbatim reason and the
// onward path (catalog.event.deepLinkSeeUpcoming, §0.4 -- zero Wishlist).
async function sendRejectionNotification(
  db: DbClient["db"],
  sender: NotificationSender,
  registrationId: string,
  userId: string,
  reason: string,
): Promise<void> {
  await sendLedgeredNotification({
    db,
    sender,
    registrationId,
    kind: "admission_result",
    classification: "transactional",
    userId,
    composeMessage: async (lang) => {
      const catalog = getCatalog(lang);
      const eventId = await getEventIdForRegistration(db, registrationId);
      let eventTitle = "";
      if (eventId !== null) {
        const event = await getEventByIdWithChapterTimezone(db, eventId);
        if (event !== null) {
          eventTitle = event.title;
        }
      }
      const text = [
        catalog.organizerRequests.rejectedNotificationPrefix.replace("{event}", eventTitle),
        `${catalog.organizerRequests.rejectedNotificationReasonPrefix} ${reason}`,
        catalog.event.deepLinkSeeUpcoming,
      ].join("\n");
      return { kind: "text" as const, text };
    },
  });
}

// design §6.4 -- req:reject:<registrationId> callback: prompts the organizer
// for a reason via force_reply.
export function makeRequestRejectCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = REQ_REJECT_PATTERN.exec(ctx.callbackQuery?.data ?? "");
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

    const eventId = await getEventIdForRegistration(db, registrationId);
    if (eventId === null) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.noLongerPending, show_alert: true });
      return;
    }
    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.noLongerPending, show_alert: true });
      return;
    }

    // design §6.4 step 1 -- same re-run discipline as §6.3 step 1.
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.notAuthorized, show_alert: true });
      return;
    }

    const item = await getPendingRequestForOrganizer(db, registrationId, lang);
    if (item === null) {
      await ctx.answerCallbackQuery({ text: catalog.organizerRequests.noLongerPending, show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.reply(formatRejectReasonPrompt(catalog.organizerRequests.rejectReasonPrompt, registrationId), {
      reply_markup: { force_reply: true },
    });
  };
}

// design §6.4 step 3 -- the generic reply-to-message text listener: the
// free-text reason answer path, same shape as handlers/noShow.ts's
// makeNoShowTextReplyHandler. Re-runs requireOrganizerForChapter here too
// (S2) -- a bare text reply is itself the write-triggering action, not only
// the button tap that preceded it.
export function makeRequestRejectTextReplyHandler(db: DbClient["db"], sender: NotificationSender) {
  return async (ctx: Context): Promise<void> => {
    const text = ctx.message?.text;
    if (text === undefined || text.trim().length === 0 || text.startsWith("/")) {
      return;
    }

    const repliedToText = ctx.message?.reply_to_message?.text;
    if (repliedToText === undefined) {
      return;
    }

    const parsed = parseRejectReplyContext(repliedToText);
    if (!parsed.ok) {
      return;
    }

    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }

    const eventId = await getEventIdForRegistration(db, parsed.registrationId);
    if (eventId === null) {
      return;
    }
    const event = await getEventById(db, eventId);
    if (event === null) {
      return;
    }

    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      // Silent refusal -- no domain call, no confirmation leak (same
      // discipline as a forwarded/leaked prompt in handlers/noShow.ts).
      return;
    }

    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);
    const reason = text.trim();

    const outcome = await rejectRequest(db, parsed.registrationId, authResult.user.id, reason, new Date());

    if (outcome.kind !== "reject") {
      await ctx.reply(catalog.organizerRequests.noLongerPending);
      return;
    }

    if (outcome.userId !== undefined) {
      await sendRejectionNotification(db, sender, parsed.registrationId, outcome.userId, reason);
    }
    await ctx.reply(catalog.organizerRequests.rejectedReplyToOrganizer);
  };
}
