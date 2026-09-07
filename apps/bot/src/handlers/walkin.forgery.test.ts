import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, profiles, registrations } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { addEventStaff } from "../domain/eventStaff.js";
import { getCatalog } from "../i18n/catalog.js";
import {
  makeWalkinCancelCallbackHandler,
  makeWalkinCommandHandler,
  makeWalkinConfirmCallbackHandler,
  makeWalkinOverrideCallbackHandler,
  WALKIN_CONFIRM_PATTERN,
  WALKIN_OVERRIDE_PATTERN,
} from "./walkin.js";

// docs/agents/test-specs/REQ-030.md -- AC1/AC3/AC4/AC5/AC6 independent
// re-derivations, cross-context forgery, and malformed-message-text cases.
// Own tg_id range (943_000_000+), own fixtures throughout -- see spec for
// why this file's cases are independent of walkin.db.test.ts's own.

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
      `[walkin.forgery.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
// Own range, distinct from every other *.test.ts file's own reserved band --
// see docs/agents/test-specs/REQ-030.md's tg_id range section: 943_000_000+
// is unclaimed (walkin.db.test.ts/checkinQr.forgery.test.ts both reserve
// 942_000_000+; not this file's collision to fix, see ISS-0026).
let nextTgId = 943_000_000;

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
      code: `chapter-req030-fg-${chapterSeq}`,
      name: `Chapter REQ-030 Forgery ${chapterSeq}`,
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
  const title = opts.title ?? "REQ-030 Forgery Test Event";
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

async function seedEventStaffForEvent(
  chapterId: string,
  eventId: string,
  eventTitle: string,
  organizerUserId: string,
): Promise<{ userId: string; tgId: number }> {
  // Genuine EventStaff row for THIS EXACT event (AC6) -- distinct from
  // walkin.db.test.ts's "plain member, no staff role anywhere" fixture.
  void chapterId;
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `evstaff${tgId}`, lang: "ru" });
  await addEventStaff(db, organizerUserId, eventId, user.id, eventTitle, new Date());
  return { userId: user.id, tgId };
}

async function countRows(table: "users" | "profiles" | "registrations"): Promise<number> {
  const result = await pool.query(`SELECT count(*)::int AS c FROM ${table}`);
  return result.rows[0].c as number;
}

describe("REQ-030 forgery AC1 -- abandoning at consent leaves organizer's own profile byte-identical", () => {
  it("running /walkin then never tapping Confirm creates nothing and leaves the organizer's own profile untouched", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 20 });

    const organizerProfileBefore = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, organizer.userId));

    const usersBefore = await countRows("users");
    const profilesBefore = await countRows("profiles");
    const registrationsBefore = await countRows("registrations");

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(
        organizer.tgId,
        `/walkin ${eventId} Yerlan Toktarov|Silk Road Ventures|+996555112233`,
      ) as never,
    );

    const reply = captured.find((c) => c.method === "sendMessage");
    expect(textOf(reply)).toContain("Yerlan Toktarov");
    expect(textOf(reply)).toContain("Silk Road Ventures");
    expect(textOf(reply)).toContain("+996555112233");
    const replyMarkup = reply?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    const confirmButton = replyMarkup?.inline_keyboard
      .flat()
      .find((b) => b.callback_data.startsWith("walkin:confirm:"));
    expect(confirmButton).toBeDefined();

    expect(await countRows("users")).toBe(usersBefore);
    expect(await countRows("profiles")).toBe(profilesBefore);
    expect(await countRows("registrations")).toBe(registrationsBefore);

    const organizerProfileAfter = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, organizer.userId));
    expect(organizerProfileAfter).toEqual(organizerProfileBefore);
  });
});

describe("REQ-030 forgery AC3 -- override-confirm audit correctness; dismiss leaves zero audit_log rows", () => {
  it("override-confirm writes exactly one audit row with previousAdmission null", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 1 });

    const { bot: botFirst, captured: capturedFirst } = makeTestBot();
    await botFirst.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Bota Suleimenova|Nomad Labs|+77011112222`) as never,
    );
    const firstText = textOf(capturedFirst.find((c) => c.method === "sendMessage")) ?? "";
    await botFirst.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, firstText) as never,
    );

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Ruslan Abenov|Steppe Analytics|+77022223333`) as never,
    );
    const secondText = textOf(captured.find((c) => c.method === "sendMessage")) ?? "";
    await bot.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, secondText) as never,
    );

    const editCalls = captured.filter((c) => c.method === "editMessageText");
    const overrideOfferEdit = editCalls[editCalls.length - 1];
    const overrideOfferText = textOf(overrideOfferEdit) ?? "";
    expect(overrideOfferText).toContain("1");
    const overrideReplyMarkup = overrideOfferEdit?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    const overrideButtons = overrideReplyMarkup?.inline_keyboard
      .flat()
      .filter((b) => b.callback_data === `walkin:override:${eventId}`);
    expect(overrideButtons).toHaveLength(1);

    const ruslanProfileRows = await db.select().from(profiles).where(eq(profiles.firstName, "Ruslan Abenov"));
    expect(ruslanProfileRows).toHaveLength(1);
    const ruslanUserId = ruslanProfileRows[0]?.userId as string;
    const regBeforeOverride = await db
      .select()
      .from(registrations)
      .where(eq(registrations.userId, ruslanUserId));
    expect(regBeforeOverride).toHaveLength(0);

    await bot.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:override:${eventId}`, overrideOfferText) as never,
    );

    const regAfterOverride = await db
      .select()
      .from(registrations)
      .where(eq(registrations.userId, ruslanUserId));
    expect(regAfterOverride).toHaveLength(1);
    expect(regAfterOverride[0]?.admission).toBe("admitted");
    expect(regAfterOverride[0]?.checkedInAt).not.toBeNull();
    expect(regAfterOverride[0]?.checkInMethod).toBe("manual");

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, regAfterOverride[0]?.id as string));
    const overrideAuditRows = auditRows.filter(
      (r) => r.action === "registration.walkin_override_admit",
    );
    expect(overrideAuditRows).toHaveLength(1);
    const payload = overrideAuditRows[0]?.payload as Record<string, unknown>;
    expect(payload["previousAdmission"]).toBeNull();
  });

  it("dismissing the override offer writes zero audit_log rows for either walk-in action", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 1 });

    const { bot: botFirst, captured: capturedFirst } = makeTestBot();
    await botFirst.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Damir Zhaksybekov|Co D|+77044445555`) as never,
    );
    const firstText = textOf(capturedFirst.find((c) => c.method === "sendMessage")) ?? "";
    await botFirst.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, firstText) as never,
    );

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Aliya Mamedova|Aral Systems|+77033334444`) as never,
    );
    const secondText = textOf(captured.find((c) => c.method === "sendMessage")) ?? "";
    await bot.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, secondText) as never,
    );
    const editCalls = captured.filter((c) => c.method === "editMessageText");
    const overrideOfferEdit = editCalls[editCalls.length - 1];
    const overrideOfferText = textOf(overrideOfferEdit) ?? "";

    await bot.handleUpdate(
      callbackUpdate(organizer.tgId, "walkin:cancel", overrideOfferText) as never,
    );

    const aliyaProfileRows = await db.select().from(profiles).where(eq(profiles.firstName, "Aliya Mamedova"));
    const aliyaUserId = aliyaProfileRows[0]?.userId as string;
    const regForAliya = await db
      .select()
      .from(registrations)
      .where(eq(registrations.userId, aliyaUserId));
    expect(regForAliya).toHaveLength(0);

    const allAuditRows = await db.select().from(auditLog);
    const walkinAuditRowsForAliya = allAuditRows.filter((r) => {
      const payload = r.payload as Record<string, unknown> | null;
      const actorMatches = r.actorUserId === aliyaUserId;
      const payloadMatches = payload !== null && JSON.stringify(payload).includes(aliyaUserId);
      return (
        (r.action === "registration.walkin_admit" || r.action === "registration.walkin_override_admit") &&
        (actorMatches || payloadMatches)
      );
    });
    expect(walkinAuditRowsForAliya).toHaveLength(0);

    const catalog = getCatalog("ru");
    const finalReply = captured.filter((c) => c.method === "answerCallbackQuery")[0];
    void finalReply;
    const lastEditOrSend = [...captured].reverse().find((c) => c.method === "editMessageText" || c.method === "sendMessage");
    expect(textOf(lastEditOrSend)).toBe(catalog.walkin.cancelled);
  });
});

