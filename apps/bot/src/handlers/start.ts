import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import {
  assignChapter,
  getActiveChapterSignal,
  isChapterActive,
  listActiveChapters,
} from "../domain/chapter.js";
import { recordConsent } from "../domain/consent.js";
import {
  buildEventCardContent,
  countAdmittedRegistrations,
  getEventByIdWithChapterTimezone,
  isFinished,
  parseStartPayload,
  setPendingSource,
} from "../domain/event.js";
import {
  formatCompanionFieldsPrompt,
  getInviteCodeByCode,
  normalizeInviteCode,
  redeemInviteCode,
} from "../domain/inviteCode.js";
import { markInviteListEntryOpened, resolvePersonalCodeIdentity } from "../domain/inviteList.js";
import { getProfileByUserId } from "../domain/profile.js";
import type { NotificationSender } from "../domain/notification.js";
import { resolveCheckinQrDeepLink } from "./checkinQr.js";
import { sendCompanionHostNotification } from "./companion.js";
import { advanceOnboarding } from "../domain/onboarding.js";
import { getVenueById } from "../domain/venue.js";
import { getFlowUserByTgId, resolveOrCreateUser } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { mapTelegramLanguageCode, resolveLang } from "../i18n/resolveLang.js";
import { composeRegistrationReply, resolveRegistrationOutcomeDisplayData } from "./registrationReply.js";

// REQ-014 — replaces the REQ-013 stub wholesale (see that file's own header
// comment / docs/agents/design/REQ-013.md §3.2's closing note). Reused
// unchanged from REQ-013: resolveLang, getCatalog. New in this file: the
// full /start flow (design §2), the chapter-selection callback (§2.6), and
// the consent-acceptance callback (§2.5). All persistence and branching
// signals come from framework-free domain modules
// (domain/user.ts, domain/chapter.ts, domain/consent.ts) — this file only
// sequences calls and sends replies (decisions/0004).
//
// WF02-REQ-014 SECURITY REWORK (iteration 1, handoffs/WF02-REQ-014/
// step-02c-security-reviewer.json, S1 BLOCKER): the flow below has been
// reordered so consent ALWAYS comes before any chapter write. The design
// artefact's own §2.8 combined-flow diagram shows chapter-then-consent —
// that ordering is what SECURITY-REVIEWER correctly rejected as writing
// `users.chapter_id` before `consent_pd_at` on the majority deployment path
// (single active chapter, or a user picking one of two). This file now
// diverges from design §2.3/§2.4/§2.8's literal ordering on that one point;
// the design artefact itself needs a follow-up correction (flagged in this
// handoff's result.issues) so it stops documenting the rejected order.
// Nothing about *what* chapter assignment does (the 0/1/2+ branches,
// domain/chapter.ts's functions, the validation-before-write discipline)
// changes — only *when* it runs relative to consent.

const CHAPTER_CALLBACK_PATTERN = /^chapter:(.+)$/;
const CONSENT_AGREE_CALLBACK = "consent:agree";
// WF02-REQ-016 SECURITY REWORK (iteration 1, handoffs/WF02-REQ-016/
// step-02c-security-reviewer.json, S1 BLOCKER) — see this file's REQ-016
// header note below. The consent callback now optionally carries a deep-link
// payload after a `:`, e.g. `consent:agree:e_<id>__<channel>`, so it must be
// matched with a pattern, not the old exact string.
// REQ-019 §3.3 — exported: reused unchanged by handlers/onboarding callers
// that need to re-derive the same match (none currently do; kept exported
// per the design's stated file-private-to-exported change list).
export const CONSENT_AGREE_CALLBACK_PATTERN = /^consent:agree(?::(.+))?$/;
// Telegram's hard limit on callback_data (bytes, not characters).
const CALLBACK_DATA_MAX_BYTES = 64;

// REQ-019 §3.3 — exported (was file-private): reused as-is by
// handlers/profile.ts, which parses the same `/start <payload>` shape
// nowhere else but needs this exact helper's behavior for its own module
// scope conventions.
export function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

