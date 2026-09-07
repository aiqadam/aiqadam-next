import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { requireOrganizerForChapter } from "../domain/eventAuthorization.js";
import { getEventById } from "../domain/event.js";
import {
  addEventStaff,
  getEventStaffRow,
  parseStaffCommandArgs,
  removeEventStaff,
} from "../domain/eventStaff.js";
import { getUserByTgUsername, getUserWithChapterByTgId } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// REQ-018 §0.1/§4.1-4.2 — command wiring only: this file sequences calls into
// framework-free domain modules (domain/eventAuthorization.ts, domain/event.ts,
// domain/eventStaff.ts, domain/user.ts) and composes replies. No domain logic
// lives here (decisions/0004).
//
// Assign/remove is an organizer-only, chapter-scoped mutation (design §0.1):
// it reuses requireOrganizerForChapter UNCHANGED, exactly like /event_publish/
// /event_cancel's own authorization shape. Authorization is the FIRST
// authorization-relevant check that runs after only the minimal parsing
// needed to know what to authorize against.

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const row = await getUserWithChapterByTgId(db, BigInt(tgId));
  return row === null ? resolveLang(null, null) : resolveLang(row.lang, row.chapterDefaultLang);
}

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

// ---------------------------------------------------------------------------
// /staff_add <event_id> <tg_username> (§4.1)
// ---------------------------------------------------------------------------
export function makeStaffAddHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);

    const parsed = parseStaffCommandArgs(matchText(ctx));
    if (parsed === null) {
      await ctx.reply(getCatalog(lang).staff.usageNoArgs);
      return;
    }

    const event = await getEventById(db, parsed.eventId);
    if (event === null) {
      await ctx.reply(getCatalog(lang).staff.eventNotFound);
      return;
    }

    // §4.1 step 5 — the FIRST authorization-relevant check that runs after
    // only the minimal parsing needed to know what to authorize against.
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.reply(getCatalog(lang).staff.notAuthorized);
      return;
    }

    const targetUser = await getUserByTgUsername(db, parsed.tgUsername);
    if (targetUser === null) {
      await ctx.reply(getCatalog(lang).staff.userNotFound);
      return;
    }
    if (targetUser.tgId === null) {
      // §4.1 step 7 — defensive case (§2.2): same message as "no such user"
      // from the organizer's point of view.
      await ctx.reply(getCatalog(lang).staff.userNotFound);
      return;
    }

    const existing = await getEventStaffRow(db, event.id, targetUser.id);
    if (existing !== null) {
      await ctx.reply(getCatalog(lang).staff.alreadyAssigned);
      return;
    }

    await addEventStaff(db, authResult.user.id, event.id, targetUser.id, event.title, new Date());

    // §4.1 step 10 — F8 notification, in the TARGET's own language, sent
    // directly and synchronously at the moment of assignment (design §4.1's
    // own reasoning: no restart/retry path exists for a single request-scoped
    // API call, so S9 is not at risk here). A failed send does not roll back
    // the assignment already committed above.
    // ISS-0020-SEC-1 rework (design §2.1): both branches enter the SAME try
    // block and perform the SAME resolveLangForTg await + body composition,
    // so a blocked target cannot be distinguished from a non-blocked one by
    // the organizer's reply latency. Only the Bot API call made differs.
    let notificationFailed = false;
    try {
      const targetLang = await resolveLangForTg(db, Number(targetUser.tgId));
      const body = getCatalog(targetLang).staff.assignmentNotificationBody.replace(
        "{event}",
        event.title,
      );
      if (targetUser.blocked) {
        // Side-effect-free, no-argument Bot API call standing in for the
        // skipped sendMessage round-trip (design §2.1) — result discarded.
        await ctx.api.getMe();
        notificationFailed = true;
      } else {
        await ctx.api.sendMessage(Number(targetUser.tgId), body);
      }
    } catch {
      notificationFailed = true;
    }

    let reply = `${getCatalog(lang).staff.addSuccessPrefix} ${targetUser.tgUsername ?? parsed.tgUsername}`;
    if (notificationFailed) {
      reply += getCatalog(lang).staff.notificationFailedNote;
    }
    await ctx.reply(reply);
  };
}

// ---------------------------------------------------------------------------
// /staff_remove <event_id> <tg_username> (§4.2)
// ---------------------------------------------------------------------------
export function makeStaffRemoveHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);

    const parsed = parseStaffCommandArgs(matchText(ctx));
    if (parsed === null) {
      await ctx.reply(getCatalog(lang).staff.usageNoArgs);
      return;
    }

    const event = await getEventById(db, parsed.eventId);
    if (event === null) {
      await ctx.reply(getCatalog(lang).staff.eventNotFound);
      return;
    }

    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.reply(getCatalog(lang).staff.notAuthorized);
      return;
    }

    const targetUser = await getUserByTgUsername(db, parsed.tgUsername);
    if (targetUser === null) {
      await ctx.reply(getCatalog(lang).staff.userNotFound);
      return;
    }
    if (targetUser.tgId === null) {
      await ctx.reply(getCatalog(lang).staff.userNotFound);
      return;
    }

    const existing = await getEventStaffRow(db, event.id, targetUser.id);
    if (existing === null) {
      await ctx.reply(getCatalog(lang).staff.notAssigned);
      return;
    }

    await removeEventStaff(db, authResult.user.id, existing, event.title, new Date());

    // §4.2 step 9 — removal notification, same shape as §4.1 step 10. "The
    // screen is gone" is entirely satisfied by the row no longer existing
    // (design §4.2's own closing note) — no separate mechanism to build.
    // ISS-0020-SEC-1 rework (design §2.1): both branches enter the SAME try
    // block and perform the SAME resolveLangForTg await + body composition,
    // so a blocked target cannot be distinguished from a non-blocked one by
    // the organizer's reply latency. Only the Bot API call made differs.
    let notificationFailed = false;
    try {
      const targetLang = await resolveLangForTg(db, Number(targetUser.tgId));
      const body = getCatalog(targetLang).staff.removalNotificationBody.replace(
        "{event}",
        event.title,
      );
      if (targetUser.blocked) {
        // Side-effect-free, no-argument Bot API call standing in for the
        // skipped sendMessage round-trip (design §2.1) — result discarded.
        await ctx.api.getMe();
        notificationFailed = true;
      } else {
        await ctx.api.sendMessage(Number(targetUser.tgId), body);
      }
    } catch {
      notificationFailed = true;
    }

    let reply = `${getCatalog(lang).staff.removeSuccessPrefix} ${targetUser.tgUsername ?? parsed.tgUsername}`;
    if (notificationFailed) {
      reply += getCatalog(lang).staff.notificationFailedNote;
    }
    await ctx.reply(reply);
  };
}