describe("REQ-030 forgery AC4 -- differently-formatted-phone match reuses existing user, company not overwritten", () => {
  it("a second walk-in with the same phone (differently formatted) resolves to the same user; company untouched", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId: eventAlphaId } = await seedPublishedEvent(chapterId, organizer.userId, {
      capacity: 10,
      title: "Event Alpha",
    });
    const { eventId: eventBetaId } = await seedPublishedEvent(chapterId, organizer.userId, {
      capacity: 10,
      title: "Event Beta",
    });

    const { bot: bot1, captured: captured1 } = makeTestBot();
    await bot1.handleUpdate(
      commandUpdate(
        organizer.tgId,
        `/walkin ${eventAlphaId} Nurbek Aitmatov|Jibek Joly Trading|+77074445566`,
      ) as never,
    );
    const messageText1 = textOf(captured1.find((c) => c.method === "sendMessage")) ?? "";
    await bot1.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventAlphaId}`, messageText1) as never,
    );

    const usersAfterFirst = await countRows("users");
    const profilesAfterFirst = await countRows("profiles");

    const { bot: bot2, captured: captured2 } = makeTestBot();
    await bot2.handleUpdate(
      commandUpdate(
        organizer.tgId,
        `/walkin ${eventBetaId} Nurbek A. (door typo)|Wrong Co Name|7 707 444-55-66`,
      ) as never,
    );
    const messageText2 = textOf(captured2.find((c) => c.method === "sendMessage")) ?? "";
    await bot2.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventBetaId}`, messageText2) as never,
    );

    expect(await countRows("users")).toBe(usersAfterFirst);
    expect(await countRows("profiles")).toBe(profilesAfterFirst);

    const profileRows = await db.select().from(profiles).where(eq(profiles.firstName, "Nurbek Aitmatov"));
    expect(profileRows).toHaveLength(1);
    expect(profileRows[0]?.company).toBe("Jibek Joly Trading");

    const userId = profileRows[0]?.userId as string;
    const regRows = await db.select().from(registrations).where(eq(registrations.userId, userId));
    expect(regRows).toHaveLength(2);
    for (const r of regRows) {
      expect(r.admission).toBe("admitted");
    }
  });
});

