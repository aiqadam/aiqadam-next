import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import {
  checkOrganizerForChapter,
  requireOrganizerForChapter,
  resolveActingUser,
} from "../domain/eventAuthorization.js";
import {
  countAdmittedRegistrations,
  createEvent,
  cancelEvent,
  findMissingPublishFields,
  getEventById,
  parseAgendaText,
  parseEventFields,
  publishEvent,
  updateEvent,
  validateAgenda,
  validateEventCreateInput,
  validateEventUpdateInput,
  type EventRecord,
} from "../domain/event.js";
import { getUserWithChapterByTgId } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// REQ-016 §2-§7 — command wiring only: this file sequences calls into the
// framework-free domain modules (domain/eventAuthorization.ts, domain/event.ts)
// and composes replies. No domain logic lives here (decisions/0004) — every
// authorization check, validation rule, and mutation is a call into `domain/`.
//
// Authorization is the FIRST thing every mutation handler does after the
// minimal parsing needed to know WHAT to authorize against, mirroring
// REQ-015's handlers/venue.ts precedent exactly.

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const row = await getUserWithChapterByTgId(db, BigInt(tgId));
  return row === null ? resolveLang(null, null) : resolveLang(row.lang, row.chapterDefaultLang);
}

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

function formatEventDump(event: EventRecord): string {
  return [
    `title: ${event.title}`,
    `description: ${event.description}`,
    `format: ${event.format}`,
    `venue: ${event.venueId ?? ""}`,
    `starts: ${event.startsAt?.toISOString() ?? ""}`,
    `ends: ${event.endsAt?.toISOString() ?? ""}`,
    `registration_closes: ${event.registrationClosesAt?.toISOString() ?? ""}`,
    `capacity: ${event.capacity ?? ""}`,
    `requires_invite: ${event.requiresInvite}`,
    `requires_approval: ${event.requiresApproval}`,
    `cover_file_id: ${event.coverFileId ?? ""}`,
    `status: ${event.status}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// /event_new (§2)
// ---------------------------------------------------------------------------
export function makeEventNewHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const body = matchText(ctx);

    if (body.trim().length === 0) {
      await ctx.reply(getCatalog(lang).event.createUsage);
      return;
    }

    const fields = parseEventFields(body);

    // Same §2.5-style carve-out as REQ-015: the only parsing done before the
    // authorization check is extracting the optional `chapter` override.
    const actingUser = await resolveActingUser(db, BigInt(tgId));
    const chapterOverride = fields["chapter"]?.trim();
    const targetChapterId =
      chapterOverride !== undefined && chapterOverride.length > 0
        ? chapterOverride
        : (actingUser?.chapterId ?? "");

    const authResult = checkOrganizerForChapter(actingUser, targetChapterId);
    if (!authResult.ok) {
      await ctx.reply(getCatalog(lang).event.notAuthorized);
      return;
    }

    const validation = validateEventCreateInput(fields);
    if (!validation.ok) {
      await ctx.reply(
        `${getCatalog(lang).event.missingFieldsPrefix} ${validation.missing.join(", ")}`,
      );
      return;
    }

    const eventId = await createEvent(
      db,
      authResult.user.id,
      targetChapterId,
      validation.value,
      new Date(),
    );

    await ctx.reply(`${getCatalog(lang).event.createSuccessPrefix} ${eventId}`);
  };
}

// ---------------------------------------------------------------------------
// /event_edit <id> (§4)
// ---------------------------------------------------------------------------
export function makeEventEditHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);

    const raw = matchText(ctx);
    const lines = raw.split("\n");
    const eventId = (lines[0] ?? "").trim();
    const rest = lines.slice(1).join("\n");

    if (eventId.length === 0) {
      await ctx.reply(getCatalog(lang).event.editUsageNoId);
      return;
    }

    // §4 — read the event BEFORE the authorization check: targetChapterId
    // for edit is sourced from the existing row, never from caller input.
    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.reply(getCatalog(lang).event.notFound);
      return;
    }

    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.reply(getCatalog(lang).event.notAuthorized);
      return;
    }

    if (rest.trim().length === 0) {
      await ctx.reply(`${getCatalog(lang).event.editCurrentPrefix}\n${formatEventDump(event)}`);
      return;
    }

    const fields = parseEventFields(rest);
    const validation = validateEventUpdateInput(fields);
    if (!validation.ok) {
      await ctx.reply(
        `${getCatalog(lang).event.missingFieldsPrefix} ${validation.missing.join(", ")}`,
      );
      return;
    }

    if (validation.changedFields.length === 0) {
      await ctx.reply(`${getCatalog(lang).event.editCurrentPrefix}\n${formatEventDump(event)}`);
      return;
    }

    // §3.4 site 2 — the capacity floor check, whenever the edit payload
    // touches capacity, runs before any write.
    if (validation.changes.capacity !== undefined) {
      const admittedCount = await countAdmittedRegistrations(db, eventId);
      if (validation.changes.capacity < admittedCount) {
        await ctx.reply(
          `${getCatalog(lang).event.capacityBelowAdmittedFloor} ${admittedCount}`,
        );
        return;
      }
    }

    await updateEvent(
      db,
      authResult.user.id,
      eventId,
      event.chapterId,
      validation.changes,
      validation.changedFields,
      new Date(),
    );

    await ctx.reply(
      `${getCatalog(lang).event.editSuccessPrefix} ${validation.changedFields.join(", ")}`,
    );
  };
}

// ---------------------------------------------------------------------------
// /event_agenda <id> (§7) — dedicated sub-flow for structured agenda edits,
// per design §7.1's note that the input-syntax decision is left to
// BACKEND-DEV as long as validateAgenda is the single function this path
// (and any future /event_edit agenda field) calls before any write.
// ---------------------------------------------------------------------------
export function makeEventAgendaHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);

    const raw = matchText(ctx);
    const lines = raw.split("\n");
    const eventId = (lines[0] ?? "").trim();
    const rest = lines.slice(1).join("\n");

    if (eventId.length === 0) {
      await ctx.reply(getCatalog(lang).event.editUsageNoId);
      return;
    }

    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.reply(getCatalog(lang).event.notFound);
      return;
    }

    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.reply(getCatalog(lang).event.notAuthorized);
      return;
    }

    const parsed = parseAgendaText(rest);
    if (!parsed.ok) {
      await ctx.reply(`${getCatalog(lang).event.missingFieldsPrefix} agenda`);
      return;
    }

    if (event.startsAt === null || event.endsAt === null) {
      // Unreachable through createEvent (both NOT NULL); guarded per this
      // codebase's no-speculation stance.
      await ctx.reply(getCatalog(lang).event.notFound);
      return;
    }

    const agendaCheck = validateAgenda(parsed.items, event.startsAt, event.endsAt);
    if (!agendaCheck.ok) {
      if (agendaCheck.reason === "multiple-doors") {
        await ctx.reply(getCatalog(lang).event.agendaRefusedMultipleDoors);
        return;
      }
      if (agendaCheck.reason === "doors-after-start") {
        await ctx.reply(
          `${getCatalog(lang).event.agendaRefusedDoorsAfterStart} ${agendaCheck.item.label}`,
        );
        return;
      }
      await ctx.reply(
        `${getCatalog(lang).event.agendaRefusedItemAfterEnd} ${agendaCheck.item.label}`,
      );
      return;
    }

    await updateEvent(
      db,
      authResult.user.id,
      eventId,
      event.chapterId,
      { agenda: parsed.items },
      ["agenda"],
      new Date(),
    );

    await ctx.reply(`${getCatalog(lang).event.editSuccessPrefix} agenda`);
  };
}

// ---------------------------------------------------------------------------
// /event_publish <id> (§5)
// ---------------------------------------------------------------------------
export function makeEventPublishHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);

    const eventId = matchText(ctx).trim();
    if (eventId.length === 0) {
      await ctx.reply(getCatalog(lang).event.publishUsageNoId);
      return;
    }

    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.reply(getCatalog(lang).event.notFound);
      return;
    }

    // §1 — authorization FIRST, before any state-machine or field check.
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.reply(getCatalog(lang).event.notAuthorized);
      return;
    }

    if (event.status !== "draft") {
      await ctx.reply(getCatalog(lang).event.publishRefusedNotDraft);
      return;
    }

    const missing = findMissingPublishFields(event);
    if (missing.length > 0) {
      await ctx.reply(
        `${getCatalog(lang).event.publishRefusedMissingFields} ${missing.join(", ")}`,
      );
      return;
    }

    // §3.4 call site 1 — defense-in-depth re-check against the currently
    // stored capacity.
    const admittedCount = await countAdmittedRegistrations(db, eventId);
    if (event.capacity !== null && event.capacity < admittedCount) {
      await ctx.reply(`${getCatalog(lang).event.capacityBelowAdmittedFloor} ${admittedCount}`);
      return;
    }

    await publishEvent(
      db,
      authResult.user.id,
      eventId,
      event.chapterId,
      event.title,
      new Date(),
    );

    await ctx.reply(`${getCatalog(lang).event.publishSuccessPrefix} ${event.title}`);
  };
}

// ---------------------------------------------------------------------------
// /event_cancel <id> (§5)
// ---------------------------------------------------------------------------
export function makeEventCancelHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);

    const eventId = matchText(ctx).trim();
    if (eventId.length === 0) {
      await ctx.reply(getCatalog(lang).event.cancelUsageNoId);
      return;
    }

    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.reply(getCatalog(lang).event.notFound);
      return;
    }

    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.reply(getCatalog(lang).event.notAuthorized);
      return;
    }

    if (event.status !== "published") {
      await ctx.reply(getCatalog(lang).event.cancelRefusedNotPublished);
      return;
    }

    // Explicit scope boundary (design §5's closing note): state transition +
    // audit row ONLY. No registrations read, no notification of any kind
    // (REQ-027's scope).
    await cancelEvent(db, authResult.user.id, eventId, event.chapterId, event.title, new Date());

    await ctx.reply(`${getCatalog(lang).event.cancelSuccessPrefix} ${event.title}`);
  };
}
