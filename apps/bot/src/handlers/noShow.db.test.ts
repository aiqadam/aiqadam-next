import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { registerForEvent } from "../domain/registration.js";
import { getCatalog } from "../i18n/catalog.js";
import {
  NO_SHOW_REASON_PATTERN,
  NO_SHOW_OTHER_PATTERN,
  makeNoShowReasonCallbackHandler,
  makeNoShowOtherCallbackHandler,
  makeNoShowTextReplyHandler,
} from "./noShow.js";

// docs/agents/test-specs/REQ-032.md -- File 2: dispatch-level verification
// for AC2, S3 exploit. Modeled on handlers/feedback.db.test.ts's own shape:
// real grammY Bot, bot.api.config.use() capturing every outgoing call
// (never a hand-built Context), dispatched via bot.handleUpdate().

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT 1 FROM registrations LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[noShow.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
    "TRUNCATE notification_ledger, audit_log, registrations, events, venues, profiles, users, chapters CASCADE",
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
  bot.callbackQuery(NO_SHOW_REASON_PATTERN, makeNoShowReasonCallbackHandler(db));
  bot.callbackQuery(NO_SHOW_OTHER_PATTERN, makeNoShowOtherCallbackHandler(db));
  bot.on("message:text", makeNoShowTextReplyHandler(db));
  return { bot, captured };
}

let nextUpdateId = 1;
let nextTgId = 996_000_000;

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
        text: "placeholder",
      },
    },
  };
}

function replyUpdate(tgId: number, text: string, repliedToText: string) {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: tgId, type: "private" as const },
      from: { id: tgId, is_bot: false, first_name: "Test" },
      text,
      reply_to_message: {
        message_id: nextUpdateId - 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: tgId, type: "private" as const },
        text: repliedToText,
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
      code: `chapter-req032-handler-${chapterSeq}`,
      name: `Chapter REQ-032 Handler ${chapterSeq}`,
      timezone: "Asia/Tashkent",
      defaultLang: "ru",
      active: true,
    })
    .returning({ id: schema.chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedOrganizer(): Promise<string> {
  const organizer = await resolveOrCreateUser(db, {
    tgId: BigInt(nextTgId++),
    tgUsername: `organizer${nextTgId}`,
    lang: "ru",
  });
  return organizer.id;
}

async function seedPublishedEvent(chapterId: string, title = "No-Show Handler Test Event"): Promise<string> {
  const organizerId = await seedOrganizer();
  const eventId = await createEvent(
    db,
    organizerId,
    chapterId,
    {
      title,
      description: "A test event",
      format: "meetup",
      venueId: null,
      startsAt: new Date("2026-09-01T18:00:00Z"),
      endsAt: new Date("2026-09-01T20:00:00Z"),
      registrationClosesAt: null,
      capacity: 20,
      requiresInvite: false,
      requiresApproval: false,
      coverFileId: null,
    },
    new Date("2026-08-30T00:00:00Z"),
  );
  await publishEvent(db, organizerId, eventId, chapterId, title, new Date("2026-08-30T00:00:00Z"));
  return eventId;
}

// Shared-setup §5 helper -- registration never checked in: every case here
// targets the admitted-not-checked-in shape a real no-show ask would target.
async function seedAdmittedRegistration(
  eventId: string,
): Promise<{ userId: string; tgId: number; registrationId: string }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `member${tgId}`, lang: "ru" });
  const result = await registerForEvent(db, user.id, eventId, new Date("2026-08-31T00:00:00Z"));
  if (result.kind !== "admitted" || result.registrationId === undefined) {
    throw new Error(`seedAdmittedRegistration: registerForEvent did not admit -- ${result.kind}`);
  }
  return { userId: user.id, tgId, registrationId: result.registrationId };
}

const catalog = getCatalog("ru");

