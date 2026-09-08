import { InlineKeyboard, type Context } from "grammy";
import type { DbClient } from "../db/client.js";
import { requireOrganizerForChapter } from "../domain/eventAuthorization.js";
import { getEventById, isFinished } from "../domain/event.js";
import {
  getInviteCodeById,
  getInviteCodeDetail,
  issueBulkInviteCode,
  issueCompanionInviteCode,
  issuePersonalInviteCode,
  listInviteCodesForEvent,
  parseInviteBulkArgs,
  parseInviteCompanionArgs,
  parseInvitePersonalArgs,
  type InviteCodeDetail,
  type InviteCodeListItem,
  type InviteCodeShape,
  type IssueInviteCodeValidation,
} from "../domain/inviteCode.js";
import { userExistsById, getUserWithChapterByTgId } from "../domain/user.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { resolveLang } from "../i18n/resolveLang.js";

// docs/agents/design/REQ-037.md -- the issuing side of PRD FR-5. Framework-
// free domain logic lives entirely in domain/inviteCode.ts/domain/user.ts
// (decisions/0004) -- this file only sequences calls, checks authorization,
// and sends replies, the same division organizerRequests.ts already
// establishes.

export const INVITE_OPEN_PATTERN = /^invite:open:(.+)$/;

async function resolveLangForTg(db: DbClient["db"], tgId: number): Promise<BotLang> {
  const row = await getUserWithChapterByTgId(db, BigInt(tgId));
  return row === null ? resolveLang(null, null) : resolveLang(row.lang, row.chapterDefaultLang);
}

function matchText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match : "";
}

// design §7's usage-message priority for a validation failure: a structural
// "missing" field (event_id/user_id/max_uses[unparseable]/host_user_id) wins
// over an invalid max_uses value, which wins over an invalid expires_at
// override -- one deterministic message per refusal, never more than one
// reply.
function usageMessageFor(
  kind: "personal" | "bulk" | "companion",
  validation: Extract<IssueInviteCodeValidation, { ok: false }>,
  catalog: ReturnType<typeof getCatalog>,
): string {
  if (kind === "bulk") {
    if (validation.missing.includes("event_id") || validation.missing.includes("max_uses")) {
      if (validation.missing.includes("max_uses") && !validation.missing.includes("event_id")) {
        return catalog.inviteCodes.invalidMaxUses;
      }
      return catalog.inviteCodes.usageNoIdBulk;
    }
    return catalog.inviteCodes.invalidExpiresAt;
  }

  const secondField = kind === "personal" ? "user_id" : "host_user_id";
  if (validation.missing.includes("event_id") || validation.missing.includes(secondField)) {
    return kind === "personal" ? catalog.inviteCodes.usageNoIdPersonal : catalog.inviteCodes.usageNoIdCompanion;
  }
  return catalog.inviteCodes.invalidExpiresAt;
}

function shapeLabel(shape: InviteCodeShape, catalog: ReturnType<typeof getCatalog>): string {
  if (shape === "personal") return catalog.inviteCodes.shapeLabelPersonal;
  if (shape === "companion") return catalog.inviteCodes.shapeLabelCompanion;
  return catalog.inviteCodes.shapeLabelBulk;
}

function buildIssuedReply(catalog: ReturnType<typeof getCatalog>, code: string, botUsername: string): string {
  const link = `https://t.me/${botUsername}?start=i_${code}`;
  return catalog.inviteCodes.issuedReply.replace("{code}", code).replace("{link}", link);
}

// design §2 -- the exact refusal check order shared by all three issuing
// commands: event resolve -> S2 authorization -> cancelled -> finished. Only
// the argument-specific checks (parse, user existence) differ per command.
type EventRefusal = "eventNotFound" | "notAuthorized" | "eventCancelled" | "eventFinished";

interface EventForIssuing {
  id: string;
  chapterId: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
}

