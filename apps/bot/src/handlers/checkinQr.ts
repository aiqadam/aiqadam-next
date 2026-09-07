import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { requireOrganizerForChapter } from "../domain/eventAuthorization.js";
import { requireEventStaffForEvent } from "../domain/eventStaffAuthorization.js";
import { getEventById } from "../domain/event.js";
import {
  countCheckedIn,
  getCheckinActorDisplayName,
  getEventIdForRegistration,
  getRegistrationByQrTokenForCheckin,
  getRegistrationDisplayInfo,
  overrideAdmitAndCheckIn,
  performQrCheckIn,
  type AdmissionState,
} from "../domain/registration.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { formatDateTimeInTimezone } from "../i18n/formatTimeInTimezone.js";
import { getUserWithChapterByTgId } from "../domain/user.js";
import { resolveLang } from "../i18n/resolveLang.js";

// docs/agents/design/REQ-029.md §6 -- the `ci_<qr_token>` check-in deep
// link's own dispatch target (§6.1), and the organizer-only override
// callback it may offer (§6.2). Framework-free domain logic lives entirely
// in domain/registration.ts and domain/eventStaffAuthorization.ts
// (decisions/0004) -- this file only sequences calls and sends replies.

export const CHECKIN_OVERRIDE_PATTERN = /^checkin:override:(.+)$/;

// design §7's per-admission catalog-key table (§3.2).
const REFUSAL_CATALOG_KEY: Record<AdmissionState, keyof ReturnType<typeof getCatalog>["checkinQr"] | null> = {
  waitlisted: "refusedWaitlisted",
  requested: "refusedRequested",
  withdrawn: "refusedWithdrawn",
  rejected: "refusedRejected",
  admitted: null, // unreachable: decideQrCheckinOutcome never returns this outcome for "admitted"
};

// design §7's successHeader/overrideSuccess {company} placeholder rule --
// same "omitted with its separator when null" convention REQ-028 §4.4's row
// label already uses (buildCheckinRowLabel, handlers/checkin.ts).
function companyPlaceholder(company: string | null): string {
  return company !== null ? ` — ${company}` : "";
}

// design §6.1 -- resolveCheckinQrDeepLink: dispatched from
// handlers/start.ts's makeStartHandler for a `{ kind: "checkin" }` payload.
// `scannerUserId` is the scanner's own users.id, already resolved by the
// caller via the ordinary ctx.from.id -> resolveOrCreateUser/
// getFlowUserByTgId flow every /start branch shares -- passed straight
// through to performQrCheckIn's staffUserId parameter (Open Question 4:
// reusing the caller's own resolution rather than a second, redundant
// resolveActingUser lookup). The qr_token never identifies the scanner; it
// identifies the registration being scanned (S4) -- these two resolution
// paths stay structurally separate throughout this function.
export async function resolveCheckinQrDeepLink(
  ctx: Context,
  db: DbClient["db"],
  scannerUserId: string,
  lang: BotLang,
  qrToken: string,
): Promise<void> {
  const catalog = getCatalog(lang);

  const lookup = await getRegistrationByQrTokenForCheckin(db, qrToken, lang);
  if (lookup === null) {
    await ctx.reply(catalog.checkinQr.unknownToken);
    return;
  }

  const tgId = ctx.from?.id;
  if (tgId === undefined) {
    return;
  }

  const authResult = await requireEventStaffForEvent(
    db,
    BigInt(tgId),
    lookup.eventId,
    lookup.eventEndsAt,
    new Date(),
    lookup.registrationId,
  );
  if (!authResult.ok) {
    if (authResult.reason === "event-ended") {
      await ctx.reply(catalog.checkinQr.eventEnded);
    } else {
      // "no-user" / "not-staff-for-event" -- AC1's refusal. The audit row
      // naming this registration was already written inside
      // requireEventStaffForEvent (§5).
      await ctx.reply(catalog.checkinQr.notStaff);
    }
    return;
  }

  // Scanner is authorized -- scannerUserId (never derived from the token)
  // is used directly as performQrCheckIn's staffUserId parameter.
  const outcome = await performQrCheckIn(db, lookup.registrationId, qrToken, scannerUserId, new Date());

  if (outcome.kind === "unknown-token") {
    // The token-currency recheck found the token superseded between the
    // unlocked lookup above and this write -- indistinguishable from "never
    // a valid token" to the scanner.
    await ctx.reply(catalog.checkinQr.unknownToken);
    return;
  }

  if (outcome.kind === "refused-not-admitted") {
    const key = REFUSAL_CATALOG_KEY[outcome.admission];
    const text = key !== null ? catalog.checkinQr[key] : catalog.checkinQr.notStaff;
    const keyboard = new InlineKeyboard().text(
      catalog.checkinQr.overrideButtonLabel,
      `checkin:override:${lookup.registrationId}`,
    );
    await ctx.reply(text, { reply_markup: keyboard });
    return;
  }

  if (outcome.kind === "already-checked-in") {
    const actorName =
      outcome.checkedInBy !== undefined
        ? await getCheckinActorDisplayName(db, outcome.checkedInBy, lang)
        : catalog.checkin.noNameFallback;
    const atText =
      outcome.checkedInAt !== undefined
        ? formatDateTimeInTimezone(outcome.checkedInAt, lookup.eventChapterTimezone, lang)
        : "";
    const text = catalog.checkinQr.alreadyCheckedIn.replace("{at}", atText).replace("{by}", actorName);
    await ctx.reply(text);
    return;
  }

  // "check-in"
  const checkedInCount = await countCheckedIn(db, lookup.eventId);
  const text = catalog.checkinQr.successHeader
    .replace("{name}", lookup.displayName)
    .replace("{company}", companyPlaceholder(lookup.company))
    .replace("{checkedIn}", String(checkedInCount));
  await ctx.reply(text);
}

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const row = await getUserWithChapterByTgId(db, BigInt(tgId));
  return row === null ? resolveLang(null, null) : resolveLang(row.lang, row.chapterDefaultLang);
}

// design §6.2 -- checkin:override:<registrationId> callback. Its OWN
// authorization is organizer-level (requireOrganizerForChapter, REQ-016),
// deliberately stricter than requireEventStaffForEvent -- see design §4.3.
export function makeCheckinOverrideCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = CHECKIN_OVERRIDE_PATTERN.exec(ctx.callbackQuery?.data ?? "");
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
      await ctx.answerCallbackQuery({ text: catalog.checkinQr.overrideNotApplicable, show_alert: true });
      return;
    }
    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.answerCallbackQuery({ text: catalog.checkinQr.overrideNotApplicable, show_alert: true });
      return;
    }

    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.checkinQr.overrideNotAuthorized, show_alert: true });
      return;
    }

    const outcome = await overrideAdmitAndCheckIn(db, registrationId, authResult.user.id, new Date());

    if (outcome.kind === "not-found" || outcome.kind === "already-admitted") {
      await ctx.answerCallbackQuery({ text: catalog.checkinQr.overrideNotApplicable, show_alert: true });
      return;
    }

    // "override-admit"
    await ctx.answerCallbackQuery();
    const info = await getRegistrationDisplayInfo(db, registrationId, lang);
    const checkedInCount = await countCheckedIn(db, eventId);
    const text = catalog.checkinQr.overrideSuccess
      .replace("{name}", info?.displayName ?? catalog.checkin.noNameFallback)
      .replace("{company}", companyPlaceholder(info?.company ?? null))
      .replace("{checkedIn}", String(checkedInCount));
    await ctx.reply(text);
  };
}