describe("REQ-032 AC2 -- selecting a fixed reason writes it to registrations.no_show_reason; the free-text 'other' path writes the raw trimmed text", () => {
  it("sub-case A: fixed-reason button writes the code; a re-tap does not overwrite it", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId);
    const { tgId, registrationId: A } = await seedAdmittedRegistration(eventId);

    // Pre-condition check.
    const preRow = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, A)))[0];
    expect(preRow?.noShowReason).toBeNull();

    const { bot, captured } = makeTestBot();

    await bot.handleUpdate(callbackUpdate(tgId, `noshow:reason:illness:${A}`) as never);

    const answerCall = captured.filter((c) => c.method === "answerCallbackQuery").at(-1);
    expect(answerCall?.payload["text"]).toBeUndefined();
    expect(answerCall?.payload["show_alert"]).toBeUndefined();

    let row = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, A)))[0];
    expect(row?.noShowReason).toBe("illness");

    let reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(textOf(reply)).toBe(catalog.noShow.thanksMessage);

    // Re-tap gate: a stale second tap on an already-answered registration.
    await bot.handleUpdate(callbackUpdate(tgId, `noshow:reason:forgot:${A}`) as never);

    row = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, A)))[0];
    expect(row?.noShowReason).toBe("illness"); // unchanged, NOT overwritten

    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(textOf(reply)).toBe(catalog.noShow.thanksMessage);
  });

  it("sub-case B: the free-text 'other' path writes the raw trimmed text", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId);
    const { tgId: vTgId, registrationId: B } = await seedAdmittedRegistration(eventId);

    const { bot, captured } = makeTestBot();

    await bot.handleUpdate(callbackUpdate(vTgId, `noshow:other:${B}`) as never);

    const reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(reply?.payload["reply_markup"]).toMatchObject({ force_reply: true });
    const otherPromptText = textOf(reply) ?? "";
    expect(otherPromptText).toContain(catalog.noShow.otherPrompt);
    expect(otherPromptText.endsWith(`No-show ref: ${B}`)).toBe(true);

    await bot.handleUpdate(
      replyUpdate(vTgId, "  My train was cancelled at the last minute  ", otherPromptText) as never,
    );

    const row = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, B)))[0];
    expect(row?.noShowReason).toBe("My train was cancelled at the last minute");
  });
});

describe("REQ-032 S3 exploit -- a forged/leaked registrationId across all three entry points is refused, with no write, in every case", () => {
  it("Bob's forged fixed-reason callback, 'other' callback, and free-text reply naming Alice's registration are all refused with no write; Alice's own legitimate reply still succeeds", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, "S3 Event");

    const { tgId: aliceTgId, registrationId: A } = await seedAdmittedRegistration(eventId);

    // Bob is a separate user with his own, unrelated registration for a
    // second event -- his own identity is all that matters here.
    const eventTwo = await seedPublishedEvent(chapterId, "S3 Event Two");
    const bobTgId = nextTgId++;
    const bob = await resolveOrCreateUser(db, { tgId: BigInt(bobTgId), tgUsername: `bob${bobTgId}`, lang: "ru" });
    await registerForEvent(db, bob.id, eventTwo, new Date("2026-08-31T00:00:00Z"));

    const { bot, captured } = makeTestBot();

    // Attack 1 -- fixed-reason callback forgery.
    await bot.handleUpdate(callbackUpdate(bobTgId, `noshow:reason:illness:${A}`) as never);

    const answerCall1 = captured.filter((c) => c.method === "answerCallbackQuery").at(-1);
    expect(answerCall1?.payload["show_alert"]).toBe(true);
    expect(answerCall1?.payload["text"]).toBe(catalog.noShow.notYours);

    let rowA = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, A)))[0];
    expect(rowA?.noShowReason).toBeNull();

    const sendsAfterAttack1 = captured.filter((c) => c.method === "sendMessage");
    expect(sendsAfterAttack1).toHaveLength(0);

    // Attack 2 -- "other" callback forgery.
    await bot.handleUpdate(callbackUpdate(bobTgId, `noshow:other:${A}`) as never);

    const answerCall2 = captured.filter((c) => c.method === "answerCallbackQuery").at(-1);
    expect(answerCall2?.payload["show_alert"]).toBe(true);
    expect(answerCall2?.payload["text"]).toBe(catalog.noShow.notYours);

    const forceReplySends = captured.filter(
      (c) =>
        c.method === "sendMessage" &&
        (c.payload["reply_markup"] as { force_reply?: boolean } | undefined)?.force_reply === true,
    );
    expect(forceReplySends).toHaveLength(0);

    rowA = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, A)))[0];
    expect(rowA?.noShowReason).toBeNull();

    // Attack 3 -- free-text reply forgery. Alice legitimately triggers her
    // own "other" prompt first.
    await bot.handleUpdate(callbackUpdate(aliceTgId, `noshow:other:${A}`) as never);
    const aliceOtherReply = captured.filter((c) => c.method === "sendMessage").at(-1);
    const otherPromptTextA = textOf(aliceOtherReply) ?? "";

    const captureLenBeforeAttack3 = captured.length;
    await bot.handleUpdate(replyUpdate(bobTgId, "Fake answer", otherPromptTextA) as never);

    rowA = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, A)))[0];
    expect(rowA?.noShowReason).toBeNull();

    const newSendsAfterAttack3 = captured.slice(captureLenBeforeAttack3).filter((c) => c.method === "sendMessage");
    expect(newSendsAfterAttack3).toHaveLength(0);

    // Then, immediately after, Alice's own legitimate reply to the same
    // prompt succeeds -- confirming the refusal above was specific to Bob's
    // forged identity, not a broken handler.
    await bot.handleUpdate(replyUpdate(aliceTgId, "Lost interest, honestly", otherPromptTextA) as never);

    rowA = (await db.select().from(schema.registrations).where(eq(schema.registrations.id, A)))[0];
    expect(rowA?.noShowReason).toBe("Lost interest, honestly");
  });
});
