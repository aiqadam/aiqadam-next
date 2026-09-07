import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, profiles, registrations, users } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { getCatalog } from "../i18n/catalog.js";
import {
  makeWalkinCancelCallbackHandler,
  makeWalkinCommandHandler,
  makeWalkinConfirmCallbackHandler,
  makeWalkinOverrideCallbackHandler,
  WALKIN_CONFIRM_PATTERN,
  WALKIN_OVERRIDE_PATTERN,
} from "./walkin.js";

// docs/agents/design/REQ-030.md -- AC1-AC6, real grammY dispatch
// (bot.handleUpdate) against a live scratch Postgres, same infrastructure/
// skip discipline as checkinQr.db.test.ts.

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT qr_token FROM registrations LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[walkin.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
    "TRUNCATE notification_ledger, audit_log, event_staff, registrations, events, venues, profiles, users, chapters CASCADE",
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

// The message editing loop this suite needs (confirm -> override-offer edit,
// or confirm -> success edit) requires editMessageText's fake response to be
// echoed back into subsequent callback_query updates' own message.text, so a
// re-parse of a PRIOR reply's rendered text is exercised exactly like real
// Telegram would deliver it. `messageTextByChatAndId` models that.
function makeTestBot(): { bot: Bot; captured: Captured[]; getLastMessageText: () => string } {
  const captured: Captured[] = [];
  let lastMessageText = "";
  const bot = new Bot("000000:TEST-TOKEN-NOT-REAL", { botInfo: FAKE_BOT_INFO });

  bot.api.config.use(async (_prev, method, payload) => {
    captured.push({ method, payload: payload as Record<string, unknown> });
    if (method === "answerCallbackQuery") {
      return { ok: true, result: true } as never;
    }
    if (method === "editMessageText") {
      lastMessageText = (payload as Record<string, unknown>)["text"] as string;
      return { ok: true, result: true } as never;
    }
    if (method === "sendMessage") {
      lastMessageText = (payload as Record<string, unknown>)["text"] as string;
    }
    return {
      ok: true,
      result: {
        message_id: captured.length,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 0, type: "private" },
      },
    } as never;
  });

  bot.command("walkin", makeWalkinCommandHandler(db));
  bot.callbackQuery(WALKIN_CONFIRM_PATTERN, makeWalkinConfirmCallbackHandler(db));
  bot.callbackQuery(WALKIN_OVERRIDE_PATTERN, makeWalkinOverrideCallbackHandler(db));
  bot.callbackQuery("walkin:cancel", makeWalkinCancelCallbackHandler());

  return { bot, captured, getLastMessageText: () => lastMessageText };
}

let nextUpdateId = 1;
// Distinct range from every other *.test.ts file's own reserved tgId band --
// 942_000_000+ is unclaimed (checkinQr.db.test.ts reserves 941_000_000+).
let nextTgId = 942_000_000;

function commandUpdate(tgId: number, text: string) {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: tgId, type: "private" as const },
      from: { id: tgId, is_bot: false, first_name: "Test" },
      text,
      entities: [{ type: "bot_command", offset: 0, length: text.split(" ")[0]?.length ?? 0 }],
    },
  };
}

