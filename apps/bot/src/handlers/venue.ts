import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import {
  checkOrganizerForChapter,
  requireOrganizerForChapter,
  resolveActingUser,
} from "../domain/venueAuthorization.js";
import {
  createVenue,
  deleteVenue,
  getVenueById,
  hasFutureEventReference,
  listVenuesForChapter,
  parseVenueFields,
  updateVenue,
  validateVenueCreateInput,
  validateVenueUpdateInput,
  type VenueRecord,
} from "../domain/venue.js";
import { getUserWithChapterByTgId } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// REQ-015 §2-§6 — command wiring only: this file sequences calls into the
// framework-free domain modules (domain/venueAuthorization.ts,
// domain/venue.ts) and composes replies. No domain logic lives here
// (decisions/0004) — every authorization check, validation rule, and
// mutation is a call into `domain/`.
//
// Authorization is the FIRST thing every mutation handler does after the
// minimal parsing needed to know WHAT to authorize against (§1's own
// carve-out for create's optional `chapter` override, §2.5) — no reply, no
// DB write of the venues/audit_log tables happens on any path that has not
// passed the `{ ok: true }` branch.

async function resolveLangForTg(
  db: DbClient["db"],
  tgId: number,
): Promise<BotLang> {
  const row = await getUserWithChapterByTgId(db, BigInt(tgId));
  return row === null
    ? resolveLang(null, null)
    : resolveLang(row.lang, row.chapterDefaultLang);
}

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