describe("REQ-030 forgery AC5 -- no phone in audit payload (admit + override-admit paths); static log-call-site check", () => {
  it("neither the plain-admit nor the override-admit audit payload ever contains the phone value", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 1 });

    const phone1 = "+996700998877";
    const { bot: bot1, captured: captured1 } = makeTestBot();
    await bot1.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Saltanat Yerbolova|Tengri Soft|${phone1}`) as never,
    );
    const messageText1 = textOf(captured1.find((c) => c.method === "sendMessage")) ?? "";
    await bot1.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, messageText1) as never,
    );

    const profileRows1 = await db.select().from(profiles).where(eq(profiles.firstName, "Saltanat Yerbolova"));
    const userId1 = profileRows1[0]?.userId as string;
    const regRows1 = await db.select().from(registrations).where(eq(registrations.userId, userId1));
    const registrationId1 = regRows1[0]?.id as string;

    const auditRows1 = await db.select().from(auditLog).where(eq(auditLog.entityId, registrationId1));
    expect(auditRows1.length).toBeGreaterThan(0);
    for (const row of auditRows1) {
      const payloadJson = JSON.stringify(row.payload);
      expect(payloadJson).not.toContain(phone1);
      expect(Object.keys(row.payload as Record<string, unknown>)).not.toContain("phone");
    }

    // Now push to override-admit path via a third own walk-in.
    const phone2 = "+996700111222";
    const { bot: bot2, captured: captured2 } = makeTestBot();
    await bot2.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Second Filler|Filler Co|+996700333444`) as never,
    );
    const messageText2 = textOf(captured2.find((c) => c.method === "sendMessage")) ?? "";
    await bot2.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, messageText2) as never,
    );

    const { bot: bot3, captured: captured3 } = makeTestBot();
    await bot3.handleUpdate(
      commandUpdate(organizer.tgId, `/walkin ${eventId} Third Overflow|Overflow Co|${phone2}`) as never,
    );
    const messageText3 = textOf(captured3.find((c) => c.method === "sendMessage")) ?? "";
    await bot3.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, messageText3) as never,
    );
    const editCalls3 = captured3.filter((c) => c.method === "editMessageText");
    const overrideOfferText3 = textOf(editCalls3[editCalls3.length - 1]) ?? "";
    await bot3.handleUpdate(
      callbackUpdate(organizer.tgId, `walkin:override:${eventId}`, overrideOfferText3) as never,
    );

    const profileRows3 = await db.select().from(profiles).where(eq(profiles.firstName, "Third Overflow"));
    const userId3 = profileRows3[0]?.userId as string;
    const regRows3 = await db.select().from(registrations).where(eq(registrations.userId, userId3));
    const registrationId3 = regRows3[0]?.id as string;
    const auditRows3 = await db.select().from(auditLog).where(eq(auditLog.entityId, registrationId3));
    const overrideRows3 = auditRows3.filter((r) => r.action === "registration.walkin_override_admit");
    expect(overrideRows3.length).toBeGreaterThan(0);
    for (const row of overrideRows3) {
      const payloadJson = JSON.stringify(row.payload);
      expect(payloadJson).not.toContain(phone2);
      expect(Object.keys(row.payload as Record<string, unknown>)).not.toContain("phone");
    }
  });
});