// `messageText` is the CONTENT of the bot's own prior reply the tap is
// against -- this is the mechanism REQ-030's design §1.1 depends on: the
// callback_query update Telegram delivers carries the ORIGINAL message's own
// text back verbatim.
function callbackUpdate(tgId: number, data: string, messageText: string) {
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

function textOf(entry: Captured | undefined): string | undefined {
  return entry?.payload["text"] as string | undefined;
}

let chapterSeq = 0;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(schema.chapters)
    .values({
      code: `chapter-req030-${chapterSeq}`,
      name: `Chapter REQ-030 ${chapterSeq}`,
      timezone: "Asia/Tashkent",
      defaultLang: "ru",
      active: true,
    })
    .returning({ id: schema.chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedPublishedEvent(
  chapterId: string,
  organizerId: string,
  opts: { capacity: number; title?: string; endsAt?: Date } = { capacity: 100 },
): Promise<{ eventId: string; title: string }> {
  const title = opts.title ?? "REQ-030 Test Event";
  const eventId = await createEvent(
    db,
    organizerId,
    chapterId,
    {
      title,
      description: "A test event",
      format: "meetup",
      venueId: null,
      startsAt: new Date("2026-09-10T18:00:00Z"),
      endsAt: opts.endsAt ?? new Date("2026-09-10T20:00:00Z"),
      registrationClosesAt: null,
      capacity: opts.capacity,
      requiresInvite: false,
      requiresApproval: false,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizerId, eventId, chapterId, title, new Date());
  return { eventId, title };
}

async function seedOrganizer(chapterId: string): Promise<{ userId: string; tgId: number }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `org${tgId}`, lang: "ru" });
  await db.update(schema.users).set({ role: "organizer", chapterId }).where(eq(schema.users.id, user.id));
  return { userId: user.id, tgId };
}

async function seedEventStaffOnly(chapterId: string): Promise<{ userId: string; tgId: number }> {
  // Plain EventStaff (not organizer, AC6) -- a member-role user with no
  // chapter/organizer privileges of any kind.
  void chapterId;
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `staffonly${tgId}`, lang: "ru" });
  return { userId: user.id, tgId };
}

async function countRows(table: "users" | "profiles" | "registrations"): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS c FROM ${table}`);
  return result.rows[0].c as number;
}

describe("REQ-030 AC1 -- abandoning at the consent step leaves zero new users/profiles/registrations rows", () => {
  it("running /walkin then never tapping Confirm creates nothing", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId);

    const usersBefore = await countRows("users");
    const profilesBefore = await countRows("profiles");
    const registrationsBefore = await countRows("registrations");

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Jamshid Karimov|Acme LLC|+998901234567`) as never,
    );

    const reply = captured.find((c) => c.method === "sendMessage");
    expect(textOf(reply)).toContain("Jamshid Karimov");
    // The Confirm button was offered, but never tapped.
    const replyMarkup = reply?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    const confirmButton = replyMarkup?.inline_keyboard.flat().find((b) => b.callback_data.startsWith("walkin:confirm:"));
    expect(confirmButton).toBeDefined();

    const usersAfter = await countRows("users");
    const profilesAfter = await countRows("profiles");
    const registrationsAfter = await countRows("registrations");

    // The organizer's own /walkin dispatch resolves THEIR OWN user row via
    // the ordinary ctx.from.id flow elsewhere in this codebase, but the
    // organizer already exists (seeded above) -- so byte-identical counts is
    // the correct assertion here: zero NEW rows of any of the three kinds.
    expect(usersAfter).toBe(usersBefore);
    expect(profilesAfter).toBe(profilesBefore);
    expect(registrationsAfter).toBe(registrationsBefore);
  });
});

