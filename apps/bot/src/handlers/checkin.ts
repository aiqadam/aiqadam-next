import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { requireEventStaffForEvent, resolveActingUser } from "../domain/eventStaffAuthorization.js";
import { countAdmittedRegistrations, getEventById } from "../domain/event.js";
import {
  countCheckedIn,
  getEventIdForRegistration,
  listAdmittedRegistrantsForCheckin,
  toggleCheckIn,
  type CheckinListItem,
} from "../domain/registration.js";
import { getUserWithChapterByTgId } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// docs/agents/design/REQ-028.md — the REAL implementation of REQ-018's
// `/checkin <event_id>` authorization-only stub: the manual check-in door
// list, its toggle, pagination, and command-argument search (design §1).

// design §1.4 — page size / search cap. No acceptance criterion pins an
// exact number; chosen only so AC6's ">=10 attendees, exactly one match"
// scenario is comfortably inside both.
export const PAGE_SIZE = 10;
export const SEARCH_RESULT_LIMIT = 20;

// design §4.2/§4.3 — callback_data patterns. The toggle button carries ONLY
// registrationId (design §1.4/§3.2 -- the 64-byte budget and, load-bearingly,
// AC1's write-time recheck both depend on no admission/eventId value ever
// riding in this string).
export const CHECKIN_TOGGLE_PATTERN = /^checkin:toggle:(.+)$/;
export const CHECKIN_PAGE_PATTERN = /^checkin:page:([^:]+):(\d+)$/;
// design §4.4 -- a fixed, never-registered no-op callback_data for the
// non-interactive page-position label button.
const CHECKIN_PAGE_NOOP = "checkin:page:noop";

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const row = await getUserWithChapterByTgId(db, BigInt(tgId));
  return row === null ? resolveLang(null, null) : resolveLang(row.lang, row.chapterDefaultLang);
}

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

// design §4.1 step 3 -- first-token-plus-remainder parse (not
// first-two-tokens): a search query may itself contain spaces (a full name).
function parseCheckinCommandArgs(raw: string): { eventId: string; query: string | null } {
  const trimmed = raw.trim();
  const firstSpace = trimmed.search(/\s/);
  if (firstSpace === -1) {
    return { eventId: trimmed, query: null };
  }
  const eventId = trimmed.slice(0, firstSpace).trim();
  const query = trimmed.slice(firstSpace + 1).trim();
  return { eventId, query: query.length === 0 ? null : query };
}

// design §4.4 -- header line composition, shared by the initial render and
// the toggle callback's in-place header edit (§1.5).
function buildCheckinHeaderLine(
  lang: BotLang,
  eventTitle: string,
  checkedInCount: number,
  totalAdmitted: number,
): string {
  return getCatalog(lang)
    .checkin.listHeader.replace("{event}", eventTitle)
    .replace("{checkedIn}", String(checkedInCount))
    .replace("{total}", String(totalAdmitted));
}

// design §4.4 -- one keyboard row's label: glyph + displayName [+ " — " +
// company].
function buildCheckinRowLabel(lang: BotLang, item: CheckinListItem): string {
  const catalog = getCatalog(lang);
  const glyph = item.checkedInAt !== null ? catalog.checkin.checkedInGlyph : catalog.checkin.notCheckedInGlyph;
  return item.company !== null ? `${glyph} ${item.displayName} — ${item.company}` : `${glyph} ${item.displayName}`;
}

// docs/agents/design/REQ-028.md §4.4 -- renderCheckinListMessage: shared
// composition step, not a handler itself.
export interface CheckinListView {
  text: string;
  keyboard: InlineKeyboard;
}