// WF02-REQ-016 SECURITY REWORK (iteration 1, handoffs/WF02-REQ-016/
// step-02c-security-reviewer.json, S1 BLOCKER): the design's §6.3 resolution
// logic wrote `users.pending_source` unconditionally for a published event's
// channel-suffixed deep link, with no mention of the consent gate at all.
// SECURITY-REVIEWER independently reproduced this against a brand-new user
// (consent_pd_at still null) and correctly rejected it as the same class of
// bug REQ-014's own S1 finding already fixed for chapter assignment (data
// written before consent). This file now diverges from design §6.3 on that
// one point, following the exact precedent already set above for
// `assignChapterOrPrompt`/`consent:agree`: the write only ever happens once
// `consent_pd_at` is non-null. `docs/agents/design/REQ-016.md` carries a
// correction note; §6.3's literal text is left as the historical record of
// what was reviewed and rejected (same convention REQ-014.md's own header
// note uses).
//
// Concretely: an unknown/draft/cancelled/finished event id never writes
// anything regardless of consent state (no PII write happens on that branch
// at all, so no gating is needed there — confirmed unchanged from the
// original design). A *published* event's channel-suffixed link is the only
// write path, and it is now consent-gated: an already-consented caller gets
// the write immediately (unchanged, no reordering needed); a not-yet-
// consented caller is shown the ordinary consent prompt first, with the deep
// link's payload re-encoded into the `consent:agree` callback's
// `callback_data` (`buildConsentAgreeCallbackData` below) so the write and
// reply can complete once `consent:agree` fires and `recordConsent` has run
// — mirroring exactly how `assignChapterOrPrompt` is only ever invoked after
// consent is recorded.
//
// REQ-016 §6.3 — deep-link resolution, extending the existing /start
// handler rather than adding a new command (§6.1). Runs ONLY when the
// payload parses as an `e_` deep link; the ordinary REQ-014 /start flow
// (payload.kind === "none") is untouched by this function or its caller.
//
// Step 7's ordering: the acting user's row must already exist (the caller
// has already run resolveOrCreateUser, same as the ordinary flow) before
// this function is invoked, since a deep link is still someone's
// first-ever contact with the bot.
async function resolveEventDeepLink(
  ctx: Context,
  db: DbClient["db"],
  userId: string,
  lang: BotLang,
  eventId: string,
  channel: string | null,
  hasConsented: boolean,
): Promise<void> {
  const event = await getEventByIdWithChapterTimezone(db, eventId);

  // §6.3 step 4/5, extended by REQ-017 §5 — an unknown id, a
  // draft/cancelled event, AND a published-but-already-finished event all
  // yield the identical plain explanation; neither discloses whether the id
  // ever existed, what state it's in, or that it already happened. This
  // branch never writes anything, so it runs identically regardless of
  // consent state. `event.endsAt === null` is grouped with "finished" here
  // too — defensive only (a published event always has a non-null endsAt,
  // findMissingPublishFields already guarantees it), never reachable in
  // practice.
  if (
    event === null ||
    event.status !== "published" ||
    event.endsAt === null ||
    isFinished(event.endsAt, new Date())
  ) {
    await ctx.reply(
      `${getCatalog(lang).event.deepLinkNotAvailable}\n${getCatalog(lang).event.deepLinkSeeUpcoming}`,
    );
    return;
  }

  // REQ-016 rework — the write-capable branch (published event) is
  // consent-gated: a not-yet-consented caller sees the consent prompt first,
  // with the deep-link payload carried in the consent callback's
  // callback_data so this function runs again with `hasConsented: true`
  // once `consent:agree` fires.
  if (!hasConsented) {
    const payloadText = `e_${eventId}${channel !== null ? `__${channel}` : ""}`;
    await ctx.reply(getCatalog(lang).consent.prompt, {
      reply_markup: buildConsentKeyboard(lang, payloadText),
    });
    return; // STOP — resumes in the consent callback (§2.5 / REQ-016 rework)
  }

  // §6.5 — the pending-source write happens only for a published event's
  // channel-suffixed link; a draft/cancelled/finished target never records
  // one (handled above, this line is only reached once event is published),
  // and now (REQ-016 rework) only once consent is already recorded.
  if (channel !== null) {
    await setPendingSource(db, userId, channel);
  }

  // REQ-017 §6 — the real card-rendering path, replacing REQ-016's
  // placeholder. buildEventCardContent (domain/event.ts) is a pure
  // composition over already-fetched rows; this handler is responsible for
  // fetching the venue and the live admitted count first.
  const venue = event.venueId !== null ? await getVenueById(db, event.venueId) : null;
  const admittedCount = await countAdmittedRegistrations(db, event.id);
  const content = buildEventCardContent(event, venue, admittedCount, lang);
  const catalog = getCatalog(lang);
  const text = composeEventCardText(content, catalog);
  // REQ-020 §7.3 — replaces REQ-017's inert text CTA with a real button.
  const reply_markup = new InlineKeyboard().text(
    catalog.registration.registerButton,
    buildRegisterCallbackData(event.id),
  );

  // §3.5 — a stored cover_file_id is sent as a Telegram photo with the
  // card's full text as the caption; otherwise a plain text reply with the
  // same text. No re-upload, no fetch of the file content by this bot.
  if (content.coverFileId !== null) {
    await ctx.replyWithPhoto(content.coverFileId, { caption: text, reply_markup });
  } else {
    await ctx.reply(text, { reply_markup });
  }
}

