import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { requireEventStaffForEvent } from "../domain/eventStaffAuthorization.js";
import { getEventById } from "../domain/event.js";
import { getUserWithChapterByTgId } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// REQ-018 §0.3/§4.3 — /checkin <event_id>: the authorization-only stub. Its
// ENTIRE job is (a) run the EventStaff gate, and (b) on success, acknowledge
// that the caller is authorized for that one event. It performs NO check-in
// business logic: no qr_token is read, no registrations row is read or
// written, no AuditLog row is written (REQ-028/029's scope, per design §0.3).

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const row = await getUserWithChapterByTgId(db, BigInt(tgId));
  return row === null ? resolveLang(null, null) : resolveLang(row.lang, row.chapterDefaultLang);
}

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

export function makeCheckInHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);

    const eventId = matchText(ctx).trim();
    if (eventId.length === 0) {
      await ctx.reply(getCatalog(lang).checkin.usageNoId);
      return;
    }

    // §4.3 step 4 — same "reveal not-found before authorization" ordering
    // handlers/venue.ts's/handlers/event.ts's own edit/delete handlers
    // already use.
    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.reply(getCatalog(lang).checkin.notFound);
      return;
    }
    if (event.endsAt === null) {
      // Defensive/unreachable path: createEvent enforces endsAt NOT NULL.
      await ctx.reply(getCatalog(lang).checkin.notFound);
      return;
    }

    const authResult = await requireEventStaffForEvent(
      db,
      BigInt(tgId),
      event.id,
      event.endsAt,
      new Date(),
    );
    if (!authResult.ok) {
      // One generic string — the specific reason is never disclosed to the
      // caller, same "don't leak which check failed" discipline
      // venue.notAuthorized/event.notAuthorized already follow.
      await ctx.reply(getCatalog(lang).checkin.notAuthorized);
      return;
    }

    // §4.3 step 7 — plain acknowledgment only. No further action.
    await ctx.reply(getCatalog(lang).checkin.authorizedStub.replace("{event}", event.title));
  };
}
