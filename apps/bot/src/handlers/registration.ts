import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { resolveActingUser } from "../domain/eventAuthorization.js";
import { getEventByIdWithChapterTimezone } from "../domain/event.js";
import { parseRedeemArgs, redeemInviteCode } from "../domain/inviteCode.js";
import { getWaitlistPosition, registerForEvent } from "../domain/registration.js";
import { getVenueById } from "../domain/venue.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { getFlowUserByTgId } from "../domain/user.js";
import { resolveLang } from "../i18n/resolveLang.js";
import { buildConsentKeyboard, REGISTER_CALLBACK_PREFIX } from "./start.js";
import { formatDateTimeInTimezone } from "../i18n/formatTimeInTimezone.js";
import {
  composeRegistrationReply,
  resolveRegistrationOutcomeDisplayData,
  STATUS_CATALOG_KEY,
} from "./registrationReply.js";

// docs/agents/design/REQ-020.md §7.1 — recognizes callback_data of the shape
// `register:<eventId>`, following exactly the convention
// CHAPTER_CALLBACK_PATTERN already establishes in handlers/start.ts.
export const REGISTER_CALLBACK_PATTERN = new RegExp(`^${REGISTER_CALLBACK_PREFIX}(.+)$`);

// docs/agents/design/REQ-038.md — STATUS_CATALOG_KEY/composeRegistrationReply
// now live in ./registrationReply.js (shared with handlers/start.ts's `i_`
// deep link, without introducing a start.ts <-> registration.ts import
// cycle). Re-exported here, unchanged in shape, so handlers/my.ts's existing
// `import { STATUS_CATALOG_KEY } from "./registration.js"` (REQ-024 §4) keeps
// working without an edit to that file.
export { STATUS_CATALOG_KEY };

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
    let registrationClosesAtText: string | null = null;
    if (
      outcome.kind === "admitted" ||
      outcome.kind === "waitlisted" ||
      outcome.kind === "already-registered" ||
      outcome.kind === "requested"
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
        // docs/agents/design/REQ-034.md §3.2 — computed only for the
        // "requested" outcome, alongside startsAtText/endsAtText above, using
        // the same formatter. Null when the event has no registration
        // deadline configured (§3.3's fallback branch fires instead).
        if (outcome.kind === "requested") {
          registrationClosesAtText =
            event.registrationClosesAt !== null
              ? formatDateTimeInTimezone(event.registrationClosesAt, event.chapterTimezone, lang)
              : null;
        }
      }
      // docs/agents/design/REQ-021.md §3.1 — one additional read call, only
      // for the waitlisted outcome, whose registrationId is unconditionally
      // populated by registerForEvent's write path.
      if (outcome.kind === "waitlisted" && outcome.registrationId !== undefined) {
        waitlistPosition = await getWaitlistPosition(db, eventId, outcome.registrationId);
      }
    }

    await ctx.reply(
      composeRegistrationReply(outcome, catalog, eventTitle, dateTimeText, waitlistPosition, registrationClosesAtText),
    );
  };
}

// ---------------------------------------------------------------------------
// docs/agents/design/REQ-038.md §5 — the typed-code entry point: /redeem
// <event_id> <code>. Mirrors makeInvitePersonalHandler's exact structure
// (handlers/inviteCodes.ts): parse (pure, no I/O) -> consent gate -> resolve
// acting user -> call the one shared transactional function -> compose the
// reply via the SAME composeRegistrationReply the register:<eventId> handler
// above and handlers/start.ts's `i_` deep link both already use (§0 point 1
// -- one redemption function, two entry points; no second copy of the
// validation table or the reply composition anywhere).
// ---------------------------------------------------------------------------
export function makeRedeemCommandHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }

    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    const lang: BotLang = resolveLang(flowUser?.lang ?? null, flowUser?.chapterDefaultLang ?? null);
    const catalog = getCatalog(lang);

    // §5.1 -- collect and report before ever touching the DB: either token
    // missing (or the second is empty) -> the usage message, no lookup
    // attempted, no transaction opened.
    const parsed = parseRedeemArgs(matchText(ctx));
    if (!parsed.ok) {
      await ctx.reply(catalog.registration.redeemUsage);
      return;
    }

    if (flowUser === null) {
      // §7.1 step 3's identical defensive shape: unreachable via the normal
      // path (a deep-link/`/start` handler already created a users row
      // before this command can ever run), but this command has no such
      // pre-condition of its own to lean on the way register:<eventId>'s
      // callback does -- resolveActingUser (below) covers the real refusal.
      await ctx.reply(catalog.profile.startFirst);
      return;
    }

    // §5.2 -- the consent gate, exactly as makeStartHandler's own top-level
    // check already does. Not yet consented -> the ordinary consent prompt,
    // with the with-suffix i_<code>__<eventId> grammar (§4.1) carried into
    // consent:agree's callback_data via the existing buildConsentKeyboard/
    // buildConsentAgreeCallbackData helpers -- reused unchanged (§5.2's own
    // instruction). No invite_codes read, no registrations/profiles write
    // happens before this returns (S1).
    if (flowUser.consentPdAt === null) {
      const payloadText = `i_${parsed.code}__${parsed.eventId}`;
      await ctx.reply(catalog.consent.prompt, {
        reply_markup: buildConsentKeyboard(lang, payloadText),
      });
      return; // STOP — resumes in the consent callback (handlers/start.ts §4.3)
    }

    const actingUser = await resolveActingUser(db, BigInt(tgId));
    if (actingUser === null) {
      // Defensive/unreachable in practice, same reasoning as
      // makeRegisterCallbackHandler's identical branch above: a users row
      // was already guaranteed to exist by the consent check just above.
      await ctx.reply(catalog.profile.startFirst);
      return;
    }

    const outcome = await redeemInviteCode(db, actingUser.id, parsed.code, parsed.eventId, new Date());
    const display = await resolveRegistrationOutcomeDisplayData(db, outcome, parsed.eventId, lang);
    await ctx.reply(
      composeRegistrationReply(
        outcome,
        catalog,
        display.eventTitle,
        display.dateTimeText,
        display.waitlistPosition,
        display.registrationClosesAtText,
      ),
    );
  };
}

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}