// docs/agents/design/REQ-038.md §4.2 — resolveInviteDeepLink: mirrors
// resolveEventDeepLink's shape exactly. Consent gate FIRST (S1, design §0
// point 5): no invite_codes read, no registrations/profiles write, and no
// redemption at all happens before this returns for a not-yet-consented
// caller -- the ordinary consent prompt is shown, with the invite payload
// carried in consent:agree's callback_data, and this function resumes (with
// hasConsented: true) from makeConsentCallbackHandler's own sibling branch
// below.
async function resolveInviteDeepLink(
  ctx: Context,
  db: DbClient["db"],
  userId: string,
  lang: BotLang,
  code: string,
  explicitEventId: string | null,
  hasConsented: boolean,
  // docs/agents/design/REQ-039.md §6 -- optional so every existing caller
  // (this file's own start.test.ts, which constructs makeStartHandler(db)/
  // makeConsentCallbackHandler(db) with no sender) keeps compiling and
  // behaving unchanged. Production wiring (index.ts) always passes the
  // process-wide notificationSender.
  sender: NotificationSender | null = null,
): Promise<void> {
  if (!hasConsented) {
    const payloadText = `i_${code}${explicitEventId !== null ? `__${explicitEventId}` : ""}`;
    await ctx.reply(getCatalog(lang).consent.prompt, {
      reply_markup: buildConsentKeyboard(lang, payloadText),
    });
    return; // STOP — resumes in the consent callback (§4.3)
  }

  const catalog = getCatalog(lang);

  // docs/agents/design/REQ-039.md §2 -- two read-only lookups, inserted
  // between the (already-passed) consent gate above and the unconditional
  // redeemInviteCode call below. Zero behavior change for a non-companion
  // code: existingProfile is never evaluated at all when grantsCompanionOf
  // is null.
  const normalizedCode = normalizeInviteCode(code);
  const codeRow = await getInviteCodeByCode(db, normalizedCode);

  // docs/agents/design/REQ-040.md §3.2 -- the first-open-only write, matched
  // by invite_code_id, guarded opened_at IS NULL. A no-op for a companion/
  // bulk code, or a personal code with no matching list entry at all.
  if (codeRow !== null) {
    await markInviteListEntryOpened(db, codeRow.id, new Date());
  }

  const isCompanionCode = codeRow !== null && codeRow.grantsCompanionOf !== null;
  const existingProfile = isCompanionCode ? await getProfileByUserId(db, userId) : null;

  if (isCompanionCode && codeRow !== null && existingProfile === null) {
    // §3.1 steps 1-5 / §3.2 -- the reduced-field collection flow. NO write
    // of any kind happens here (S1) -- the prompt is pure composition
    // (domain/inviteCode.ts's formatCompanionFieldsPrompt), and the flow
    // resumes in handlers/companion.ts's reply-to-message listener.
    const event = await getEventByIdWithChapterTimezone(db, codeRow.eventId);
    const eventTitle = event?.title ?? "";
    await ctx.reply(formatCompanionFieldsPrompt(eventTitle, codeRow.id, lang), {
      reply_markup: { force_reply: true },
    });
    return;
  }

  // §3.1 — the one transactional entry point both redemption routes share.
  // Reached unconditionally for a non-companion code, AND (§2 Open Question
  // 1's resolution) for a companion code redeemed by a RETURNING guest who
  // already has a Profile row -- companionProfile stays null on this call
  // for both populations, exactly like every existing caller.
  const outcome = await redeemInviteCode(db, userId, code, explicitEventId, new Date());

  // §4.2 point 3 — display data (eventTitle/dateTimeText/waitlistPosition)
  // fetched only when actually needed, after the transaction has already
  // committed, exactly like handlers/registration.ts's own register callback
  // does. The target event id for display purposes is the explicit one when
  // given, or (for the bare i_<code> deep link) the code's own event_id,
  // already resolved above via codeRow (no second lookup).
  const targetEventId = explicitEventId ?? codeRow?.eventId ?? null;

  const display = await resolveRegistrationOutcomeDisplayData(db, outcome, targetEventId, lang);
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

  // docs/agents/design/REQ-039.md §6/§7 AC7 -- the host notification, fired
  // here for the returning-guest direct-redemption branch (a companion code
  // whose reduced-field conversation was skipped by §2's existingProfile
  // check) -- AC7 holds identically for both populations, mirroring the
  // design's own §7 AC1 row ("holds identically for a returning guest").
  // handlers/companion.ts's confirm-callback handler is the equivalent call
  // site for a brand-new guest who DID complete the conversation.
  if (
    sender !== null &&
    isCompanionCode &&
    codeRow !== null &&
    codeRow.grantsCompanionOf !== null &&
    (outcome.kind === "admitted" || outcome.kind === "waitlisted" || outcome.kind === "requested") &&
    outcome.registrationId !== undefined
  ) {
    await sendCompanionHostNotification(db, sender, outcome.registrationId, codeRow.grantsCompanionOf, userId);
  }
}