async function resolveEventForIssuing(
  db: DbClient["db"],
  tgId: number,
  eventId: string,
  evaluationTime: Date,
): Promise<{ ok: true; event: EventForIssuing; actorUserId: string } | { ok: false; reason: EventRefusal }> {
  const event = await getEventById(db, eventId);
  if (event === null) {
    return { ok: false, reason: "eventNotFound" };
  }

  const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
  if (!authResult.ok) {
    return { ok: false, reason: "notAuthorized" };
  }

  if (event.status === "cancelled") {
    return { ok: false, reason: "eventCancelled" };
  }
  // event.startsAt/endsAt are `Date | null` on EventRecord defensively, but
  // createEvent's own EventCreateInput requires both non-null at creation
  // time (event.ts's EventCreateInput) -- never null in practice for a real
  // row. A null endsAt is grouped with "finished" here, same defensive
  // precedent handlers/start.ts's own deep-link branch already establishes
  // for the identical field; a null startsAt (which would make the §1.4
  // expiry default unable to resolve) is grouped the same way for the same
  // reason -- neither is reachable through any acceptance criterion.
  if (event.startsAt === null || event.endsAt === null || isFinished(event.endsAt, evaluationTime)) {
    return { ok: false, reason: "eventFinished" };
  }

  return {
    ok: true,
    event: { id: event.id, chapterId: event.chapterId, title: event.title, startsAt: event.startsAt, endsAt: event.endsAt },
    actorUserId: authResult.user.id,
  };
}

// design §1.1 -- /invite_personal <event_id> <user_id> [expires_at]
export function makeInvitePersonalHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const validation = parseInvitePersonalArgs(matchText(ctx));
    if (!validation.ok) {
      await ctx.reply(usageMessageFor("personal", validation, catalog));
      return;
    }
    const input = validation.value;
    if (input.kind !== "personal") {
      return;
    }

    const evaluationTime = new Date();
    const resolved = await resolveEventForIssuing(db, tgId, input.eventId, evaluationTime);
    if (!resolved.ok) {
      await ctx.reply(catalog.inviteCodes[resolved.reason]);
      return;
    }

    const targetExists = await userExistsById(db, input.targetUserId);
    if (!targetExists) {
      await ctx.reply(catalog.inviteCodes.userNotFound);
      return;
    }

    const expiresAt = input.expiresAt ?? resolved.event.startsAt;
    const issued = await issuePersonalInviteCode(
      db,
      resolved.actorUserId,
      resolved.event.id,
      input.targetUserId,
      expiresAt,
      evaluationTime,
    );

    await ctx.reply(buildIssuedReply(catalog, issued.code, ctx.me.username));
  };
}

// design §1.2 -- /invite_bulk <event_id> <max_uses> [expires_at]
export function makeInviteBulkHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const validation = parseInviteBulkArgs(matchText(ctx));
    if (!validation.ok) {
      await ctx.reply(usageMessageFor("bulk", validation, catalog));
      return;
    }
    const input = validation.value;
    if (input.kind !== "bulk") {
      return;
    }

    const evaluationTime = new Date();
    const resolved = await resolveEventForIssuing(db, tgId, input.eventId, evaluationTime);
    if (!resolved.ok) {
      await ctx.reply(catalog.inviteCodes[resolved.reason]);
      return;
    }

    const expiresAt = input.expiresAt ?? resolved.event.startsAt;
    const issued = await issueBulkInviteCode(
      db,
      resolved.actorUserId,
      resolved.event.id,
      input.maxUses,
      expiresAt,
      evaluationTime,
    );

    await ctx.reply(buildIssuedReply(catalog, issued.code, ctx.me.username));
  };
}

// design §1.3 -- /invite_companion <event_id> <host_user_id> [expires_at]
export function makeInviteCompanionHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const validation = parseInviteCompanionArgs(matchText(ctx));
    if (!validation.ok) {
      await ctx.reply(usageMessageFor("companion", validation, catalog));
      return;
    }
    const input = validation.value;
    if (input.kind !== "companion") {
      return;
    }

    const evaluationTime = new Date();
    const resolved = await resolveEventForIssuing(db, tgId, input.eventId, evaluationTime);
    if (!resolved.ok) {
      await ctx.reply(catalog.inviteCodes[resolved.reason]);
      return;
    }

    const hostExists = await userExistsById(db, input.hostUserId);
    if (!hostExists) {
      await ctx.reply(catalog.inviteCodes.userNotFound);
      return;
    }

    const expiresAt = input.expiresAt ?? resolved.event.startsAt;
    const issued = await issueCompanionInviteCode(
      db,
      resolved.actorUserId,
      resolved.event.id,
      input.hostUserId,
      expiresAt,
      evaluationTime,
    );

    await ctx.reply(buildIssuedReply(catalog, issued.code, ctx.me.username));
  };
}

