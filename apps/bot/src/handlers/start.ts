import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import {
  assignChapter,
  getActiveChapterSignal,
  isChapterActive,
  listActiveChapters,
} from "../domain/chapter.js";
import { recordConsent } from "../domain/consent.js";
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

const CHAPTER_CALLBACK_PATTERN = /^chapter:(.+)$/;
const CONSENT_AGREE_CALLBACK = "consent:agree";

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
 * Once chapter assignment is settled (silently assigned, zero-chapter
 * no-op, or resolved via the chapter callback), sends the consent prompt if
 * still outstanding, otherwise the greeting — design §2.4/§2.8's shared
 * tail, reused by `/start` itself and by the chapter callback handler.
 */
async function sendConsentOrGreeting(
  ctx: Context,
  lang: BotLang,
  consentPdAt: Date | null,
): Promise<void> {
  if (consentPdAt === null) {
    await ctx.reply(getCatalog(lang).consent.prompt, {
      reply_markup: buildConsentKeyboard(lang),
    });
    return;
  }
  await ctx.reply(getCatalog(lang).start.greeting);
}

/** `/start` — resolve-or-create the User row, then run the full onboarding flow. */
export function makeStartHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }

    const mappedLang = mapTelegramLanguageCode(ctx.from?.language_code);
    const user = await resolveOrCreateUser(db, {
      tgId: BigInt(tgId),
      tgUsername: ctx.from?.username ?? null,
      lang: mappedLang,
    });

    if (user.chapterId === null) {
      const signal = await getActiveChapterSignal(db);

      if (signal.length >= 2) {
        const lang = resolveLang(user.lang, null);
        const options = await listActiveChapters(db);
        await ctx.reply(getCatalog(lang).chapter.prompt, {
          reply_markup: buildChapterKeyboard(options),
        });
        return; // STOP — resumes in the chapter callback (§2.3/§2.6)
      }

      if (signal.length === 0) {
        const lang = resolveLang(user.lang, null);
        await ctx.reply(getCatalog(lang).start.noActiveChapters);
        // continue — chapter presence and consent are independent gates
      } else {
        const onlyChapter = signal[0];
        if (onlyChapter !== undefined) {
          await assignChapter(db, user.id, onlyChapter.id);
        }
      }
    }

    // Re-resolve via the same read-only shape the rest of the flow uses, so
    // resolveLang sees the (possibly just-assigned) chapter's default_lang.
    const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
    if (flowUser === null) {
      // Unreachable: resolveOrCreateUser just guaranteed this row exists.
      return;
    }

    const lang = resolveLang(flowUser.lang, flowUser.chapterDefaultLang);
    await sendConsentOrGreeting(ctx, lang, flowUser.consentPdAt);
  };
}

/** Handles the `chapter:<id>` callback tap (design §2.6). */
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
    await sendConsentOrGreeting(ctx, lang, flowUser.consentPdAt);
  };
}

/** Handles the `consent:agree` callback tap (design §2.5). */
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
    await ctx.reply(getCatalog(lang).start.greeting);
  };
}