// REQ-020 §7.1/§7.3 — the register:<eventId> callback_data shape, shared
// between the button-building site above and handlers/registration.ts's own
// pattern match, so both sides agree on the exact prefix.
export const REGISTER_CALLBACK_PREFIX = "register:";

export function buildRegisterCallbackData(eventId: string): string {
  return `${REGISTER_CALLBACK_PREFIX}${eventId}`;
}

// REQ-017 §3.6 — text composition, section order matching FR-2's own listed
// order: title, cover handled separately (§3.5), date/time, venue+address+
// both map links, agenda, seats line, CTA. One newline-joined string, no
// conditional reordering — same discipline as formatVenueDump/
// formatEventDump elsewhere in this codebase. No LINEUP element anywhere
// (Release 3 scope, §3.2's own table).
function composeEventCardText(
  content: ReturnType<typeof buildEventCardContent>,
  catalog: ReturnType<typeof getCatalog>,
): string {
  const lines: string[] = [content.title, content.dateTimeText];

  // §3.2 — the venue block renders only when a venue exists at all
  // (venue_id is null only in the defensive, never-reachable-for-a-
  // published-card case, §3.3).
  if (content.venueName !== null) {
    lines.push(catalog.events.cardVenueLabel);
    lines.push(content.venueName);
    if (content.venueAddress !== null) {
      lines.push(content.venueAddress);
    }
    if (content.yandexMapUrl !== null) {
      lines.push(`${catalog.events.cardMapYandex} ${content.yandexMapUrl}`);
    }
    if (content.googleMapUrl !== null) {
      lines.push(`${catalog.events.cardMapGoogle} ${content.googleMapUrl}`);
    }
  }

  if (content.agendaLines.length > 0) {
    lines.push(catalog.events.cardAgendaLabel);
    for (const item of content.agendaLines) {
      lines.push(`${item.timeText} — ${item.label}`);
    }
  }

  lines.push(
    content.seatsLine.kind === "seatsLeft"
      ? `${catalog.events.cardSeatsLeft} ${content.seatsLine.count}`
      : catalog.events.cardWaitlistOpen,
  );

  return lines.join("\n");
}

function buildChapterKeyboard(
  options: { id: string; name: string }[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const option of options) {
    // Chapter name is a data value, not catalog copy — exempt from i18n for
    // the same reason REQ-013 §2.2 exempted the two fixed language-name
    // button labels (design §2.3).
    keyboard.text(option.name, `chapter:${option.id}`).row();
  }
  return keyboard;
}

// Truncates `text` (never `text` unmodified if it already fits) from the end
// until its UTF-8 byte length is <= maxBytes. Trims whole characters only —
// never splits a multi-byte code point — by shrinking one character at a
// time rather than slicing a fixed byte offset into the buffer.
function truncateToByteBudget(text: string, maxBytes: number): string {
  let result = text;
  while (Buffer.byteLength(result, "utf8") > maxBytes) {
    result = result.slice(0, -1);
  }
  return result;
}