export function renderCheckinListMessage(
  eventTitle: string,
  eventId: string,
  items: CheckinListItem[],
  checkedInCount: number,
  totalAdmitted: number,
  page: { current: number; total: number } | null,
  truncatedCount: number | null,
  lang: BotLang,
): CheckinListView {
  const catalog = getCatalog(lang);
  const lines: string[] = [buildCheckinHeaderLine(lang, eventTitle, checkedInCount, totalAdmitted)];
  const keyboard = new InlineKeyboard();

  if (items.length === 0) {
    lines.push(page !== null ? catalog.checkin.listEmpty : catalog.checkin.searchNoMatches);
  } else {
    for (const item of items) {
      keyboard.text(buildCheckinRowLabel(lang, item), `checkin:toggle:${item.registrationId}`).row();
    }
  }

  // design §4.4 -- pagination row, only for the unfiltered (no-query) view.
  if (page !== null) {
    if (page.current > 0) {
      keyboard.text("◀", `checkin:page:${eventId}:${page.current - 1}`);
    }
    keyboard.text(
      catalog.checkin.pageIndicator
        .replace("{current}", String(page.current + 1))
        .replace("{total}", String(page.total)),
      CHECKIN_PAGE_NOOP,
    );
    if (page.current < page.total - 1) {
      keyboard.text("▶", `checkin:page:${eventId}:${page.current + 1}`);
    }
    keyboard.row();
  }

  // design §1.4 -- truncation note for a search view over SEARCH_RESULT_LIMIT.
  if (truncatedCount !== null && truncatedCount > 0) {
    lines.push(catalog.checkin.searchTruncatedNote.replace("{count}", String(truncatedCount)));
  }

  // design §1.6 -- the search-pattern discoverability hint, every render.
  lines.push(catalog.checkin.searchHint);

  return { text: lines.join("\n"), keyboard };
}

// design §2.1 -- fetch once, filter/derive in memory (the admitted list for
// one event is bounded by that event's own capacity). Composes the full
// list read, the live counter, the search filter (§1.3), and pagination
// (§1.4) into one CheckinListView.
async function buildCheckinView(
  db: DbClient["db"],
  eventId: string,
  eventTitle: string,
  query: string | null,
  page: number,
  lang: BotLang,
): Promise<CheckinListView> {
  const all = await listAdmittedRegistrantsForCheckin(db, eventId, lang);
  const checkedInCount = await countCheckedIn(db, eventId);
  const totalAdmitted = all.length;

  if (query !== null) {
    const lowerQuery = query.toLowerCase();
    const matches = all.filter((item) => item.displayName.toLowerCase().includes(lowerQuery));
    const truncatedCount = matches.length > SEARCH_RESULT_LIMIT ? matches.length - SEARCH_RESULT_LIMIT : null;
    const shown = matches.slice(0, SEARCH_RESULT_LIMIT);
    return renderCheckinListMessage(eventTitle, eventId, shown, checkedInCount, totalAdmitted, null, truncatedCount, lang);
  }

  const pageCount = Math.max(1, Math.ceil(totalAdmitted / PAGE_SIZE));
  const clampedPage = Math.min(Math.max(page, 0), pageCount - 1);
  const start = clampedPage * PAGE_SIZE;
  const pageItems = all.slice(start, start + PAGE_SIZE);
  return renderCheckinListMessage(
    eventTitle,
    eventId,
    pageItems,
    checkedInCount,
    totalAdmitted,
    { current: clampedPage, total: pageCount },
    null,
    lang,
  );
}

// design §4.1 -- /checkin <event_id> [query text]. Steps 1-6 unchanged from
// REQ-018's stub (same authorization gate, same not-found/not-authorized
// replies, same event-endsAt defensive check); only step 7 changes.
export function makeCheckInHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const { eventId, query } = parseCheckinCommandArgs(matchText(ctx));
    if (eventId.length === 0) {
      await ctx.reply(catalog.checkin.usageNoId);
      return;
    }

    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.reply(catalog.checkin.notFound);
      return;
    }
    if (event.endsAt === null) {
      // Defensive/unreachable path: createEvent enforces endsAt NOT NULL.
      await ctx.reply(catalog.checkin.notFound);
      return;
    }

    const authResult = await requireEventStaffForEvent(db, BigInt(tgId), event.id, event.endsAt, new Date());
    if (!authResult.ok) {
      await ctx.reply(catalog.checkin.notAuthorized);
      return;
    }

    const view = await buildCheckinView(db, event.id, event.title, query, 0, lang);
    await ctx.reply(view.text, { reply_markup: view.keyboard });
  };
}