describe("REQ-030 forgery AC6 -- a genuine EventStaff member for this exact event (not organizer) is refused", () => {
  it("a real EventStaff row for this event does not authorize a walk-in add", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 10 });
    const eventStaff = await seedEventStaffForEvent(chapterId, eventId, title, organizer.userId);

    const usersBefore = await countRows("users");
    const profilesBefore = await countRows("profiles");
    const registrationsBefore = await countRows("registrations");

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(eventStaff.tgId, `/walkin ${eventId} Should Not Exist|Whatever Co|+996700334455`) as never,
    );

    const catalog = getCatalog("ru");
    const reply = captured.find((c) => c.method === "sendMessage");
    expect(textOf(reply)).toBe(catalog.walkin.notAuthorized);

    expect(await countRows("users")).toBe(usersBefore);
    expect(await countRows("profiles")).toBe(profilesBefore);
    expect(await countRows("registrations")).toBe(registrationsBefore);
  });
});

describe("REQ-030 forgery -- cross-context forgery: organizer A tapping a confirm message rendered for chapter B's event", () => {
  it("re-authorizes fresh from the tapping user's own chapter, refusing chapter A's organizer", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterAId = await seedChapter();
    const chapterBId = await seedChapter();
    const organizerA = await seedOrganizer(chapterAId);
    const organizerB = await seedOrganizer(chapterBId);
    const { eventId: eventUnderChapterBId } = await seedPublishedEvent(chapterBId, organizerB.userId, {
      capacity: 10,
      title: "Chapter B Event",
    });

    const { bot: legitBot, captured: legitCaptured } = makeTestBot();
    await legitBot.handleUpdate(
      commandUpdate(
        organizerB.tgId,
        `/walkin ${eventUnderChapterBId} Zarina Bekturova|Tashkent Robotics|+998887776655`,
      ) as never,
    );
    const confirmMessageText = textOf(legitCaptured.find((c) => c.method === "sendMessage")) ?? "";
    const confirmReply = legitCaptured.find((c) => c.method === "sendMessage");
    const replyMarkup = confirmReply?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    const confirmCallbackData = replyMarkup?.inline_keyboard
      .flat()
      .find((b) => b.callback_data.startsWith("walkin:confirm:"))?.callback_data;
    expect(confirmCallbackData).toBe(`walkin:confirm:${eventUnderChapterBId}`);

    const zarinaProfileRowsBefore = await db
      .select()
      .from(profiles)
      .where(eq(profiles.firstName, "Zarina Bekturova"));
    const usersCountBeforeForge = await countRows("users");
    const profilesCountBeforeForge = await countRows("profiles");

    // Forged tap: Chapter A's own organizer, same callback_data, same message
    // text -- but this user was never the one this message was addressed to.
    const { bot: forgeBot, captured: forgeCaptured } = makeTestBot();
    await forgeBot.handleUpdate(
      callbackUpdate(organizerA.tgId, confirmCallbackData as string, confirmMessageText) as never,
    );

    const answerCall = forgeCaptured.find((c) => c.method === "answerCallbackQuery");
    expect(answerCall?.payload["show_alert"]).toBe(true);
    const catalog = getCatalog("ru");
    expect(answerCall?.payload["text"]).toBe(catalog.walkin.notAuthorized);

    const zarinaUserId = zarinaProfileRowsBefore[0]?.userId as string;
    const regForZarina = await db
      .select()
      .from(registrations)
      .where(eq(registrations.userId, zarinaUserId));
    expect(regForZarina).toHaveLength(0);

    expect(await countRows("users")).toBe(usersCountBeforeForge);
    expect(await countRows("profiles")).toBe(profilesCountBeforeForge);

    const allAuditRows = await db.select().from(auditLog);
    const walkinRowsForZarina = allAuditRows.filter((r) => {
      const payload = r.payload as Record<string, unknown> | null;
      const payloadMatches = payload !== null && JSON.stringify(payload).includes(zarinaUserId);
      return r.action.startsWith("registration.walkin_") && payloadMatches;
    });
    expect(walkinRowsForZarina).toHaveLength(0);
  });
});