// REQ-016 rework — builds the `consent:agree` callback's callback_data,
// optionally carrying a deep-link payload (`e_<id>` or `e_<id>__<channel>`,
// the exact grammar `parseStartPayload` already parses) so the consent
// callback handler can complete deep-link resolution after recording
// consent. Telegram caps callback_data at 64 bytes total; the event id is
// never truncated (it is required to resolve the event at all — a real
// event UUID plus the fixed `consent:agree:e_` prefix is ~52 bytes, always
// comfortably under the limit on its own), so if the encoded string doesn't
// fit, only the trailing, opaque `channel` free-text (§6.2 — not validated
// against a closed vocabulary, so it carries no correctness requirement
// beyond "recorded practically") is truncated to whatever budget remains.
function buildConsentAgreeCallbackData(payloadText: string | null): string {
  if (payloadText === null) {
    return CONSENT_AGREE_CALLBACK;
  }

  const full = `${CONSENT_AGREE_CALLBACK}:${payloadText}`;
  if (Buffer.byteLength(full, "utf8") <= CALLBACK_DATA_MAX_BYTES) {
    return full;
  }

  const parsed = parseStartPayload(payloadText);
  if (parsed.kind === "event" && parsed.channel !== null) {
    const fixedPrefix = `${CONSENT_AGREE_CALLBACK}:e_${parsed.eventId}__`;
    const budget = CALLBACK_DATA_MAX_BYTES - Buffer.byteLength(fixedPrefix, "utf8");
    if (budget <= 0) {
      return CONSENT_AGREE_CALLBACK;
    }
    return `${fixedPrefix}${truncateToByteBudget(parsed.channel, budget)}`;
  }

  // docs/agents/design/REQ-038.md §5.2 — the /redeem command's with-suffix
  // grammar (i_<code>__<eventId>). Here the "primary" this truncation logic
  // must never truncate is `code` (the primary token, mirroring `eventId`'s
  // role in the "event" branch above); the truncatable tail is the optional
  // eventId suffix, the same role `channel` plays there. BACKEND-DEV extends
  // this existing truncation branch rather than writing a second one, per the
  // design's own instruction.
  if (parsed.kind === "invite" && parsed.eventId !== null) {
    const fixedPrefix = `${CONSENT_AGREE_CALLBACK}:i_${parsed.code}__`;
    const budget = CALLBACK_DATA_MAX_BYTES - Buffer.byteLength(fixedPrefix, "utf8");
    if (budget <= 0) {
      return CONSENT_AGREE_CALLBACK;
    }
    return `${fixedPrefix}${truncateToByteBudget(parsed.eventId, budget)}`;
  }

  // The primary token (event id / invite code) alone already exceeds the
  // limit (should not happen for a real UUID/code) — fall back to a plain
  // consent tap rather than send an oversized/invalid callback_data; the
  // deep-link resolution is lost for this tap, same as any other
  // unattributed /start.
  return CONSENT_AGREE_CALLBACK;
}

// REQ-019 §3.3 — exported (was file-private): reused by
// domain/onboarding.ts's advanceOnboarding for the "consent-needed" step.
export function buildConsentKeyboard(
  lang: BotLang,
  payloadText: string | null = null,
): InlineKeyboard {
  return new InlineKeyboard().text(
    getCatalog(lang).consent.agree,
    buildConsentAgreeCallbackData(payloadText),
  );
}

/**
 * Chapter assignment (design §2.3's 0/1/2+ branches over
 * `domain/chapter.ts`), run ONLY after consent has already been recorded —
 * see this file's header note. Called from two places, both of which are
 * already past the consent gate when they call it: `/start` itself (a
 * returning, already-consented user who still has no chapter), and the
 * `consent:agree` callback (immediately after `recordConsent` succeeds).
 *
 * Returns `"stopped"` when the 2+-chapter ask-once prompt was sent (the flow
 * pauses and resumes in the chapter callback, §2.6); `"continue"` when the
 * caller should proceed straight to the greeting (0 or 1 active chapter).
 *
 * REQ-019 §3.2/§3.3 — exported (was file-private): `domain/onboarding.ts`'s
 * `advanceOnboarding` deliberately does NOT run chapter assignment itself
 * (keeping this function's existing, already-reviewed 0/1/2+ branching
 * untouched); `handlers/profile.ts`'s entry points, which have no
 * pre-existing chapter gate of their own the way `/start`'s call sites do,
 * call this function directly on a `"chapter-needed"` onboarding step.
 */
export async function assignChapterOrPrompt(
  ctx: Context,
  db: DbClient["db"],
  userId: string,
  lang: BotLang,
): Promise<"stopped" | "continue"> {
  const signal = await getActiveChapterSignal(db);

  if (signal.length >= 2) {
    const options = await listActiveChapters(db);
    await ctx.reply(getCatalog(lang).chapter.prompt, {
      reply_markup: buildChapterKeyboard(options),
    });
    return "stopped"; // resumes in the chapter callback (§2.6)
  }

  if (signal.length === 0) {
    await ctx.reply(getCatalog(lang).start.noActiveChapters);
    return "continue";
  }

  const onlyChapter = signal[0];
  if (onlyChapter !== undefined) {
    await assignChapter(db, userId, onlyChapter.id);
  }
  return "continue";
}