// design §4.2 -- checkin:toggle:<registrationId> callback.
export function makeCheckinToggleCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = CHECKIN_TOGGLE_PATTERN.exec(ctx.callbackQuery?.data ?? "");
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

    // design §3.3/§4.2 step 3 -- re-authorization at toggle time (S2, defense
    // in depth). A lightweight, unlocked read of the registration's eventId,
    // deliberately separate from §3.2's own locked read inside toggleCheckIn.
    const eventId = await getEventIdForRegistration(db, registrationId);
    if (eventId === null) {
      await ctx.answerCallbackQuery({ text: catalog.checkin.notAuthorized, show_alert: true });
      return;
    }
    const event = await getEventById(db, eventId);
    if (event === null || event.endsAt === null) {
      await ctx.answerCallbackQuery({ text: catalog.checkin.notAuthorized, show_alert: true });
      return;
    }
    const authResult = await requireEventStaffForEvent(db, BigInt(tgId), eventId, event.endsAt, new Date());
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.checkin.notAuthorized, show_alert: true });
      return;
    }
    const actingUser = await resolveActingUser(db, BigInt(tgId));
    if (actingUser === null) {
      // Defensive/unreachable: requireEventStaffForEvent's own success above
      // already implies a resolvable user row.
      await ctx.answerCallbackQuery({ text: catalog.checkin.notAuthorized, show_alert: true });
      return;
    }

    // design §3.2 -- the single authoritative check-and-write. `at` is
    // reused below for the label recompute so the toggle's own write and the
    // handler's re-render agree on the same instant.
    const at = new Date();
    const outcome = await toggleCheckIn(db, registrationId, actingUser.id, at);

    if (outcome.kind === "not-found" || outcome.kind === "refused-not-admitted") {
      // AC1's stated refusal: no write happened (toggleCheckIn already
      // returned without one), and no message edit -- the stale row's button
      // is deliberately left as-is until the next full render (design §4.2
      // step 5, §6 open question 1).
      await ctx.answerCallbackQuery({ text: catalog.checkin.refusedNotAdmitted, show_alert: true });
      return;
    }

    // design §1.5/§4.2 step 6 -- in-place edit: recompute this one row's
    // label and the header's live counter, touch nothing else on the
    // keyboard, so whatever page/search view the staff member was looking at
    // is preserved exactly.
    const checkedInAtForLabel = outcome.kind === "check-in" ? at : null;
    const glyph =
      checkedInAtForLabel !== null ? catalog.checkin.checkedInGlyph : catalog.checkin.notCheckedInGlyph;

    const message = ctx.callbackQuery?.message;
    const originalText = message?.text ?? "";
    const originalLines = originalText.split("\n");

    const checkedInCount = await countCheckedIn(db, eventId);
    const totalAdmitted = await countAdmittedRegistrations(db, eventId);
    originalLines[0] = buildCheckinHeaderLine(lang, event.title, checkedInCount, totalAdmitted);
    const newText = originalLines.join("\n");

    const targetCallbackData = `checkin:toggle:${registrationId}`;
    const currentRows =
      (message?.reply_markup as { inline_keyboard?: { text: string; callback_data: string }[][] } | undefined)
        ?.inline_keyboard ?? [];
    const newRows = currentRows.map((row) =>
      row.map((button) => {
        if (button.callback_data !== targetCallbackData) {
          return button;
        }
        const spaceIndex = button.text.indexOf(" ");
        const rest = spaceIndex === -1 ? button.text : button.text.slice(spaceIndex + 1);
        return { ...button, text: `${glyph} ${rest}` };
      }),
    );

    await ctx.answerCallbackQuery();
    await ctx.editMessageText(newText, { reply_markup: { inline_keyboard: newRows } });
  };
}

// design §4.3 -- checkin:page:<eventId>:<pageNumber> callback.
export function makeCheckinPageCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = CHECKIN_PAGE_PATTERN.exec(ctx.callbackQuery?.data ?? "");
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
    if (event === null || event.endsAt === null) {
      await ctx.answerCallbackQuery({ text: catalog.checkin.notAuthorized, show_alert: true });
      return;
    }
    // design §4.3 -- a page turn is also "the action" for S2's purposes: the
    // same authorization gate is re-run, not only checked at /checkin entry.
    const authResult = await requireEventStaffForEvent(db, BigInt(tgId), eventId, event.endsAt, new Date());
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.checkin.notAuthorized, show_alert: true });
      return;
    }

    const pageNumber = Number(pageNumberRaw);
    const view = await buildCheckinView(db, eventId, event.title, null, pageNumber, lang);
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(view.text, { reply_markup: view.keyboard });
  };
}