// design §4.1 -- /invite_codes <event_id> -- the usage-visibility list view.
function renderInviteCodesListMessage(
  eventTitle: string,
  items: InviteCodeListItem[],
  lang: BotLang,
): { text: string; keyboard: InlineKeyboard } {
  const catalog = getCatalog(lang);
  const lines: string[] = [catalog.inviteCodes.listHeader.replace("{event}", eventTitle).replace("{count}", String(items.length))];
  const keyboard = new InlineKeyboard();

  if (items.length === 0) {
    lines.push(catalog.inviteCodes.listEmpty);
  } else {
    for (const item of items) {
      const label = catalog.inviteCodes.codeRowLabel
        .replace("{code}", item.code)
        .replace("{usedCount}", String(item.usedCount))
        .replace("{maxUses}", String(item.maxUses));
      keyboard.text(label, `invite:open:${item.inviteCodeId}`).row();
    }
  }

  return { text: lines.join("\n"), keyboard };
}

export function makeInviteCodesListHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const eventId = matchText(ctx).trim();
    if (eventId.length === 0) {
      await ctx.reply(catalog.inviteCodes.usageNoIdPersonal);
      return;
    }

    const event = await getEventById(db, eventId);
    if (event === null) {
      await ctx.reply(catalog.inviteCodes.eventNotFound);
      return;
    }

    // design §4.1 -- same authorization as §2/§3, checked here too.
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.reply(catalog.inviteCodes.notAuthorized);
      return;
    }

    const items = await listInviteCodesForEvent(db, event.id);
    const view = renderInviteCodesListMessage(event.title, items, lang);
    await ctx.reply(view.text, { reply_markup: view.keyboard });
  };
}

// design §4.2 -- invite:open:<inviteCodeId> callback -- the redeemer detail
// view.
function renderInviteCodeDetailMessage(detail: InviteCodeDetail, lang: BotLang): string {
  const catalog = getCatalog(lang);
  const lines: string[] = [
    catalog.inviteCodes.detailHeader
      .replace("{code}", detail.code)
      .replace("{usedCount}", String(detail.usedCount))
      .replace("{maxUses}", String(detail.maxUses)),
    shapeLabel(detail.shape, catalog),
  ];

  if (detail.redeemers.length === 0) {
    lines.push(catalog.inviteCodes.detailEmpty);
  } else {
    for (const redeemer of detail.redeemers) {
      const line =
        redeemer.company !== null
          ? catalog.inviteCodes.detailRedeemerLine
              .replace("{displayName}", redeemer.displayName)
              .replace("{company}", redeemer.company)
          : redeemer.displayName;
      lines.push(line);
    }
  }

  return lines.join("\n");
}

export function makeInviteCodeDetailCallbackHandler(db: DbClient["db"]) {
  return async (ctx: Context): Promise<void> => {
    const match = INVITE_OPEN_PATTERN.exec(ctx.callbackQuery?.data ?? "");
    const inviteCodeId = match?.[1];
    if (inviteCodeId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }

    const tgId = ctx.from?.id;
    if (tgId === undefined) {
      await ctx.answerCallbackQuery();
      return;
    }
    const lang = await resolveLangForTg(db, tgId);
    const catalog = getCatalog(lang);

    const codeRow = await getInviteCodeById(db, inviteCodeId);
    if (codeRow === null) {
      await ctx.answerCallbackQuery({ text: catalog.inviteCodes.eventNotFound, show_alert: true });
      return;
    }
    const event = await getEventById(db, codeRow.eventId);
    if (event === null) {
      await ctx.answerCallbackQuery({ text: catalog.inviteCodes.eventNotFound, show_alert: true });
      return;
    }

    // design §4.2 -- S2 re-run on this action too, not only the list entry.
    const authResult = await requireOrganizerForChapter(db, BigInt(tgId), event.chapterId);
    if (!authResult.ok) {
      await ctx.answerCallbackQuery({ text: catalog.inviteCodes.notAuthorized, show_alert: true });
      return;
    }

    const detail = await getInviteCodeDetail(db, inviteCodeId, lang);
    if (detail === null) {
      await ctx.answerCallbackQuery({ text: catalog.inviteCodes.eventNotFound, show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();
    await ctx.reply(renderInviteCodeDetailMessage(detail, lang));
  };
}
