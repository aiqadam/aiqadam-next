import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { registrations, auditLog } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { getCatalog } from "../i18n/catalog.js";
import {
  makeWithdrawCancelCallbackHandler,
  makeWithdrawCommandHandler,
  makeWithdrawConfirmCallbackHandler,
  WITHDRAW_CANCEL_PATTERN,
  WITHDRAW_CONFIRM_PATTERN,
} from "./withdraw.js";

// docs/agents/design/REQ-022.md — AC1 (confirmation required; dismissing
// leaves admission unchanged), exercised through a real grammY dispatch
// (bot.handleUpdate()), same infrastructure/skip discipline as
// handlers/registration.test.ts: real, migrated scratch Postgres
// (apps/bot/docker-compose.yml, TEST_DATABASE_URL), network replaced by an
// api.config.use capturing transformer.

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
      `[withdraw.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
  await pool.query("TRUNCATE audit_log, registrations, events, venues, profiles, users, chapters CASCADE");
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

function makeTestBot(): { bot: Bot; captured: Captured[] } {
  const captured: Captured[] = [];
  const bot = new Bot("000000:TEST-TOKEN-NOT-REAL", { botInfo: FAKE_BOT_INFO });

  bot.api.config.use(async (_prev, method, payload) => {
    captured.push({ method, payload: payload as Record<string, unknown> });
    if (method === "answerCallbackQuery") {
      return { ok: true, result: true } as never;
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

  bot.command("withdraw", makeWithdrawCommandHandler(db));
  bot.callbackQuery(WITHDRAW_CONFIRM_PATTERN, makeWithdrawConfirmCallbackHandler(db));
  bot.callbackQuery(WITHDRAW_CANCEL_PATTERN, makeWithdrawCancelCallbackHandler(db));

  return { bot, captured };
}

let nextUpdateId = 1;
let nextTgId = 900_000_000;

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

function callbackUpdate(tgId: number, data: string) {
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
      code: `chapter-${chapterSeq}`,
      name: `Chapter ${chapterSeq}`,
      timezone: "Asia/Tashkent",
      defaultLang: "ru",
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
    .values({ chapterId, name: "Test Venue", address: "123 Test St", capacity: 100 })
    .returning({ id: schema.venues.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedVenue: no row returned");
  return row.id;
}

async function seedPublishedEvent(chapterId: string, capacity = 5): Promise<string> {
  const venueId = await seedVenue(chapterId);
  const organizer = await resolveOrCreateUser(db, {
    tgId: BigInt(nextTgId++),
    tgUsername: "organizer",
    lang: "ru",
  });
  const eventId = await createEvent(
    db,
    organizer.id,
    chapterId,
    {
      title: "Withdraw Test Event",
      description: "A test event",
      format: "meetup",
      venueId,
      startsAt: new Date("2026-10-01T18:00:00Z"),
      endsAt: new Date("2026-10-01T20:00:00Z"),
      registrationClosesAt: null,
      capacity,
      requiresInvite: false,
      requiresApproval: false,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, "Withdraw Test Event", new Date());
  return eventId;
}

describe("makeWithdrawCommandHandler + confirm/cancel callbacks -- REQ-022 AC1", () => {
  it("registers, then /withdraw shows a confirm/cancel prompt", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId);
    const tgId = nextTgId++;
    const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: "member1", lang: "ru" });
    await db.insert(registrations).values({ eventId, userId: user.id, admission: "admitted", source: "direct" });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(tgId, `/withdraw ${eventId}`) as never);

    const catalog = getCatalog("ru");
    expect(captured).toHaveLength(1);
    const replyText = textOf(captured[0]) ?? "";
    expect(replyText).toContain(catalog.withdraw.confirmPrompt);
    expect(replyText).toContain("Withdraw Test Event");

    const replyMarkup = captured[0]?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    expect(replyMarkup).toBeDefined();
    const buttons = replyMarkup?.inline_keyboard.flat() ?? [];
    const confirmButton = buttons.find((b) => b.text === catalog.withdraw.confirmButton);
    const cancelButton = buttons.find((b) => b.text === catalog.withdraw.cancelButton);
    expect(confirmButton?.callback_data).toMatch(/^withdraw:confirm:.+$/);
    expect(cancelButton?.callback_data).toMatch(/^withdraw:cancel:.+$/);
  });

  it("dismissing the prompt (cancel tap) leaves admission unchanged, confirmed by reading the row back", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId);
    const tgId = nextTgId++;
    const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: "member2", lang: "ru" });
    const inserted = await db
      .insert(registrations)
      .values({ eventId, userId: user.id, admission: "admitted", source: "direct" })
      .returning({ id: registrations.id });
    const registrationId = inserted[0]?.id;
    if (registrationId === undefined) throw new Error("fixture insert returned no row");

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(callbackUpdate(tgId, `withdraw:cancel:${registrationId}`) as never);

    const methods = captured.map((c) => c.method);
    expect(methods).toEqual(["answerCallbackQuery", "sendMessage"]);
    const catalog = getCatalog("ru");
    expect(textOf(captured[1])).toBe(catalog.withdraw.cancelledReply);

    const rows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(rows[0]?.admission).toBe("admitted");

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, registrationId));
    expect(auditRows).toHaveLength(0);
  });

  it("confirming the prompt (confirm tap) withdraws and replies with confirmedReply", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId);
    const tgId = nextTgId++;
    const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: "member3", lang: "ru" });
    const inserted = await db
      .insert(registrations)
      .values({ eventId, userId: user.id, admission: "admitted", source: "direct" })
      .returning({ id: registrations.id });
    const registrationId = inserted[0]?.id;
    if (registrationId === undefined) throw new Error("fixture insert returned no row");

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(callbackUpdate(tgId, `withdraw:confirm:${registrationId}`) as never);

    const methods = captured.map((c) => c.method);
    expect(methods).toEqual(["answerCallbackQuery", "sendMessage"]);
    const catalog = getCatalog("ru");
    expect(textOf(captured[1])).toBe(catalog.withdraw.confirmedReply);

    const rows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(rows[0]?.admission).toBe("withdrawn");

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, registrationId));
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]?.action).toBe("registration.withdraw");
  });

  it("/withdraw with no matching registration replies refusedNotFound, no prompt shown", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId);
    const tgId = nextTgId++;
    await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: "member4", lang: "ru" });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(tgId, `/withdraw ${eventId}`) as never);

    const catalog = getCatalog("ru");
    expect(captured).toHaveLength(1);
    expect(textOf(captured[0])).toBe(catalog.withdraw.refusedNotFound);
    expect(captured[0]?.payload["reply_markup"]).toBeUndefined();
  });
});

// docs/agents/design/REQ-023.md — waitlist auto-promotion notification, sent
// via a real grammY dispatch (bot.handleUpdate()) exactly like REQ-022's own
// AC1 suite above.
describe("REQ-023 AC6: the promoted person is notified even with broadcast_opt_in=false", () => {
  it("confirming a withdrawal that frees a seat sends a promotion notification to the promoted person's own chat", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    // Capacity 1: the admitted registration is the only seat.
    const eventId = await seedPublishedEvent(chapterId, 1);

    const admittedTgId = nextTgId++;
    const admittedUser = await resolveOrCreateUser(db, {
      tgId: BigInt(admittedTgId),
      tgUsername: "admitted-member",
      lang: "ru",
    });
    const admittedInserted = await db
      .insert(registrations)
      .values({ eventId, userId: admittedUser.id, admission: "admitted", source: "direct" })
      .returning({ id: registrations.id });
    const admittedRegistrationId = admittedInserted[0]?.id;
    if (admittedRegistrationId === undefined) throw new Error("fixture insert returned no row");

    const promotedTgId = nextTgId++;
    const promotedUser = await resolveOrCreateUser(db, {
      tgId: BigInt(promotedTgId),
      tgUsername: "waitlisted-member",
      lang: "ru",
    });
    // S10 negative case: broadcast_opt_in explicitly false -- the
    // notification must be sent anyway (transactional, ignores this flag).
    await db.update(schema.users).set({ broadcastOptIn: false }).where(eq(schema.users.id, promotedUser.id));
    await db.insert(registrations).values({
      eventId,
      userId: promotedUser.id,
      admission: "waitlisted",
      source: "direct",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(callbackUpdate(admittedTgId, `withdraw:confirm:${admittedRegistrationId}`) as never);

    // Three sends: answerCallbackQuery, the promotion notification to the
    // promoted person's own chat, then the withdrawer's own confirmedReply.
    const methods = captured.map((c) => c.method);
    expect(methods).toEqual(["answerCallbackQuery", "sendMessage", "sendMessage"]);

    const promotionSend = captured[1];
    expect(promotionSend?.payload["chat_id"]).toBe(promotedTgId.toString());
    const catalog = getCatalog("ru");
    const promotionText = textOf(promotionSend) ?? "";
    expect(promotionText).toContain(catalog.promotion.admittedPrefix);
    expect(promotionText).toContain(catalog.promotion.qrLabel);

    const withdrawerReply = captured[2];
    expect(textOf(withdrawerReply)).toBe(catalog.withdraw.confirmedReply);

    // The promoted person's registration is now admitted, with a fresh
    // qr_token.
    const promotedRows = await db
      .select()
      .from(registrations)
      .where(eq(registrations.userId, promotedUser.id));
    expect(promotedRows[0]?.admission).toBe("admitted");
    expect(promotedRows[0]?.qrToken).toMatch(/^[0-9a-f]{64}$/);
  });
});

// security-invariants.md S10: "blocked users are skipped in both cases" --
// rework of the SECURITY-REVIEWER Step 2c FAIL. The promotion itself must
// still complete in full (admission/audit/seat-freeing all succeed); only
// the notification send is withheld.
describe("S10 rework: a blocked promoted person's promotion completes with no notification sent", () => {
  it("admits the blocked person and writes one audit row, but sends them no message", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    // Capacity 1: the admitted registration is the only seat.
    const eventId = await seedPublishedEvent(chapterId, 1);

    const admittedTgId = nextTgId++;
    const admittedUser = await resolveOrCreateUser(db, {
      tgId: BigInt(admittedTgId),
      tgUsername: "admitted-member2",
      lang: "ru",
    });
    const admittedInserted = await db
      .insert(registrations)
      .values({ eventId, userId: admittedUser.id, admission: "admitted", source: "direct" })
      .returning({ id: registrations.id });
    const admittedRegistrationId = admittedInserted[0]?.id;
    if (admittedRegistrationId === undefined) throw new Error("fixture insert returned no row");

    const promotedTgId = nextTgId++;
    const promotedUser = await resolveOrCreateUser(db, {
      tgId: BigInt(promotedTgId),
      tgUsername: "blocked-waitlisted-member",
      lang: "ru",
    });
    // The negative case this rework locks down: the promoted person is
    // blocked. Promotion must still succeed; the send must not happen.
    await db.update(schema.users).set({ blocked: true }).where(eq(schema.users.id, promotedUser.id));
    await db.insert(registrations).values({
      eventId,
      userId: promotedUser.id,
      admission: "waitlisted",
      source: "direct",
      createdAt: new Date("2026-09-01T00:00:00.000Z"),
    });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(callbackUpdate(admittedTgId, `withdraw:confirm:${admittedRegistrationId}`) as never);

    // No sendMessage to the blocked person's chat -- only
    // answerCallbackQuery and the withdrawer's own confirmedReply.
    const methods = captured.map((c) => c.method);
    expect(methods).toEqual(["answerCallbackQuery", "sendMessage"]);
    const catalog = getCatalog("ru");
    expect(textOf(captured[1])).toBe(catalog.withdraw.confirmedReply);

    const chatIds = captured
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload["chat_id"]);
    expect(chatIds).not.toContain(promotedTgId.toString());

    // The promotion itself (admission, seat accounting) still completed.
    const promotedRows = await db
      .select()
      .from(registrations)
      .where(eq(registrations.userId, promotedUser.id));
    expect(promotedRows[0]?.admission).toBe("admitted");
    expect(promotedRows[0]?.qrToken).toMatch(/^[0-9a-f]{64}$/);

    // Exactly one audit row for the promoted registration -- the promotion
    // path's audit write is unaffected by the notification being withheld.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, promotedRows[0]!.id));
    expect(auditRows).toHaveLength(1);
  });
});
