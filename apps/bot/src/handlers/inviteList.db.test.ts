import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, inviteCodes, inviteListEntries, registrations, users } from "../db/schema.js";
import { cancelEvent, createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { addEventStaff } from "../domain/eventStaff.js";
import { recordConsent } from "../domain/consent.js";
import { addInviteListEntry, issueInviteListEntryCode } from "../domain/inviteList.js";
import type { NotificationSender } from "../domain/notification.js";
import { makeConsentCallbackHandler, makeStartHandler } from "./start.js";
import {
  INVITE_LIST_ISSUE_PATTERN,
  INVITE_LIST_REMOVE_CONFIRM_PATTERN,
  INVITE_LIST_REMOVE_PATTERN,
  makeInviteListAddHandler,
  makeInviteListHandler,
  makeInviteListIssueCallbackHandler,
  makeInviteListRemoveCallbackHandler,
  makeInviteListRemoveCancelCallbackHandler,
  makeInviteListRemoveConfirmCallbackHandler,
} from "./inviteList.js";
import { getCatalog } from "../i18n/catalog.js";

// docs/agents/design/REQ-040.md -- handler-layer coverage: the S2
// authorization negative cases, the full add/list/issue/remove flows, the
// cancelled/finished-event refusal fix (commit c2a109c), and the end-to-end
// account-linking flow (AC6/AC7) through the real /start dispatch. Real
// grammY dispatch (bot.handleUpdate) against a live scratch Postgres, same
// infrastructure/skip discipline as handlers/inviteCodes.db.test.ts (REQ-037)
// / handlers/companion.db.test.ts (REQ-039).

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT opened_at FROM invite_list_entries LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[inviteList.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
    );
  }
}, 15000);

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  if (!dbAvailable) {
    return;
  }
  await pool.query(
    "TRUNCATE notification_ledger, audit_log, invite_list_entries, event_staff, invite_codes, registrations, events, venues, profiles, users, chapters CASCADE",
  );
});

interface Captured {
  method: string;
  payload: Record<string, unknown>;
}

const FAKE_BOT_INFO = {
  id: 1,
  is_bot: true as const,
  first_name: "TestBot",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
  can_manage_bots: false,
  supports_join_request_queries: false,
};

function makeFakeSender(): { sender: NotificationSender; sent: { tgId: bigint; text: string }[] } {
  const sent: { tgId: bigint; text: string }[] = [];
  return {
    sender: {
      async send(tgId, text) {
        sent.push({ tgId, text });
      },
      async sendPhoto(tgId, _photo, caption) {
        sent.push({ tgId, text: caption });
      },
    },
    sent,
  };
}

function makeTestBot(sender: NotificationSender): { bot: Bot; captured: Captured[] } {
  const captured: Captured[] = [];
  const bot = new Bot("000000:TEST-TOKEN-NOT-REAL", { botInfo: FAKE_BOT_INFO });

  bot.api.config.use(async (_prev, method, payload) => {
    captured.push({ method, payload: payload as Record<string, unknown> });
    if (method === "answerCallbackQuery") {
      return { ok: true, result: true } as never;
    }
    return {
      ok: true,
      result: { message_id: captured.length, date: Math.floor(Date.now() / 1000), chat: { id: 0, type: "private" } },
    } as never;
  });

  bot.command("start", makeStartHandler(db, sender));
  bot.callbackQuery(/^consent:agree(?::.+)?$/, makeConsentCallbackHandler(db, sender));
  bot.command("invite_list_add", makeInviteListAddHandler(db));
  bot.command("invite_list", makeInviteListHandler(db));
  bot.callbackQuery(INVITE_LIST_ISSUE_PATTERN, makeInviteListIssueCallbackHandler(db));
  bot.callbackQuery(INVITE_LIST_REMOVE_CONFIRM_PATTERN, makeInviteListRemoveConfirmCallbackHandler(db));
  bot.callbackQuery(INVITE_LIST_REMOVE_PATTERN, makeInviteListRemoveCallbackHandler(db));
  bot.callbackQuery("invite_list:remove_cancel", makeInviteListRemoveCancelCallbackHandler(db));

  return { bot, captured };
}

let nextUpdateId = 1;
let nextTgId = 1_064_000_000;

function commandUpdate(tgId: number, text: string) {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: tgId, type: "private" as const },
      from: { id: tgId, is_bot: false, first_name: "Test" },
      text,
      entities: [{ type: "bot_command" as const, offset: 0, length: text.split(" ")[0]?.length ?? 0 }],
    },
  };
}