describe("REQ-030 forgery -- malformed/corrupted message text: parseWalkinMessageFields fails clean, never crashes, never writes", () => {
  it("a confirm tap with a corrupted message missing a required prefix line refuses cleanly with staleMessage, for either missing field", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 10 });
    const catalog = getCatalog("ru");

    // Missing "Phone: " line entirely.
    const registrationsBeforeA = await countRows("registrations");
    const usersBeforeA = await countRows("users");
    const profilesBeforeA = await countRows("profiles");
    const corruptedMissingPhone = "Event: Test\nName: Someone\nCompany: —";
    const { bot: botA, captured: capturedA } = makeTestBot();
    await expect(
      botA.handleUpdate(
        callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, corruptedMissingPhone) as never,
      ),
    ).resolves.not.toThrow();
    const answerCallA = capturedA.find((c) => c.method === "answerCallbackQuery");
    expect(answerCallA?.payload["show_alert"]).toBe(true);
    expect(answerCallA?.payload["text"]).toBe(catalog.walkin.staleMessage);
    expect(await countRows("registrations")).toBe(registrationsBeforeA);
    expect(await countRows("users")).toBe(usersBeforeA);
    expect(await countRows("profiles")).toBe(profilesBeforeA);

    // Missing "Name: " line entirely.
    const registrationsBeforeB = await countRows("registrations");
    const usersBeforeB = await countRows("users");
    const profilesBeforeB = await countRows("profiles");
    const corruptedMissingName = "Event: Test\nPhone: +996700000000\nCompany: —";
    const { bot: botB, captured: capturedB } = makeTestBot();
    await expect(
      botB.handleUpdate(
        callbackUpdate(organizer.tgId, `walkin:confirm:${eventId}`, corruptedMissingName) as never,
      ),
    ).resolves.not.toThrow();
    const answerCallB = capturedB.find((c) => c.method === "answerCallbackQuery");
    expect(answerCallB?.payload["show_alert"]).toBe(true);
    expect(answerCallB?.payload["text"]).toBe(catalog.walkin.staleMessage);
    expect(await countRows("registrations")).toBe(registrationsBeforeB);
    expect(await countRows("users")).toBe(usersBeforeB);
    expect(await countRows("profiles")).toBe(profilesBeforeB);
  });
});
