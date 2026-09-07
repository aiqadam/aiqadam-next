import { InlineKeyboard, InputFile, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { resolveActingUser } from "../domain/eventAuthorization.js";
import {
  decideWithdrawOutcome,
  getMyRegistrations,
  getWaitlistPosition,
  type MyRegistrationListItem,
} from "../domain/registration.js";
import { renderCheckInQrPng } from "../domain/qr.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { getFlowUserByTgId } from "../domain/user.js";
import { resolveLang } from "../i18n/resolveLang.js";
import { formatDateTimeInTimezone } from "../i18n/formatTimeInTimezone.js";
import { STATUS_CATALOG_KEY } from "./registration.js";

// docs/agents/design/REQ-024.md §3 — /my: the caller's own registrations,
// live status, computed waitlist position, the QR pass. One message per row
// (§3's closing note: a QR image can only be attached as a photo message's
// own content, and each row's withdraw button needs its own reply_markup —
// this is a structural constraint, not a stylistic choice).

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const flowUser = await getFlowUserByTgId(db, BigInt(tgId));
  return resolveLang(flowUser?.lang ?? null, flowUser?.chapterDefaultLang ?? null);
}

// §3 step 5d — the composed text for one row, reused by both the plain-text
// and photo-caption send paths (step f).
function composeRowText(
  row: MyRegistrationListItem,
  catalog: ReturnType<typeof getCatalog>,
  dateTimeText: string,
  waitlistPosition: number | null,
): string {
  const statusKey = STATUS_CATALOG_KEY[row.admission];
  const lines = [catalog.registration[statusKey], row.eventTitle, dateTimeText];
  if (row.admission === "waitlisted" && waitlistPosition !== null) {
    lines.push(`${catalog.registration.waitlistedPositionPrefix} ${waitlistPosition}`);
  }
  return lines.join("\n");
}

// §3 — the /my command handler.
export function makeMyCommandHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    // §3 step 1 — defensive, unreachable via Telegram.
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }

    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    // §3 step 2 — §0.3 step 1: the only place a user identity enters this
    // path, resolved from Telegram's own authenticated sender id.
    const actingUser = await resolveActingUser(db, BigInt(tgId));
    if (actingUser === null) {
      await ctx.reply(catalog.profile.startFirst);
      return;
    }

    // §3 step 3 — §0.3 step 2: the sole caller-derived parameter.
    const rows = await getMyRegistrations(db, actingUser.id);

    // §3 step 4 — empty list.
    if (rows.length === 0) {
      await ctx.reply(catalog.my.emptyState);
      return;
    }

    // §3 step 5 — preamble, then one message per row, in the order returned.
    await ctx.reply(catalog.my.header);

    for (const row of rows) {
      // §3 step 5a.
      const startsAtText = formatDateTimeInTimezone(row.startsAt, row.chapterTimezone, lang);
      const endsAtText = formatDateTimeInTimezone(row.endsAt, row.chapterTimezone, lang);
      const dateTimeText = `${startsAtText}–${endsAtText}`;

      // §3 step 5c — computed live, never cached, only for waitlisted rows.
      const waitlistPosition =
        row.admission === "waitlisted"
          ? await getWaitlistPosition(db, row.eventId, row.registrationId)
          : null;

      const text = composeRowText(row, catalog, dateTimeText, waitlistPosition);

      // §3 step 5e — the withdraw button, shown only when eligible. Since
      // getMyRegistrations only ever returns the caller's own rows,
      // ownerUserId === actingUserId always by construction (§0.2's own
      // stated reasoning) -- "not-owner" can never fire from this call site.
      const withdrawOutcome = decideWithdrawOutcome({
        registrationExists: true,
        ownerUserId: actingUser.id,
        actingUserId: actingUser.id,
        admission: row.admission,
        checkedInAt: row.checkedInAt,
      });
      const replyMarkup =
        withdrawOutcome.kind === "withdrawn"
          ? new InlineKeyboard().text(catalog.my.withdrawButton, `withdraw:confirm:${row.registrationId}`)
          : undefined;

      // §3 step 5f — the QR gate (AC3, AC4): admitted + a non-null qr_token
      // only.
      if (row.admission === "admitted" && row.qrToken !== null) {
        const botUsername = ctx.me.username;
        const png = await renderCheckInQrPng({ botUsername, qrToken: row.qrToken });
        await ctx.replyWithPhoto(new InputFile(png), {
          caption: text,
          ...(replyMarkup !== undefined ? { reply_markup: replyMarkup } : {}),
        });
      } else if (replyMarkup !== undefined) {
        await ctx.reply(text, { reply_markup: replyMarkup });
      } else {
        await ctx.reply(text);
      }
    }
  };
}