/**
 * `/start` — resolve-or-create the User row, then run the full onboarding
 * flow: consent FIRST (if still outstanding — this always stops the flow
 * here for a brand-new user), then chapter assignment (only reachable once
 * consent is already recorded), then the greeting.
 */
export function makeStartHandler(db: DbClient["db"], sender: NotificationSender | null = null) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }

    const mappedLang = mapTelegramLanguageCode(ctx.from?.language_code);
    const tgUsername = ctx.from?.username ?? null;

    // docs/agents/design/REQ-040.md §2.2 — resolvePersonalCodeIdentity runs
    // BEFORE resolveOrCreateUser, and only when the payload parses as an
    // `i_<code>` personal-invite link. Every other payload kind (event,
    // checkin, none) is completely unaffected — parseStartPayload is
    // evaluated here (earlier than this handler used to run it) purely to
    // make this one check possible; its result is reused unchanged below,
    // never re-parsed.
    const payload = parseStartPayload(matchText(ctx));
    let identityResolvedUserId: string | null = null;
    if (payload.kind === "invite") {
      const identity = await resolvePersonalCodeIdentity(
        db,
        payload.code,
        BigInt(tgId),
        tgUsername,
        mappedLang,
        new Date(),
      );
      if (identity.kind !== "not-applicable") {
        // "linked" — the pre-created row was just UPDATEd to this tg_id.
        // "collision-relinked" — the caller's own pre-existing row already
        // carries this tg_id. Either way, resolveOrCreateUser below is
        // skipped for this request; the next read (getFlowUserByTgId)
        // already resolves the correct row by tg_id.
        identityResolvedUserId = identity.userId;
      }
    }

    if (identityResolvedUserId === null) {
      await resolveOrCreateUser(db, {
        tgId: BigInt(tgId),
        tgUsername,
        lang: mappedLang,
      });
    }

    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      // Unreachable: either resolveOrCreateUser or resolvePersonalCodeIdentity
      // just guaranteed a row with this tg_id exists.
      return;
    }

    const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);

    // REQ-016 §6.3 — deep-link payload branch, checked immediately after
    // user creation/linking (step 7) and before the ordinary REQ-014 flow's
    // own logic runs at all (consent gate included) — the design's §6.3
    // does not route a deep-link open through onboarding, only through
    // event resolution.
    if (payload.kind === "event") {
      // REQ-016 rework — consent state decides whether the published-event
      // write path runs now or is deferred to the consent callback;
      // resolveEventDeepLink itself enforces the gate (see its own header
      // note above).
      await resolveEventDeepLink(
        ctx,
        db,
        flowUser.id,
        lang,
        payload.eventId,
        payload.channel,
        flowUser.consentPdAt !== null,
      );
      return;
    }

    // docs/agents/design/REQ-029.md §1.2 -- a second branch alongside the
    // "event" branch above, on the same already-resolved flowUser. No
    // consent gate here (§1.2's own "why no consent gate" reasoning): the
    // check-in flow writes nothing about the SCANNER beyond what
    // checked_in_by (a foreign key to their existing users.id row) records
    // on someone else's registration.
    if (payload.kind === "checkin") {
      await resolveCheckinQrDeepLink(ctx, db, flowUser.id, lang, payload.qrToken);
      return;
    }

    // docs/agents/design/REQ-038.md §4 -- a third branch alongside "event"/
    // "checkin", on the same already-resolved flowUser. Consent state decides
    // whether redemption runs now or is deferred to the consent callback;
    // resolveInviteDeepLink itself enforces the gate (S1, same discipline as
    // resolveEventDeepLink above).
    if (payload.kind === "invite") {
      await resolveInviteDeepLink(
        ctx,
        db,
        flowUser.id,
        lang,
        payload.code,
        payload.eventId,
        flowUser.consentPdAt !== null,
        sender,
      );
      return;
    }

    // Consent gate comes before anything chapter-related touches the
    // database — no chapter query, no chapter write, nothing — for a
    // brand-new user this is always still null and the flow stops here.
    if (flowUser.consentPdAt === null) {
      await ctx.reply(getCatalog(lang).consent.prompt, {
        reply_markup: buildConsentKeyboard(lang),
      });
      return; // STOP — resumes in the consent callback (§2.5)
    }

    // Consent is already recorded (a returning, partially-onboarded user
    // who has no chapter yet) — only now is it safe to run chapter
    // assignment.
    let hasChapter = flowUser.chapterId !== null;
    if (!hasChapter) {
      const chapterOutcome = await assignChapterOrPrompt(ctx, db, flowUser.id, lang);
      if (chapterOutcome === "stopped") {
        return;
      }
      // WF02-REQ-019 REWORK (Step 2b regate FAIL,
      // handoffs/WF02-REQ-019/step-02b-reviewer.json) — assignChapterOrPrompt
      // returning "continue" satisfies the chapter step for the rest of this
      // pass, EVEN in the zero-active-chapters case where `chapterId`
      // legitimately stays null forever (REQ-014's own `noActiveChapters`
      // branch above). Re-deriving `hasChapter` from `chapterId !== null`
      // below (as this file did before this rework) makes
      // `advanceOnboarding` report "chapter-needed" forever for that case —
      // an outcome this handler has no branch for, so the flow silently
      // stopped replying right after `noActiveChapters` and never sent the
      // greeting the pre-REQ-019 handler always sent here. Mirrors the exact
      // same "continue" treatment `handlers/profile.ts`'s
      // `reachReadyOrPrompt` helper already applies for its own call sites.
      hasChapter = true;
    }

    // Re-resolve via the same read-only shape the rest of the flow uses, so
    // resolveLang sees the (possibly just-assigned) chapter's default_lang.
    const finalUser = await getFlowUserByTgId(db, BigInt(tgId));
    const finalLang = resolveLang(
      finalUser?.lang ?? flowUser.lang,
      finalUser?.chapterDefaultLang ?? null,
    );

    // REQ-019 §3.3 — run the shared onboarding progression before falling
    // back to the plain greeting. Consent is already resolved and the
    // chapter step is resolved per `hasChapter` above (either an actual
    // chapter id, or the zero-active-chapters "continue" case), so this call
    // only ever asks a profile question or reports "ready" in practice.
    const outcome = await advanceOnboarding(ctx, db, flowUser.id, true, hasChapter, finalLang);
    if (outcome !== "ready") {
      return; // "prompted" already sent the next question
    }
    await ctx.reply(getCatalog(finalLang).start.greeting);
  };
}

