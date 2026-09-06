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
import { getVenueById } from "../domain/venue.js";
import { getFlowUserByTgId, resolveOrCreateUser } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { mapTelegramLanguageCode, resolveLang } from "../i18n/resolveLang.js";

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
const CONSENT_AGREE_CALLBACK_PATTERN = /^consent:agree(?::(.+))?$/;
// Telegram's hard limit on callback_data (bytes, not characters).
const CALLBACK_DATA_MAX_BYTES = 64;

function matchText(ctx: Context): string {
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

  // §3.5 — a stored cover_file_id is sent as a Telegram photo with the
  // card's full text as the caption; otherwise a plain text reply with the
  // same text. No re-upload, no fetch of the file content by this bot.
  if (content.coverFileId !== null) {
    await ctx.replyWithPhoto(content.coverFileId, { caption: text });
  } else {
    await ctx.reply(text);
  }
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

  lines.push(catalog.events.cardCta);

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
  if (parsed.kind !== "event" || parsed.channel === null) {
    // The event id alone already exceeds the limit (should not happen for a
    // real UUID) — fall back to a plain consent tap rather than send an
    // oversized/invalid callback_data; the deep-link resolution is lost for
    // this tap, same as any other unattributed /start.
    return CONSENT_AGREE_CALLBACK;
  }

  const fixedPrefix = `${CONSENT_AGREE_CALLBACK}:e_${parsed.eventId}__`;
  const budget = CALLBACK_DATA_MAX_BYTES - Buffer.byteLength(fixedPrefix, "utf8");
  if (budget <= 0) {
    return CONSENT_AGREE_CALLBACK;
  }
  return `${fixedPrefix}${truncateToByteBudget(parsed.channel, budget)}`;
}

function buildConsentKeyboard(lang: BotLang, payloadText: string | null = null): InlineKeyboard {
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
 */
async function assignChapterOrPrompt(
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
export function makeStartHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }

    const mappedLang = mapTelegramLanguageCode(ctx.from?.language_code);
    await resolveOrCreateUser(db, {
      tgId: BigInt(tgId),
      tgUsername: ctx.from?.username ?? null,
      lang: mappedLang,
    });

    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      // Unreachable: resolveOrCreateUser just guaranteed this row exists.
      return;
    }

    const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);

    // REQ-016 §6.3 — deep-link payload branch, checked immediately after
    // user creation (step 7) and before the ordinary REQ-014 flow's own
    // logic runs at all (consent gate included) — the design's §6.3 does
    // not route a deep-link open through onboarding, only through event
    // resolution.
    const payload = parseStartPayload(matchText(ctx));
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
    if (flowUser.chapterId === null) {
      const outcome = await assignChapterOrPrompt(ctx, db, flowUser.id, lang);
      if (outcome === "stopped") {
        return;
      }
    }

    // Re-resolve via the same read-only shape the rest of the flow uses, so
    // resolveLang sees the (possibly just-assigned) chapter's default_lang.
    const finalUser = await getFlowUserByTgId(db, BigInt(tgId));
    const finalLang = resolveLang(
      finalUser?.lang ?? flowUser.lang,
      finalUser?.chapterDefaultLang ?? null,
    );
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
export function makeConsentCallbackHandler(db: DbClient["db"]) {
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
    let chapterOutcome: "stopped" | "continue" = "continue";
    if (flowUser.chapterId === null) {
      chapterOutcome = await assignChapterOrPrompt(ctx, db, flowUser.id, lang);
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
    await ctx.reply(getCatalog(finalLang).start.greeting);
  };
}