function formatVenueDump(venue: VenueRecord): string {
  return [
    `name: ${venue.name}`,
    `address: ${venue.address}`,
    `yandex: ${venue.yandexUrl ?? ""}`,
    `google: ${venue.googleUrl ?? ""}`,
    `capacity: ${venue.capacity}`,
    `lat: ${venue.lat ?? ""}`,
    `lon: ${venue.lon ?? ""}`,
    `notes: ${venue.notes ?? ""}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /venue_new (§2)
// ---------------------------------------------------------------------------
export function makeVenueNewHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const body = matchText(ctx);

    if (body.trim().length === 0) {
      await ctx.reply(getCatalog(lang).venue.createUsage);
      return;
    }

    const fields = parseVenueFields(body);

    // §2.5 — the only parsing done before the authorization check is
    // extracting the optional `chapter` override; everything else in
    // `fields` is validated only after authorization passes.
    const actingUser = await resolveActingUser(db, BigInt(tgId));
    const chapterOverride = fields["chapter"]?.trim();
    const targetChapterId =
      chapterOverride !== undefined && chapterOverride.length > 0
        ? chapterOverride
        : (actingUser?.chapterId ?? "");

    const authResult = checkOrganizerForChapter(actingUser, targetChapterId);
    if (!authResult.ok) {
      await ctx.reply(getCatalog(lang).venue.notAuthorized);
      return;
    }

    const validation = validateVenueCreateInput(fields);
    if (!validation.ok) {
      await ctx.reply(
        `${getCatalog(lang).venue.missingFieldsPrefix} ${validation.missing.join(", ")}`,
      );
      return;
    }

    const venueId = await createVenue(
      db,
      authResult.user.id,
      targetChapterId,
      validation.value,
      new Date(),
    );

    let reply = `${getCatalog(lang).venue.createSuccessPrefix} ${venueId}`;
    if (validation.value.lat === null || validation.value.lon === null) {
      reply += `\n${getCatalog(lang).venue.completeNudge}`;
    }
    await ctx.reply(reply);
  };
}

// ---------------------------------------------------------------------------
// /venue_edit <id> (§4)
// ---------------------------------------------------------------------------
export function makeVenueEditHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);

    const raw = matchText(ctx);
    const lines = raw.split("\n");
    const venueId = (lines[0] ?? "").trim();
    const rest = lines.slice(1).join("\n");

    if (venueId.length === 0) {
      await ctx.reply(getCatalog(lang).venue.editUsageNoId);
      return;
    }

    // §4 step 1 — read the venue BEFORE the authorization check, since
    // targetChapterId for edit is sourced from the existing row, not from
    // caller input.
    const venue = await getVenueById(db, venueId);
    if (venue === null) {
      await ctx.reply(getCatalog(lang).venue.notFound);
      return;
    }

    // §4 step 2 — authorization, unchanged from §1, targeted at the venue's
    // own chapter.
    const authResult = await requireOrganizerForChapter(
      db,
      BigInt(tgId),
      venue.chapterId,
    );
    if (!authResult.ok) {
      await ctx.reply(getCatalog(lang).venue.notAuthorized);
      return;
    }

    if (rest.trim().length === 0) {
      await ctx.reply(
        `${getCatalog(lang).venue.editCurrentPrefix}\n${formatVenueDump(venue)}`,
      );
      return;
    }

    const fields = parseVenueFields(rest);
    const validation = validateVenueUpdateInput(fields);
    if (!validation.ok) {
      await ctx.reply(
        `${getCatalog(lang).venue.missingFieldsPrefix} ${validation.missing.join(", ")}`,
      );
      return;
    }

    if (validation.changedFields.length === 0) {
      await ctx.reply(
        `${getCatalog(lang).venue.editCurrentPrefix}\n${formatVenueDump(venue)}`,
      );
      return;
    }

    await updateVenue(
      db,
      authResult.user.id,
      venueId,
      venue.chapterId,
      validation.changes,
      validation.changedFields,
      new Date(),
    );

    // §2.4's closing note — the nudge is re-derived every time from
    // `lat === null` on the venue AFTER this edit, never a stored flag.
    const latAfterUpdate =
      "lat" in validation.changes ? validation.changes.lat : venue.lat;

    let reply = `${getCatalog(lang).venue.editSuccessPrefix} ${validation.changedFields.join(", ")}`;
    if (latAfterUpdate === null) {
      reply += `\n${getCatalog(lang).venue.completeNudge}`;
    }
    await ctx.reply(reply);
  };
}

// ---------------------------------------------------------------------------
// /venue_delete <id> (§5)
// ---------------------------------------------------------------------------
export function makeVenueDeleteHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);

    const venueId = matchText(ctx).trim();
    if (venueId.length === 0) {
      await ctx.reply(getCatalog(lang).venue.deleteUsageNoId);
      return;
    }

    const venue = await getVenueById(db, venueId);
    if (venue === null) {
      await ctx.reply(getCatalog(lang).venue.notFound);
      return;
    }

    const authResult = await requireOrganizerForChapter(
      db,
      BigInt(tgId),
      venue.chapterId,
    );
    if (!authResult.ok) {
      await ctx.reply(getCatalog(lang).venue.notAuthorized);
      return;
    }

    // §5 step 3 — the future-event check runs, and is refused, BEFORE any
    // DELETE is attempted, so the application-level refusal message is what
    // the caller sees, never a raw FK-violation error (design §5's own
    // "restrict FK tension" note — this ordering is what keeps the two from
    // colliding for the future-event case; see this requirement's handoff
    // report for the past-events-only tension that remains open per §9.2).
    const hasFuture = await hasFutureEventReference(db, venueId, new Date());
    if (hasFuture) {
      await ctx.reply(getCatalog(lang).venue.deleteRefusedFutureEvent);
      return;
    }

    await deleteVenue(
      db,
      authResult.user.id,
      venueId,
      { chapterId: venue.chapterId, name: venue.name },
      new Date(),
    );
    await ctx.reply(`${getCatalog(lang).venue.deleteSuccessPrefix} ${venue.name}`);
  };
}

// ---------------------------------------------------------------------------
// /venues (§3) — not gated by requireOrganizerForChapter (design §3's own
// scope note): a plain read scoped to the caller's own chapter.
// ---------------------------------------------------------------------------
export function makeVenuesListHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);

    const actingUser = await resolveActingUser(db, BigInt(tgId));
    const chapterId = actingUser?.chapterId ?? null;
    if (chapterId === null) {
      await ctx.reply(getCatalog(lang).venue.listEmpty);
      return;
    }

    const list = await listVenuesForChapter(db, chapterId);
    if (list.length === 0) {
      await ctx.reply(getCatalog(lang).venue.listEmpty);
      return;
    }

    const lines = list.map((venue) => `${venue.name} — ${venue.address}`);
    await ctx.reply(`${getCatalog(lang).venue.listHeader}\n${lines.join("\n")}`);
  };
}