describe("REQ-030 AC2 -- completing with seats remaining admits + checks in, in one flow", () => {
  it("confirming creates admission='admitted', non-null checked_in_at, check_in_method='manual'", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 10 });

    const { bot, captured, getLastMessageText } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Dana Nazarova|Beta Corp|+998907654321`) as never,
    );
    const confirmReply = captured.find((c) => c.method === "sendMessage");
    const messageText = textOf(confirmReply) ?? "";

    await bot.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, messageText) as never,
    );

    const regRows = await db
      .select()
      .from(registrations)
      .innerJoin(users, eq(users.id, registrations.userId))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .where(eq(profiles.firstName, "Dana Nazarova"));
    expect(regRows).toHaveLength(1);
    const reg = regRows[0]?.registrations;
    expect(reg?.admission).toBe("admitted");
    expect(reg?.checkedInAt).not.toBeNull();
    expect(reg?.checkInMethod).toBe("manual");

    const successText = getLastMessageText();
    expect(successText).toContain("Dana Nazarova");
    expect(successText).toContain("Beta Corp");
  });
});

describe("REQ-030 AC3 -- at-capacity add requires confirmation; confirming writes exactly one audit_log row; dismissing creates no registration", () => {
  it("full capacity offers override; confirming the override admits+checks in with exactly one audit row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 1 });

    // Fill the only seat via a first walk-in.
    const { bot: botForFirstConfirm, captured: capturedFirst } = makeTestBot();
    await botForFirstConfirm.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} First Person|Co A|+998900000001`) as never,
    );
    const firstMessageText = textOf(capturedFirst.find((c) => c.method === "sendMessage")) ?? "";
    await botForFirstConfirm.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, firstMessageText) as never,
    );

    // Now at capacity. Second walk-in.
    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Second Person|Co B|+998900000002`) as never,
    );
    const secondMessageText = textOf(captured.find((c) => c.method === "sendMessage")) ?? "";

    // Confirm tap -> should surface the override offer, NOT admit directly.
    await bot.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, secondMessageText) as never,
    );

    const secondUserRowsBeforeOverride = await db
      .select()
      .from(profiles)
      .where(eq(profiles.firstName, "Second Person"));
    // The user/profile IS created at this point (Open Question 3) but no
    // registration exists yet.
    const secondUserId = secondUserRowsBeforeOverride[0]?.userId;
    expect(secondUserId).toBeDefined();
    const regBeforeOverride = await db
      .select()
      .from(registrations)
      .where(eq(registrations.userId, secondUserId as string));
    expect(regBeforeOverride).toHaveLength(0);

    const editCalls = captured.filter((c) => c.method === "editMessageText");
    const overrideOfferEdit = editCalls[editCalls.length - 1];
    const overrideReplyMarkup = overrideOfferEdit?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    const overrideButton = overrideReplyMarkup?.inline_keyboard
      .flat()
      .find((b) => b.callback_data === `walkin:override:${eventId}`);
    expect(overrideButton).toBeDefined();
    const overrideMessageText = textOf(overrideOfferEdit) ?? "";

    // Tap the override-confirm button.
    await bot.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:override:${eventId}`, overrideMessageText) as never,
    );

    const regAfterOverride = await db
      .select()
      .from(registrations)
      .where(eq(registrations.userId, secondUserId as string));
    expect(regAfterOverride).toHaveLength(1);
    expect(regAfterOverride[0]?.admission).toBe("admitted");
    expect(regAfterOverride[0]?.checkedInAt).not.toBeNull();

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, regAfterOverride[0]?.id as string));
    const overrideAuditRows = auditRows.filter((r) => r.action === "registration.walkin_override_admit");
    expect(overrideAuditRows).toHaveLength(1);
  });

  it("dismissing the override offer creates no registration", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 1 });

    const { bot: botForFirst, captured: capturedFirst } = makeTestBot();
    await botForFirst.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} First Only|Co A|+998900000011`) as never,
    );
    const firstMessageText = textOf(capturedFirst.find((c) => c.method === "sendMessage")) ?? "";
    await botForFirst.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, firstMessageText) as never,
    );

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Dismissed Person|Co C|+998900000022`) as never,
    );
    const secondMessageText = textOf(captured.find((c) => c.method === "sendMessage")) ?? "";
    await bot.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, secondMessageText) as never,
    );
    const editCalls = captured.filter((c) => c.method === "editMessageText");
    const overrideOfferEdit = editCalls[editCalls.length - 1];
    const overrideMessageText = textOf(overrideOfferEdit) ?? "";

    const registrationsBeforeDismiss = await countRows("registrations");

    // Dismiss -- shared walkin:cancel handler, never calls commitWalkin.
    await bot.handleUpdate(callbackUpdate(organizer.tgId, "walkin:cancel", overrideMessageText) as never);

    const registrationsAfterDismiss = await countRows("registrations");
    expect(registrationsAfterDismiss).toBe(registrationsBeforeDismiss);

    const dismissedUserRows = await db.select().from(profiles).where(eq(profiles.firstName, "Dismissed Person"));
    const dismissedUserId = dismissedUserRows[0]?.userId;
    const regForDismissed = await db
      .select()
      .from(registrations)
      .where(eq(registrations.userId, dismissedUserId as string));
    expect(regForDismissed).toHaveLength(0);
  });
});

