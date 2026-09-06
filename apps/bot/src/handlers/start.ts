import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import {
  assignChapter,
  getActiveChapterSignal,
  isChapterActive,
  listActiveChapters,
} from "../domain/chapter.js";
import { recordConsent } from "../domain/consent.js";
import { getEventById, parseStartPayload, setPendingSource } from "../domain/event.js";
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

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

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
): Promise<void> {
  const event = await getEventById(db, eventId);

  // §6.3 step 4/5 — an unknown id and a draft/cancelled/finished event both
  // yield the identical plain explanation; neither discloses whether the id
  // ever existed or what state it's in.
  if (event === null || event.status !== "published") {
    await ctx.reply(
      `${getCatalog(lang).event.deepLinkNotAvailable}\n${getCatalog(lang).event.deepLinkSeeUpcoming}`,
    );
    return;
  }

  // §6.5 — the pending-source write happens only for a published event's
  // channel-suffixed link; a draft/cancelled/finished target never records
  // one (handled above, this line is only reached once event is published).
  if (channel !== null) {
    await setPendingSource(db, userId, channel);
  }

  const startsAtText = event.startsAt?.toISOString() ?? "";
  await ctx.reply(
    `${getCatalog(lang).event.deepLinkPublishedPlaceholder} ${event.title} (${startsAtText})`,
  );
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

function buildConsentKeyboard(lang: BotLang): InlineKeyboard {
  return new InlineKeyboard().text(
    getCatalog(lang).consent.agree,
    CONSENT_AGREE_CALLBACK,
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
      await resolveEventDeepLink(ctx, db, flowUser.id, lang, payload.eventId, payload.channel);
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
 */
export function makeConsentCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

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
    // ordering fix: chapter writes never precede consent_pd_at).
    if (flowUser.chapterId === null) {
      const outcome = await assignChapterOrPrompt(ctx, db, flowUser.id, lang);
      if (outcome === "stopped") {
        return; // resumes in the chapter callback (§2.6)
      }
    }

    const finalUser = await getFlowUserByTgId(db, BigInt(tgId));
    const finalLang = resolveLang(
      finalUser?.lang ?? flowUser.lang,
      finalUser?.chapterDefaultLang ?? null,
    );
    await ctx.reply(getCatalog(finalLang).start.greeting);
  };
}