/**
 * Handles the `chapter:<id>` callback tap (design §2.6). Only ever reached
 * via a keyboard sent from `/start` or the `consent:agree` callback, both of
 * which only send that keyboard after consent is already recorded — so this
 * handler's `assignChapter` write always happens with `consent_pd_at`
 * already non-null.
 */
export function makeChapterCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    const match = CHAPTER_CALLBACK_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    if (tgId === undefined || match === null) {
      await ctx.answerCallbackQuery();
      return;
    }
    const chapterId = match[1];
    if (chapterId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      await ctx.answerCallbackQuery();
      return;
    }

    const active = await isChapterActive(db, chapterId);
    await ctx.answerCallbackQuery();
    if (!active) {
      // §2.6 step 2 / §5 open question 4 — no dedicated catalog key exists
      // for this rare corrective path; the design flags this as a minor
      // open item rather than inventing unasked-for copy. The user is left
      // to re-run /start (no reply sent here).
      return;
    }

    await assignChapter(db, flowUser.id, chapterId);

    // The chapter just changed, so re-derive default_lang from the newly
    // assigned chapter rather than trusting the pre-assignment flowUser row.
    const refreshed = await getFlowUserByTgId(db, BigInt(tgId));
    const lang = resolveLang(
      refreshed?.lang ?? flowUser.lang,
      refreshed?.chapterDefaultLang ?? null,
    );

    // REQ-019 §3.3 — run the shared onboarding progression before falling
    // back to the plain greeting. This callback only ever fires once consent
    // is already recorded and a chapter was just assigned, so this call only
    // ever asks a profile question or reports "ready" in practice.
    const outcome = await advanceOnboarding(ctx, db, flowUser.id, true, true, lang);
    if (outcome !== "ready") {
      return; // "prompted" already sent the next question
    }
    await ctx.reply(getCatalog(lang).start.greeting);
  };
}