describe("REQ-030 AC4 -- adding an existing person (phone match) reuses existing users/profiles rows, no duplicates", () => {
  it("a second walk-in with the same phone (differently formatted) resolves to the same user, no new user/profile row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId: eventId1 } = await seedPublishedEvent(chapterId, organizer.userId, {
      capacity: 10,
      title: "Event One",
    });
    const { eventId: eventId2 } = await seedPublishedEvent(chapterId, organizer.userId, {
      capacity: 10,
      title: "Event Two",
    });

    const { bot: bot1, captured: captured1 } = makeTestBot();
    await bot1.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId1} Existing Person|Co X|+998 90 111-22-33`) as never,
    );
    const messageText1 = textOf(captured1.find((c) => c.method === "sendMessage")) ?? "";
    await bot1.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId1}`, messageText1) as never,
    );

    const usersAfterFirst = await countRows("users");
    const profilesAfterFirst = await countRows("profiles");

    // Same physical number, differently formatted -- digit-strip normalizes
    // both to the same string.
    const { bot: bot2, captured: captured2 } = makeTestBot();
    await bot2.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId2} Door Typo Name|Co Y|+998901112233`) as never,
    );
    const messageText2 = textOf(captured2.find((c) => c.method === "sendMessage")) ?? "";
    await bot2.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId2}`, messageText2) as never,
    );

    const usersAfterSecond = await countRows("users");
    const profilesAfterSecond = await countRows("profiles");

    expect(usersAfterSecond).toBe(usersAfterFirst);
    expect(profilesAfterSecond).toBe(profilesAfterFirst);

    // The existing profile's name/company are left untouched (Open Question 2).
    const profileRows = await db.select().from(profiles).where(eq(profiles.firstName, "Existing Person"));
    expect(profileRows).toHaveLength(1);
    expect(profileRows[0]?.company).toBe("Co X");

    // Two registrations exist (one per event), both for the SAME user.
    const userId = profileRows[0]?.userId as string;
    const regRows = await db.select().from(registrations).where(eq(registrations.userId, userId));
    expect(regRows).toHaveLength(2);
  });
});

describe("REQ-030 AC5 -- phone appears in no log line, no audit_log payload", () => {
  it("the audit_log payload for a successful walk-in admit contains no phone value", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 10 });
    const phone = "+998912345678";

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Phone Test Person|Co Z|${phone}`) as never,
    );
    const messageText = textOf(captured.find((c) => c.method === "sendMessage")) ?? "";
    await bot.handleUpdate(callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, messageText) as never);

    const profileRows = await db.select().from(profiles).where(eq(profiles.firstName, "Phone Test Person"));
    const userId = profileRows[0]?.userId as string;
    const regRows = await db.select().from(registrations).where(eq(registrations.userId, userId));
    const registrationId = regRows[0]?.id as string;

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, registrationId));
    expect(auditRows.length).toBeGreaterThan(0);
    for (const row of auditRows) {
      const payloadJson = JSON.stringify(row.payload);
      expect(payloadJson).not.toContain(phone);
      expect(Object.keys(row.payload as Record<string, unknown>)).not.toContain("phone");
    }
  });
});

describe("REQ-030 AC6 -- a plain EventStaff member (not organizer) invoking /walkin is refused", () => {
  it("a non-organizer is refused, no confirm message sent, no rows written", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId);
    const staffOnly = await seedEventStaffOnly(chapterId);

    const usersBefore = await countRows("users");
    const profilesBefore = await countRows("profiles");
    const registrationsBefore = await countRows("registrations");

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(staffOnly.tgId, `/walkin ${eventId} Refused Person|Co R|+998900009999`) as never,
    );

    const catalog = getCatalog("ru");
    const reply = captured.find((c) => c.method === "sendMessage");
    expect(textOf(reply)).toBe(catalog.walkin.notAuthorized);

    expect(await countRows("users")).toBe(usersBefore);
    expect(await countRows("profiles")).toBe(profilesBefore);
    expect(await countRows("registrations")).toBe(registrationsBefore);
  });
});
