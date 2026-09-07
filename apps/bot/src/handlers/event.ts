import type { Context } from "grammy";
import type { DbClient } from "../db/client.js";
import {
  checkOrganizerForChapter,
  requireOrganizerForChapter,
  resolveActingUser,
} from "../domain/eventAuthorization.js";
import {
  buildSeatsLine,
  computeSeatsLeft,
  countAdmittedRegistrations,
  createEvent,
  cancelEvent,
  findMissingPublishFields,
  getEventById,
  listUpcomingPublishedEvents,
  parseAgendaText,
  parseEventFields,
  publishEvent,
  updateEvent,
  validateAgenda,
  validateEventCreateInput,
  validateEventUpdateInput,
  type EventRecord,
} from "../domain/event.js";
import {
  getRegistrationAdmissionAndEvent,
  selectNonWithdrawnRegistrantsForEvent,
} from "../domain/registration.js";
import {
  sendLedgeredNotification,
  type ComposedMessage,
  type NotificationSender,
} from "../domain/notification.js";
import { formatDateTimeInTimezone } from "../i18n/formatTimeInTimezone.js";
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
// docs/agents/design/REQ-027.md §3 — composeCancellationMessage: re-fetches
// the registration's CURRENT admission at send time (the same
// composeReminder24h/composeReminder3h freshness recheck), since
// sendLedgeredNotification only calls composeMessage AFTER its ledger INSERT
// has already committed — the registration can, in principle, have been
// withdrawn between the batch's own selection read and this individual
// send. No re-check of events.status is needed: this batch runs exactly once,
// synchronously, immediately after cancelEvent has already committed
// 'cancelled', and there is no un-cancel transition in the state machine.
// ---------------------------------------------------------------------------
async function composeCancellationMessage(
  db: DbClient["db"],
  registrationId: string,
  eventTitle: string,
  lang: BotLang,
): Promise<ComposedMessage> {
  const registration = await getRegistrationAdmissionAndEvent(db, registrationId);
  if (registration === null || registration.admission === "withdrawn") {
    return { kind: "skip" };
  }

  const catalog = getCatalog(lang);
  const text = [catalog.event.cancelledNotificationHeader, eventTitle, catalog.event.deepLinkSeeUpcoming].join(
    "\n",
  );

  return { kind: "text", text };
}

// ---------------------------------------------------------------------------
// docs/agents/design/REQ-027.md §3 — notifyNonWithdrawnRegistrants: a fixed
// snapshot list selected once (selectNonWithdrawnRegistrantsForEvent), then a
// plain sequential for...of loop (no Promise.all fan-out, same shape as
// reminderJobs.ts's job run() bodies) calling sendLedgeredNotification once
// per candidate. classification is always "transactional" so a
// broadcast_opt_in=false registrant still receives it (AC3). Per-call
// SendOutcome is not inspected/aggregated (same "fire the whole batch"
// contract sendPromotionNotification already establishes). No evaluationTime
// parameter — nothing here compares against the current instant
// (decisions/0006's note in the design §3 applies).
// ---------------------------------------------------------------------------
export async function notifyNonWithdrawnRegistrants(
  db: DbClient["db"],
  sender: NotificationSender,
  eventId: string,
  eventTitle: string,
): Promise<void> {
  const candidates = await selectNonWithdrawnRegistrantsForEvent(db, eventId);
  for (const candidate of candidates) {
    await sendLedgeredNotification({
      db,
      sender,
      registrationId: candidate.registrationId,
      kind: "event_cancelled",
      classification: "transactional",
      userId: candidate.userId,
      composeMessage: (lang) => composeCancellationMessage(db, candidate.registrationId, eventTitle, lang),
    });
  }
}

// ---------------------------------------------------------------------------
// /event_cancel <id> (§5)
// ---------------------------------------------------------------------------
export function makeEventCancelHandler(db: DbClient["db"], sender: NotificationSender) {
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
    // inside cancelEvent itself.
    await cancelEvent(db, authResult.user.id, eventId, event.chapterId, event.title, new Date());

    // docs/agents/design/REQ-027.md §5 — called synchronously right after
    // cancelEvent's transaction has committed, BEFORE the organizer's own
    // confirmation reply below (same ordering makeWithdrawConfirmCallbackHandler
    // already uses for its own post-commit sendPromotionNotification call).
    await notifyNonWithdrawnRegistrants(db, sender, eventId, event.title);

    await ctx.reply(`${getCatalog(lang).event.cancelSuccessPrefix} ${event.title}`);
  };
}

// ---------------------------------------------------------------------------
// /events (REQ-017 §4) — a plain, unauthenticated read, exactly like
// /venues (§0's reuse decision): scoped to the caller's own chapterId, NOT
// gated by requireOrganizerForChapter/checkOrganizerForChapter. Any member
// may run it. Lists published, unfinished events, soonest first, each row
// showing title/date-time/venue/seats — not a full card (§0).
// ---------------------------------------------------------------------------
export function makeEventsListHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);

    // §4.2 step 1/2 — resolveActingUser reused for its chapterId lookup
    // only; no authorization check is applied to its result (§0's scope
    // decision). A user with no chapter yet gets the same empty-state reply
    // as zero rows.
    const actingUser = await resolveActingUser(db, BigInt(tgId));
    const chapterId = actingUser?.chapterId ?? null;
    if (chapterId === null) {
      await ctx.reply(getCatalog(lang).events.followCityInvite);
      return;
    }

    const list = await listUpcomingPublishedEvents(db, chapterId, new Date());
    if (list.length === 0) {
      // §4.3 — an invitation to follow the city, NOT an apology. This is a
      // plain informational reply with no persistence side effect of any
      // kind — Release 3's own "follow this city" entity is out of scope
      // here (requirements.yaml's REQ-017 scope note).
      await ctx.reply(getCatalog(lang).events.followCityInvite);
      return;
    }

    const lines: string[] = [];
    for (const item of list) {
      const admittedCount = await countAdmittedRegistrations(db, item.id);
      const seatsLine = buildSeatsLine(computeSeatsLeft(item.capacity, admittedCount));
      const dateTimeText = `${formatDateTimeInTimezone(
        item.startsAt,
        item.chapterTimezone,
        lang,
      )}–${formatDateTimeInTimezone(item.endsAt, item.chapterTimezone, lang)}`;
      const seatsText =
        seatsLine.kind === "seatsLeft"
          ? `${getCatalog(lang).events.listRowSeatsLeft} ${seatsLine.count}`
          : getCatalog(lang).events.listRowWaitlistOpen;

      lines.push(`${item.title} — ${dateTimeText} — ${item.venueName} — ${seatsText}`);
    }

    await ctx.reply(`${getCatalog(lang).events.listHeader}\n${lines.join("\n")}`);
  };
}
