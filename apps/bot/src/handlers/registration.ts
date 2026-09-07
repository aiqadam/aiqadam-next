import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { resolveActingUser } from "../domain/eventAuthorization.js";
import { getEventByIdWithChapterTimezone } from "../domain/event.js";
import { getWaitlistPosition, registerForEvent, type AdmissionState } from "../domain/registration.js";
import { getVenueById } from "../domain/venue.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { getFlowUserByTgId } from "../domain/user.js";
import { resolveLang } from "../i18n/resolveLang.js";
import { REGISTER_CALLBACK_PREFIX } from "./start.js";
import { formatDateTimeInTimezone } from "../i18n/formatTimeInTimezone.js";

// docs/agents/design/REQ-020.md §7.1 — recognizes callback_data of the shape
// `register:<eventId>`, following exactly the convention
// CHAPTER_CALLBACK_PATTERN already establishes in handlers/start.ts.
export const REGISTER_CALLBACK_PATTERN = new RegExp(`^${REGISTER_CALLBACK_PREFIX}(.+)$`);

const STATUS_CATALOG_KEY: Record<AdmissionState, keyof ReturnType<typeof getCatalog>["registration"]> = {
  admitted: "statusAdmitted",
  waitlisted: "statusWaitlisted",
  requested: "statusRequested",
  rejected: "statusRejected",
  withdrawn: "statusWithdrawn",
};

// §7.1 — the register:<eventId> callback handler (all ACs, the entry point).
export function makeRegisterCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = REGISTER_CALLBACK_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    if (match === null) {
      // Defensive, unreachable in practice — Telegram only ever calls a
      // registered handler with data its own pattern matched.
      await ctx.answerCallbackQuery();
      return;
    }
    const eventId = match[1];
    if (eventId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    const actingUser = await resolveActingUser(db, BigInt(tgId));
    if (actingUser === null) {
      // §7.1 step 3 — defensive: a deep-link handler already created a users
      // row before ever showing a card, so this is unreachable via the
      // normal path.
      await ctx.answerCallbackQuery();
      const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
      const lang = resolveLang(flowUser?.lang ?? null, flowUser?.chapterDefaultLang ?? null);
      await ctx.reply(getCatalog(lang).profile.startFirst);
      return;
    }

    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    const lang: BotLang = resolveLang(flowUser?.lang ?? null, flowUser?.chapterDefaultLang ?? null);
    const catalog = getCatalog(lang);

    const outcome = await registerForEvent(db, actingUser.id, eventId, new Date());
    await ctx.answerCallbackQuery();

    // §7.1 step 6/§1.3 — display data (date/time text, venue name) is
    // fetched only when actually needed, after the transaction has already
    // committed; never part of the atomicity boundary.
    let eventTitle = "";
    let dateTimeText = "";
    let waitlistPosition: number | null = null;
    if (
      outcome.kind === "admitted" ||
      outcome.kind === "waitlisted" ||
      outcome.kind === "already-registered"
    ) {
      const event = await getEventByIdWithChapterTimezone(db, eventId);
      if (event !== null) {
        eventTitle = event.title;
        const startsAtText =
          event.startsAt !== null
            ? formatDateTimeInTimezone(event.startsAt, event.chapterTimezone, lang)
            : "";
        const endsAtText =
          event.endsAt !== null
            ? formatDateTimeInTimezone(event.endsAt, event.chapterTimezone, lang)
            : "";
        dateTimeText = `${startsAtText}–${endsAtText}`;
        // Venue lookup fetched per §7.2's table (confirmedPrefix message
        // shape names the venue) but not currently rendered by this
        // minimal-copy composition beyond title/date-time — kept as a
        // targeted read only where the design's table requires it.
        if (event.venueId !== null) {
          await getVenueById(db, event.venueId);
        }
      }
      // docs/agents/design/REQ-021.md §3.1 — one additional read call, only
      // for the waitlisted outcome, whose registrationId is unconditionally
      // populated by registerForEvent's write path.
      if (outcome.kind === "waitlisted" && outcome.registrationId !== undefined) {
        waitlistPosition = await getWaitlistPosition(db, eventId, outcome.registrationId);
      }
    }

    await ctx.reply(composeRegistrationReply(outcome, catalog, eventTitle, dateTimeText, waitlistPosition));
  };
}

// §7.2 — reply composition per outcome.
function composeRegistrationReply(
  outcome: Awaited<ReturnType<typeof registerForEvent>>,
  catalog: ReturnType<typeof getCatalog>,
  eventTitle: string,
  dateTimeText: string,
  waitlistPosition: number | null = null,
): string {
  switch (outcome.kind) {
    case "admitted":
      return [catalog.registration.confirmedPrefix, eventTitle, dateTimeText, catalog.registration.whatNext].join(
        "\n",
      );
    case "waitlisted": {
      // §3.2 — when a position is known, insert the position line and the
      // waitlisted-specific "what next" line; when null (§2.2's defensive
      // cases), the position line is omitted entirely (§6 open question 3).
      const lines = [catalog.registration.waitlistedPrefix, eventTitle, dateTimeText];
      if (waitlistPosition !== null) {
        lines.push(`${catalog.registration.waitlistedPositionPrefix} ${waitlistPosition}`);
      }
      lines.push(catalog.registration.waitlistedWhatNext);
      return lines.join("\n");
    }
    case "already-registered": {
      const statusKey = STATUS_CATALOG_KEY[outcome.admission];
      return [
        catalog.registration.alreadyRegisteredPrefix,
        catalog.registration[statusKey],
        eventTitle,
        dateTimeText,
      ].join("\n");
    }
    case "event-cancelled":
      return [catalog.registration.refusedCancelled, catalog.event.deepLinkSeeUpcoming].join("\n");
    case "event-finished":
      return [catalog.registration.refusedFinished, catalog.event.deepLinkSeeUpcoming].join("\n");
    case "registration-closed":
      return [catalog.registration.refusedClosed, catalog.event.deepLinkSeeUpcoming].join("\n");
    case "requires-invite":
      return catalog.registration.refusedRequiresInvite;
    case "requires-approval":
      return catalog.registration.refusedRequiresApproval;
    case "not-found":
      return [catalog.event.deepLinkNotAvailable, catalog.event.deepLinkSeeUpcoming].join("\n");
  }
}