function callbackUpdate(tgId: number, data: string, messageText = "") {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cbq_${nextUpdateId}`,
      from: { id: tgId, is_bot: false, first_name: "Test" },
      chat_instance: "test-chat-instance",
      data,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: tgId, type: "private" as const },
        text: messageText,
      },
    },
  };
}

function consentAgreeCallbackUpdate(tgId: number, payloadText: string | null) {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cbq_${nextUpdateId}`,
      from: { id: tgId, is_bot: false, first_name: "Test" },
      chat_instance: "test-chat-instance",
      data: payloadText === null ? "consent:agree" : `consent:agree:${payloadText}`,
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: tgId, type: "private" as const },
      },
    },
  };
}

function textOf(entry: Captured | undefined): string {
  return (entry?.payload["text"] as string | undefined) ?? "";
}

function lastReplyText(captured: Captured[]): string | undefined {
  const entry = [...captured].reverse().find((c) => c.method === "sendMessage" || c.method === "answerCallbackQuery");
  if (entry?.method === "answerCallbackQuery") {
    return entry.payload["text"] as string | undefined;
  }
  return textOf(entry);
}

function lastSendMessage(captured: Captured[]): Captured | undefined {
  return [...captured].reverse().find((c) => c.method === "sendMessage");
}

const catalog = getCatalog("en");