/**
 * Handles the `consent:agree` callback tap (design §2.5, reordered per this
 * file's header note). Records consent FIRST, then — and only then — runs
 * chapter assignment (§2.3's 0/1/2+ branches) if the user doesn't already
 * have one, so `users.chapter_id` is never written while `consent_pd_at` is
 * still null.
 *
 * WF02-REQ-016 SECURITY REWORK (iteration 1) — the callback_data may now
 * carry a deep-link payload (`consent:agree:e_<id>[__<channel>]`, see
 * `buildConsentAgreeCallbackData`). Ordering after `recordConsent` succeeds
 * is: chapter assignment first (unchanged, exactly REQ-014's existing
 * order), then — regardless of whether chapter assignment itself paused for
 * the 2+-chapter pick — deep-link resolution runs if a payload was present,
 * so the `pending_source` write never depends on the chapter picker's own
 * callback and never precedes consent. A deep-link tap's reply is the event
 * placeholder/explanation, not the ordinary greeting — the same trade-off
 * the already-consented fast path in `makeStartHandler` already makes.
 */
export function makeConsentCallbackHandler(db: DbClient["db"], sender: NotificationSender | null = null) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    const match = CONSENT_AGREE_CALLBACK_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    if (tgId === undefined || match === null) {
      await ctx.answerCallbackQuery();
      return;
    }
    const deepLinkPayloadText = match[1] ?? null;

    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      // §2.5 step 2 — a stale/forwarded callback with no backing users row.
      // Answer the tap and leave it there; no dedicated fallback reply is
      // specified for this genuinely uncovered case.
      await ctx.answerCallbackQuery();
      return;
    }

    await recordConsent(db, flowUser.id, new Date());
    await ctx.answerCallbackQuery();

    const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);

    // Consent is now recorded — safe to run chapter assignment (this is the
    // ordering fix: chapter writes never precede consent_pd_at). Chapter
    // assignment always runs first per REQ-014's existing order, whether or
    // not a deep-link payload is also being carried through this tap.
    let hasChapter = flowUser.chapterId !== null;
    let chapterOutcome: "stopped" | "continue" = "continue";
    if (!hasChapter) {
      chapterOutcome = await assignChapterOrPrompt(ctx, db, flowUser.id, lang);
      if (chapterOutcome === "continue") {
        // WF02-REQ-019 REWORK (Step 2b regate FAIL) — see makeStartHandler's
        // identical comment above: "continue" (including the
        // zero-active-chapters `noActiveChapters` branch, where `chapterId`
        // stays null forever) satisfies the chapter step for this pass, so
        // `advanceOnboarding` below is never asked to re-derive it as false.
        hasChapter = true;
      }
    }

    // REQ-016 rework — complete the deferred deep-link resolution now that
    // consent is recorded. This runs regardless of chapterOutcome: a 2+
    // chapter pick pauses only the *greeting*, sent later by the chapter
    // callback (§2.6) — it does not pause this write, which depends only on
    // consent, not on chapter assignment completing.
    if (deepLinkPayloadText !== null) {
      const payload = parseStartPayload(deepLinkPayloadText);
      if (payload.kind === "event") {
        await resolveEventDeepLink(
          ctx,
          db,
          flowUser.id,
          lang,
          payload.eventId,
          payload.channel,
          true, // hasConsented — recordConsent just succeeded above
        );
      } else if (payload.kind === "invite") {
        // docs/agents/design/REQ-038.md §4.3 -- one new sibling branch, same
        // position, same "already consented" `true` argument, same "this
        // already sent the caller's reply, no separate ordinary greeting"
        // trade-off the "event" branch above already documents.
        await resolveInviteDeepLink(
          ctx,
          db,
          flowUser.id,
          lang,
          payload.code,
          payload.eventId,
          true, // hasConsented — recordConsent just succeeded above
          sender,
        );
      }
      // The deep-link branch (or, for a malformed payload, nothing) has
      // already sent the caller's reply — no separate ordinary greeting, the
      // same trade-off the already-consented fast path in makeStartHandler
      // already makes.
      return;
    }

    if (chapterOutcome === "stopped") {
      return; // resumes in the chapter callback (§2.6)
    }

    const finalUser = await getFlowUserByTgId(db, BigInt(tgId));
    const finalLang = resolveLang(
      finalUser?.lang ?? flowUser.lang,
      finalUser?.chapterDefaultLang ?? null,
    );

    // REQ-019 §3.3 — run the shared onboarding progression before falling
    // back to the plain greeting. Consent was just recorded above and the
    // chapter step is resolved per `hasChapter` above (chapterOutcome !==
    // "stopped" — either an actual chapter id, or the zero-active-chapters
    // "continue" case), so this call only ever asks a profile question or
    // reports "ready" in practice.
    const outcome = await advanceOnboarding(ctx, db, flowUser.id, true, hasChapter, finalLang);
    if (outcome !== "ready") {
      return; // "prompted" already sent the next question
    }
    await ctx.reply(getCatalog(finalLang).start.greeting);
  };
}