let chapterSeq = 0;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(schema.chapters)
    .values({
      code: `req040h-chapter-${chapterSeq}`,
      name: `REQ-040 Handler Chapter ${chapterSeq}`,
      timezone: "Asia/Tashkent",
      defaultLang: "en",
      active: true,
    })
    .returning({ id: schema.chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedVenue(chapterId: string): Promise<string> {
  const rows = await db
    .insert(schema.venues)
    .values({ chapterId, name: "REQ-040 Handler Venue", address: "1 Test St", capacity: 500 })
    .returning({ id: schema.venues.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedVenue: no row returned");
  return row.id;
}

async function seedUser(
  tgId: number,
  opts: { role?: "member" | "organizer" | "owner"; chapterId?: string | null } = {},
) {
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `u${tgId}`, lang: "en" });
  if (opts.role !== undefined || opts.chapterId !== undefined) {
    await db
      .update(users)
      .set({
        ...(opts.role !== undefined ? { role: opts.role } : {}),
        ...(opts.chapterId !== undefined ? { chapterId: opts.chapterId } : {}),
      })
      .where(eq(users.id, user.id));
  }
  return user;
}

async function seedEvent(
  chapterId: string,
  opts: { startsAt?: Date; endsAt?: Date } = {},
): Promise<{ id: string; title: string; chapterId: string; organizerId: string }> {
  const venueId = await seedVenue(chapterId);
  const organizerTgId = nextTgId++;
  const organizer = await seedUser(organizerTgId, { role: "organizer", chapterId });
  const title = `REQ-040 Handler Event ${Date.now()}-${Math.random()}`;
  const startsAt = opts.startsAt ?? new Date("2026-11-01T18:00:00Z");
  const endsAt = opts.endsAt ?? new Date("2026-11-01T20:00:00Z");
  const eventId = await createEvent(
    db,
    organizer.id,
    chapterId,
    {
      title,
      description: "A test event",
      format: "meetup",
      venueId,
      startsAt,
      endsAt,
      registrationClosesAt: null,
      capacity: 500,
      requiresInvite: false,
      requiresApproval: false,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, title, new Date());
  return { id: eventId, title, chapterId, organizerId: organizer.id };
}

async function countInviteListEntries(eventId: string): Promise<number> {
  const rows = await db.select({ id: inviteListEntries.id }).from(inviteListEntries).where(eq(inviteListEntries.eventId, eventId));
  return rows.length;
}

async function countUsers(): Promise<number> {
  const rows = await db.select({ id: users.id }).from(users);
  return rows.length;
}

async function userByTgId(tgId: number) {
  const rows = await db.select().from(users).where(eq(users.tgId, BigInt(tgId)));
  return rows[0] ?? null;
}

async function entryFor(eventId: string, userId: string) {
  const rows = await db
    .select()
    .from(inviteListEntries)
    .where(and(eq(inviteListEntries.eventId, eventId), eq(inviteListEntries.userId, userId)));
  return rows[0] ?? null;
}

async function registrationFor(eventId: string, userId: string) {
  const rows = await db
    .select()
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)));
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// S2 -- authorization negative cases, restated per REQ-037/organizerRequests'
// own established shape: a plain member, an EventStaff member (role stays
// "member" -- event_staff is a separate grant table, not a role), and an
// organizer of a DIFFERENT chapter are all refused on every entry point.
// ---------------------------------------------------------------------------
describe("S2 -- authorization negative cases on every invite-list entry point", () => {
  it("/invite_list_add: a plain member is refused, zero entries/users created", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    const memberTgId = nextTgId++;
    await seedUser(memberTgId, { role: "member", chapterId });
    const usersBefore = await countUsers();

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    await bot.handleUpdate(commandUpdate(memberTgId, `/invite_list_add ${event.id} A Member Attempt | | `) as never);

    expect(lastReplyText(captured)).toBe(catalog.inviteList.notAuthorized);
    expect(await countInviteListEntries(event.id)).toBe(0);
    expect(await countUsers()).toBe(usersBefore); // no guest user was created either
  });

  it("/invite_list_add: an EventStaff member for this event is refused (role stays 'member')", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    const staffTgId = nextTgId++;
    const staffUser = await seedUser(staffTgId, { role: "member", chapterId });
    await addEventStaff(db, event.organizerId, event.id, staffUser.id, event.title, new Date());

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    await bot.handleUpdate(commandUpdate(staffTgId, `/invite_list_add ${event.id} Staff Attempt | | `) as never);

    expect(lastReplyText(captured)).toBe(catalog.inviteList.notAuthorized);
    expect(await countInviteListEntries(event.id)).toBe(0);
  });

  it("/invite_list_add: an organizer of chapter A is refused for a chapter B event", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterA = await seedChapter();
    const chapterB = await seedChapter();
    const event = await seedEvent(chapterB);
    const orgATgId = nextTgId++;
    await seedUser(orgATgId, { role: "organizer", chapterId: chapterA });

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    await bot.handleUpdate(commandUpdate(orgATgId, `/invite_list_add ${event.id} Cross Chapter | | `) as never);

    expect(lastReplyText(captured)).toBe(catalog.inviteList.notAuthorized);
    expect(await countInviteListEntries(event.id)).toBe(0);
  });

  it("/invite_list (list view): a plain member is refused", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    await addInviteListEntry(db, event.organizerId, event.id, "Existing Guest", "", "", new Date());
    const memberTgId = nextTgId++;
    await seedUser(memberTgId, { role: "member", chapterId });

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    await bot.handleUpdate(commandUpdate(memberTgId, `/invite_list ${event.id}`) as never);

    expect(lastReplyText(captured)).toBe(catalog.inviteList.notAuthorized);
  });

  it("invite_list:issue callback: a plain member is refused, no invite_codes row created", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    const entry = await addInviteListEntry(db, event.organizerId, event.id, "Issue Target", "", "", new Date());
    const memberTgId = nextTgId++;
    await seedUser(memberTgId, { role: "member", chapterId });

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    await bot.handleUpdate(callbackUpdate(memberTgId, `invite_list:issue:${entry.entryId}`) as never);

    const answerEntry = captured.find((c) => c.method === "answerCallbackQuery");
    expect(answerEntry?.payload["text"]).toBe(catalog.inviteList.notAuthorized);
    const codeRows = await db.select({ id: inviteCodes.id }).from(inviteCodes).where(eq(inviteCodes.eventId, event.id));
    expect(codeRows).toHaveLength(0);
  });

  it("invite_list:remove and invite_list:remove:confirm callbacks: a plain member is refused, entry survives", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    const entry = await addInviteListEntry(db, event.organizerId, event.id, "Remove Target", "", "", new Date());
    const memberTgId = nextTgId++;
    await seedUser(memberTgId, { role: "member", chapterId });

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    await bot.handleUpdate(callbackUpdate(memberTgId, `invite_list:remove:${entry.entryId}`) as never);
    let answerEntry = captured.find((c) => c.method === "answerCallbackQuery");
    expect(answerEntry?.payload["text"]).toBe(catalog.inviteList.notAuthorized);

    captured.length = 0;
    await bot.handleUpdate(callbackUpdate(memberTgId, `invite_list:remove:confirm:${entry.entryId}`) as never);
    answerEntry = captured.find((c) => c.method === "answerCallbackQuery");
    expect(answerEntry?.payload["text"]).toBe(catalog.inviteList.notAuthorized);

    const stillThere = await entryFor(event.id, entry.userId);
    expect(stillThere).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Happy path -- add, list, issue, remove, run end to end by an organizer.
// ---------------------------------------------------------------------------
describe("Happy path -- organizer adds, lists, issues a code, and removes an entry", () => {
  it("full add -> list -> issue -> list (issue button gone) -> remove -> list (entry gone) flow", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    const orgTgId = nextTgId++;
    await seedUser(orgTgId, { role: "organizer", chapterId });

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);

    await bot.handleUpdate(commandUpdate(orgTgId, `/invite_list_add ${event.id} Uzcard Contact | Uzcard | CFO`) as never);
    const addReply = textOf(lastSendMessage(captured));
    expect(addReply).toContain("Uzcard Contact");

    const entriesForEvent = await db.select().from(inviteListEntries).where(eq(inviteListEntries.eventId, event.id));
    expect(entriesForEvent).toHaveLength(1);
    const entryId = entriesForEvent[0]!.id;
    const guestUserId = entriesForEvent[0]!.userId;

    captured.length = 0;
    await bot.handleUpdate(commandUpdate(orgTgId, `/invite_list ${event.id}`) as never);
    const listReply = lastSendMessage(captured);
    expect(textOf(listReply)).toContain("Uzcard Contact");
    expect(textOf(listReply)).toContain(catalog.inviteList.statusInvited);
    const keyboardBeforeIssue = listReply?.payload["reply_markup"] as { inline_keyboard: { text: string }[][] } | undefined;
    const buttonLabelsBefore = keyboardBeforeIssue?.inline_keyboard.flat().map((b) => b.text) ?? [];
    expect(buttonLabelsBefore).toContain(catalog.inviteList.issueButtonLabel);

    captured.length = 0;
    await bot.handleUpdate(callbackUpdate(orgTgId, `invite_list:issue:${entryId}`) as never);
    const issueReply = textOf(lastSendMessage(captured));
    expect(issueReply).toContain("Code issued:");
    const entryAfterIssue = await entryFor(event.id, guestUserId);
    expect(entryAfterIssue?.inviteCodeId).not.toBeNull();

    captured.length = 0;
    await bot.handleUpdate(commandUpdate(orgTgId, `/invite_list ${event.id}`) as never);
    const listReplyAfterIssue = lastSendMessage(captured);
    const keyboardAfterIssue = listReplyAfterIssue?.payload["reply_markup"] as { inline_keyboard: { text: string }[][] } | undefined;
    const buttonLabelsAfter = keyboardAfterIssue?.inline_keyboard.flat().map((b) => b.text) ?? [];
    expect(buttonLabelsAfter).not.toContain(catalog.inviteList.issueButtonLabel); // Issue button gone once a code exists
    expect(buttonLabelsAfter).toContain(catalog.inviteList.removeButtonLabel);

    captured.length = 0;
    await bot.handleUpdate(callbackUpdate(orgTgId, `invite_list:remove:${entryId}`) as never);
    const confirmPrompt = textOf(lastSendMessage(captured));
    expect(confirmPrompt).toBe(catalog.inviteList.removeConfirmPrompt);

    const auditBeforeRemove = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "invite_list.remove"));

    captured.length = 0;
    await bot.handleUpdate(callbackUpdate(orgTgId, `invite_list:remove:confirm:${entryId}`) as never);
    expect(textOf(lastSendMessage(captured))).toBe(catalog.inviteList.removedReply);

    const auditAfterRemove = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "invite_list.remove"));
    expect(auditAfterRemove.length).toBe(auditBeforeRemove.length + 1);

    expect(await entryFor(event.id, guestUserId)).toBeNull();
    // The underlying users row (and its now-spent invite code) survives removal.
    const guestRow = await db.select().from(users).where(eq(users.id, guestUserId));
    expect(guestRow).toHaveLength(1);
  });

  it("remove:cancel leaves the entry untouched and writes no audit row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    const orgTgId = nextTgId++;
    await seedUser(orgTgId, { role: "organizer", chapterId });
    const entry = await addInviteListEntry(db, event.organizerId, event.id, "Keep Me", "", "", new Date());

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    await bot.handleUpdate(callbackUpdate(orgTgId, `invite_list:remove:${entry.entryId}`) as never);

    const auditBefore = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "invite_list.remove"));
    captured.length = 0;
    await bot.handleUpdate(callbackUpdate(orgTgId, "invite_list:remove_cancel") as never);
    expect(textOf(lastSendMessage(captured))).toBe(catalog.inviteList.removeCancelledNote);

    const auditAfter = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.action, "invite_list.remove"));
    expect(auditAfter.length).toBe(auditBefore.length);
    expect(await entryFor(event.id, entry.userId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The cancelled/finished-event refusal fix (commit c2a109c) -- the issue
// callback must refuse for a cancelled or finished event exactly like every
// other issuing surface in inviteCodes.ts.
// ---------------------------------------------------------------------------
describe("invite_list:issue refuses for cancelled/finished events (commit c2a109c)", () => {
  it("a cancelled event: refused, entry's invite_code_id stays null, no invite_codes row created", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    const entry = await addInviteListEntry(db, event.organizerId, event.id, "Cancelled Event Guest", "", "", new Date());
    await cancelEvent(db, event.organizerId, event.id, chapterId, event.title, new Date());
    const orgTgId = nextTgId++;
    await seedUser(orgTgId, { role: "organizer", chapterId });

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    await bot.handleUpdate(callbackUpdate(orgTgId, `invite_list:issue:${entry.entryId}`) as never);

    const answerEntry = captured.find((c) => c.method === "answerCallbackQuery");
    expect(answerEntry?.payload["text"]).toBe(catalog.inviteCodes.eventCancelled);

    const entryAfter = await entryFor(event.id, entry.userId);
    expect(entryAfter?.inviteCodeId).toBeNull();
    const codeRows = await db.select({ id: inviteCodes.id }).from(inviteCodes).where(eq(inviteCodes.eventId, event.id));
    expect(codeRows).toHaveLength(0);
  });

  it("an event whose ends_at has passed: refused, entry's invite_code_id stays null, no invite_codes row created", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId, {
      startsAt: new Date("2020-01-01T18:00:00Z"),
      endsAt: new Date("2020-01-01T20:00:00Z"),
    });
    const entry = await addInviteListEntry(db, event.organizerId, event.id, "Finished Event Guest", "", "", new Date());
    const orgTgId = nextTgId++;
    await seedUser(orgTgId, { role: "organizer", chapterId });

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    await bot.handleUpdate(callbackUpdate(orgTgId, `invite_list:issue:${entry.entryId}`) as never);

    const answerEntry = captured.find((c) => c.method === "answerCallbackQuery");
    expect(answerEntry?.payload["text"]).toBe(catalog.inviteCodes.eventFinished);

    const entryAfter = await entryFor(event.id, entry.userId);
    expect(entryAfter?.inviteCodeId).toBeNull();
    const codeRows = await db.select({ id: inviteCodes.id }).from(inviteCodes).where(eq(inviteCodes.eventId, event.id));
    expect(codeRows).toHaveLength(0);
  });

  it("an OPEN, active, published event: issuing still succeeds (baseline -- confirms the fix only rejects cancelled/finished, nothing else)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    const entry = await addInviteListEntry(db, event.organizerId, event.id, "Active Event Guest", "", "", new Date());
    const orgTgId = nextTgId++;
    await seedUser(orgTgId, { role: "organizer", chapterId });

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    await bot.handleUpdate(callbackUpdate(orgTgId, `invite_list:issue:${entry.entryId}`) as never);

    expect(textOf(lastSendMessage(captured))).toContain("Code issued:");
    const entryAfter = await entryFor(event.id, entry.userId);
    expect(entryAfter?.inviteCodeId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC8/S3 restated at the handler level: the rendered /invite_list output
// never contains a phone number or email, even once a guest has registered
// (their real profiles row now has both).
// ---------------------------------------------------------------------------
describe("S3 -- /invite_list output never contains phone or email, even post-registration", () => {
  it("a registered guest's phone/email (on their profiles row) never appear in the list message text", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    const orgTgId = nextTgId++;
    await seedUser(orgTgId, { role: "organizer", chapterId });
    const entry = await addInviteListEntry(db, event.organizerId, event.id, "Rich Profile Guest", "", "", new Date());
    const phone = "+998907771122";
    const email = "richguest@example.com";
    await db.insert(schema.profiles).values({
      userId: entry.userId,
      firstName: "Rich Profile Guest",
      company: "Rich Co",
      phone,
      email,
    });

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    await bot.handleUpdate(commandUpdate(orgTgId, `/invite_list ${event.id}`) as never);

    const listText = textOf(lastSendMessage(captured));
    expect(listText).toContain("Rich Profile Guest");
    expect(listText).not.toContain(phone);
    expect(listText).not.toContain(email);
  });
});

// ---------------------------------------------------------------------------
// End-to-end account linking through the real /start dispatch (AC6): a
// brand-new Telegram contact taps the personal-invite deep link, consents,
// and the PRE-CREATED row is linked (not a second row created).
// ---------------------------------------------------------------------------
describe("End-to-end AC6 -- /start i_<code> from a brand-new contact links the pre-created row", () => {
  it("full /start -> consent -> resolution flow: the pre-created guest's row id is unchanged, its tg_id becomes the caller's, and no second users row is created", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    const entry = await addInviteListEntry(db, event.organizerId, event.id, "E2E VIP Guest", "SAP", "", new Date());
    const issued = await issueInviteListEntryCode(
      db,
      event.organizerId,
      event.id,
      entry.entryId,
      entry.userId,
      new Date("2027-01-01T00:00:00Z"),
      new Date(),
    );

    const usersBefore = await countUsers();
    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    const guestTgId = nextTgId++;

    await bot.handleUpdate(commandUpdate(guestTgId, `/start i_${issued.code}`) as never);
    // A brand-new contact has never consented -- the consent prompt is shown
    // and carries the invite payload through to the callback.
    expect(captured.some((c) => c.method === "sendMessage")).toBe(true);

    await bot.handleUpdate(consentAgreeCallbackUpdate(guestTgId, `i_${issued.code}`) as never);

    // The pre-created row (entry.userId) is the one now resolvable by the
    // caller's own tg_id -- id unchanged, tg_id set.
    const linkedRow = await userByTgId(guestTgId);
    expect(linkedRow?.id).toBe(entry.userId);
    expect(await countUsers()).toBe(usersBefore); // no second users row

    // opened_at was written on the entry (the deep-link open, before the
    // registration write that follows immediately in the same flow).
    const entryAfter = await entryFor(event.id, entry.userId);
    expect(entryAfter?.openedAt).not.toBeNull();

    // Redemption completed under the SAME (linked) user id -- registered.
    const registration = await registrationFor(event.id, entry.userId);
    expect(registration).not.toBeNull();
    expect(registration?.admission).toBe("admitted");
  });
});

// ---------------------------------------------------------------------------
// End-to-end collision resolution through the real /start dispatch (AC7): a
// redeemer who ALREADY has their own account (already consented, from an
// earlier session) redeems the code meant for the pre-created placeholder.
// ---------------------------------------------------------------------------
describe("End-to-end AC7 -- /start i_<code> from a redeemer with their own existing account relinks, never duplicates", () => {
  it("an already-consented, existing user redeeming the placeholder's code ends with exactly one reachable identity (B), A left inert", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedEvent(chapterId);
    const entry = await addInviteListEntry(db, event.organizerId, event.id, "E2E Collision Guest", "", "", new Date());
    const issued = await issueInviteListEntryCode(
      db,
      event.organizerId,
      event.id,
      entry.entryId,
      entry.userId,
      new Date("2027-01-01T00:00:00Z"),
      new Date(),
    );

    // B: a real, existing, already-consented member -- exactly the
    // "attended a past event under their own account" population §2.4
    // names.
    const bTgId = nextTgId++;
    const bUser = await resolveOrCreateUser(db, { tgId: BigInt(bTgId), tgUsername: `b${bTgId}`, lang: "en" });
    await recordConsent(db, bUser.id, new Date());

    const usersBefore = await countUsers();
    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);

    await bot.handleUpdate(commandUpdate(bTgId, `/start i_${issued.code}`) as never);

    // B already consented -- no consent prompt, straight to resolution/
    // registration in the same /start call.
    expect(await countUsers()).toBe(usersBefore); // no new users row

    const registration = await registrationFor(event.id, bUser.id);
    expect(registration).not.toBeNull();
    expect(registration?.admission).toBe("admitted");

    // A is left inert: still present, tg_id still NULL, no live entry left
    // pointing at it.
    const aRow = await db.select().from(users).where(eq(users.id, entry.userId));
    expect(aRow).toHaveLength(1);
    expect(aRow[0]?.tgId).toBeNull();
    const aEntry = await entryFor(event.id, entry.userId);
    expect(aEntry).toBeNull();

    // B now holds the (repointed) entry.
    const bEntry = await entryFor(event.id, bUser.id);
    expect(bEntry).not.toBeNull();

    // The invite code itself was repointed to B.
    const codeRow = await db.select().from(inviteCodes).where(eq(inviteCodes.id, issued.id));
    expect(codeRow[0]?.issuedToUserId).toBe(bUser.id);

    void captured;
  });
});
