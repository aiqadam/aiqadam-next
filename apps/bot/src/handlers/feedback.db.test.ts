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
  FEEDBACK_BROADCAST_PATTERN,
  FEEDBACK_NPS_PATTERN,
  makeFeedbackBroadcastCallbackHandler,
  makeFeedbackNpsCallbackHandler,
  makeFeedbackTextReplyHandler,
} from "./feedback.js";

// docs/agents/test-specs/REQ-031.md -- File 2: dispatch-level verification
// for AC2, AC3, AC5, AC6, S3. Modeled on handlers/checkinQr.forgery.test.ts's
// own shape: real grammY Bot, bot.api.config.use() capturing every outgoing
// call (never a hand-built Context), dispatched via bot.handleUpdate().

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT 1 FROM feedback LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[feedback.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
    "TRUNCATE notification_ledger, audit_log, feedback, registrations, events, venues, profiles, users, chapters CASCADE",
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
  bot.callbackQuery(FEEDBACK_NPS_PATTERN, makeFeedbackNpsCallbackHandler(db));
  bot.callbackQuery(FEEDBACK_BROADCAST_PATTERN, makeFeedbackBroadcastCallbackHandler(db));
  bot.on("message:text", makeFeedbackTextReplyHandler(db));
  return { bot, captured };
}

let nextUpdateId = 1;
let nextTgId = 994_000_000;

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
      code: `chapter-req031-handler-${chapterSeq}`,
      name: `Chapter REQ-031 Handler ${chapterSeq}`,
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

async function seedPublishedEvent(chapterId: string, title = "Feedback Handler Test Event"): Promise<string> {
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

// Shared-setup §5 helper.
async function seedAdmittedCheckedInRegistration(
  eventId: string,
): Promise<{ userId: string; tgId: number; registrationId: string }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `member${tgId}`, lang: "ru" });
  const result = await registerForEvent(db, user.id, eventId, new Date("2026-08-31T00:00:00Z"));
  if (result.kind !== "admitted" || result.registrationId === undefined) {
    throw new Error(`seedAdmittedCheckedInRegistration: registerForEvent did not admit -- ${result.kind}`);
  }
  await db
    .update(schema.registrations)
    .set({ checkedInAt: new Date("2026-09-01T20:05:00Z"), checkInMethod: "qr" })
    .where(eq(schema.registrations.id, result.registrationId));
  return { userId: user.id, tgId, registrationId: result.registrationId };
}

const catalog = getCatalog("ru");

describe("REQ-031 AC2 -- NPS+comments+topic votes -> one feedback row; a raw duplicate INSERT fails on the DB constraint", () => {
  it("drives the full optional-field sequence, then proves the DB-level uniqueness constraint directly", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId);
    const { tgId, registrationId: A } = await seedAdmittedCheckedInRegistration(eventId);

    // Pre-condition check (AC3's flip side): zero rows before any tap.
    const preRows = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, A));
    expect(preRows).toHaveLength(0);

    const { bot, captured } = makeTestBot();

    await bot.handleUpdate(callbackUpdate(tgId, `feedback:nps:8:${A}`) as never);

    let rows = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, A));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nps).toBe(8);
    expect(rows[0]?.liked).toBeNull();
    expect(rows[0]?.improve).toBeNull();
    expect(rows[0]?.topicVotes).toBeNull();
    expect(rows[0]?.likedSkipped).toBe(false);
    expect(rows[0]?.improveSkipped).toBe(false);
    expect(rows[0]?.topicVotesSkipped).toBe(false);

    let reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(textOf(reply)).toContain(catalog.feedback.likedPrompt);
    expect(reply?.payload["reply_markup"]).toMatchObject({ force_reply: true });
    const likedPromptText = textOf(reply) ?? "";

    await bot.handleUpdate(replyUpdate(tgId, "Great speakers and food", likedPromptText) as never);

    rows = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, A));
    expect(rows[0]?.liked).toBe("Great speakers and food");
    expect(rows[0]?.likedSkipped).toBe(false);

    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(textOf(reply)).toContain(catalog.feedback.improvePrompt);
    expect(reply?.payload["reply_markup"]).toMatchObject({ force_reply: true });
    const improvePromptText = textOf(reply) ?? "";

    await bot.handleUpdate(replyUpdate(tgId, "skip", improvePromptText) as never);

    rows = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, A));
    expect(rows[0]?.improve).toBeNull();
    expect(rows[0]?.improveSkipped).toBe(true);

    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(textOf(reply)).toContain(catalog.feedback.topicVotesPrompt);
    const topicVotesPromptText = textOf(reply) ?? "";

    await bot.handleUpdate(replyUpdate(tgId, "AI, Web3\nBlockchain", topicVotesPromptText) as never);

    rows = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, A));
    expect(rows[0]?.topicVotes).toEqual(["AI", "Web3", "Blockchain"]);
    expect(rows[0]?.topicVotesSkipped).toBe(false);

    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(textOf(reply)).toBe(catalog.feedback.broadcastAskPrompt);
    const replyMarkup = reply?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    const buttons = replyMarkup?.inline_keyboard.flat() ?? [];
    expect(buttons.find((b) => b.callback_data === `feedback:broadcast:yes:${A}`)).toBeDefined();
    expect(buttons.find((b) => b.callback_data === `feedback:broadcast:no:${A}`)).toBeDefined();

    // Exactly 1 row for A, the entire flow never inserts a second row.
    rows = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, A));
    expect(rows).toHaveLength(1);

    // The direct duplicate-INSERT proof. Drizzle wraps the raw pg error one
    // level deep as DrizzleQueryError.cause (the same shape
    // domain/notification.ts's own pgErrorCode() unwraps) -- the code lives
    // on .cause.code, not on the top-level rejection object itself.
    await expect(
      db.insert(schema.feedback).values({
        registrationId: A,
        nps: 5,
        createdAt: new Date(),
        updatedAt: new Date(),
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });

    rows = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, A));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nps).toBe(8);
  });
});

describe("REQ-031 AC3 -- full-skip path saves the row anyway; and the stale-reply field-match gate", () => {
  it("sub-case A: skip all three optional fields, feedback row still saves with all *Skipped=true", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId);
    const { tgId, registrationId: B } = await seedAdmittedCheckedInRegistration(eventId);

    const { bot, captured } = makeTestBot();

    await bot.handleUpdate(callbackUpdate(tgId, `feedback:nps:4:${B}`) as never);
    let reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    const likedPromptText = textOf(reply) ?? "";

    await bot.handleUpdate(replyUpdate(tgId, "skip", likedPromptText) as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    const improvePromptText = textOf(reply) ?? "";

    await bot.handleUpdate(replyUpdate(tgId, "skip", improvePromptText) as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    const topicVotesPromptText = textOf(reply) ?? "";

    await bot.handleUpdate(replyUpdate(tgId, "skip", topicVotesPromptText) as never);

    const rows = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, B));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.nps).toBe(4);
    expect(rows[0]?.liked).toBeNull();
    expect(rows[0]?.improve).toBeNull();
    expect(rows[0]?.topicVotes).toBeNull();
    expect(rows[0]?.likedSkipped).toBe(true);
    expect(rows[0]?.improveSkipped).toBe(true);
    expect(rows[0]?.topicVotesSkipped).toBe(true);

    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(textOf(reply)).toBe(catalog.feedback.broadcastAskPrompt);
  });

  it("sub-case B: a stale reply to an already-superseded prompt for a different sibling field is a silent no-op", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId);
    const { tgId, registrationId: C } = await seedAdmittedCheckedInRegistration(eventId);

    const { bot, captured } = makeTestBot();

    await bot.handleUpdate(callbackUpdate(tgId, `feedback:nps:7:${C}`) as never);
    let reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    const likedPromptTextC = textOf(reply) ?? "";

    await bot.handleUpdate(replyUpdate(tgId, "Loved the networking", likedPromptTextC) as never);
    let rows = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, C));
    expect(rows[0]?.liked).toBe("Loved the networking");

    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    const improvePromptTextC = textOf(reply) ?? "";
    void improvePromptTextC;

    const snapshot = rows[0];
    const capturedLengthBefore = captured.length;

    // The stale reply: replying to the OLD "liked" prompt while the flow's
    // freshly-derived step.field is "improve".
    await bot.handleUpdate(
      replyUpdate(tgId, "Actually the venue was too small", likedPromptTextC) as never,
    );

    rows = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, C));
    expect(rows[0]?.liked).toBe("Loved the networking"); // unchanged
    expect(rows[0]?.improve).toBeNull(); // unchanged
    expect(rows[0]?.improveSkipped).toBe(false);
    expect(rows[0]?.updatedAt?.getTime()).toBe(snapshot?.updatedAt?.getTime());

    expect(captured).toHaveLength(capturedLengthBefore); // no new send
  });
});

describe("REQ-031 AC5 -- broadcast-opt-in asked once; a later event's flow does not re-ask, for both a decline and an accept", () => {
  it("decline case: regTwo's flow completes without ever seeing the broadcast-ask prompt again; a stale accept-tap on regTwo does not flip broadcastOptIn", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventOne = await seedPublishedEvent(chapterId, "Event One");
    const eventTwo = await seedPublishedEvent(chapterId, "Event Two");

    const tgId = nextTgId++;
    const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `declineUser${tgId}`, lang: "ru" });
    const resultOne = await registerForEvent(db, user.id, eventOne, new Date("2026-08-31T00:00:00Z"));
    if (resultOne.kind !== "admitted" || resultOne.registrationId === undefined) {
      throw new Error(`decline fixture: regOne did not admit -- ${resultOne.kind}`);
    }
    const regOne = resultOne.registrationId;
    await db
      .update(schema.registrations)
      .set({ checkedInAt: new Date("2026-09-01T20:05:00Z"), checkInMethod: "qr" })
      .where(eq(schema.registrations.id, regOne));

    const resultTwo = await registerForEvent(db, user.id, eventTwo, new Date("2026-08-31T00:00:00Z"));
    if (resultTwo.kind !== "admitted" || resultTwo.registrationId === undefined) {
      throw new Error(`decline fixture: regTwo did not admit -- ${resultTwo.kind}`);
    }
    const regTwo = resultTwo.registrationId;
    await db
      .update(schema.registrations)
      .set({ checkedInAt: new Date("2026-09-01T20:05:00Z"), checkInMethod: "qr" })
      .where(eq(schema.registrations.id, regTwo));

    const { bot, captured } = makeTestBot();

    // Drive regOne's flow to completion (NPS + skip all three optional).
    await bot.handleUpdate(callbackUpdate(tgId, `feedback:nps:6:${regOne}`) as never);
    let reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);

    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(textOf(reply)).toBe(catalog.feedback.broadcastAskPrompt);

    await bot.handleUpdate(callbackUpdate(tgId, `feedback:broadcast:no:${regOne}`) as never);

    let userRow = (await db.select().from(schema.users).where(eq(schema.users.id, user.id)))[0];
    expect(userRow?.broadcastOptIn).toBe(false);
    expect(userRow?.broadcastOptInAskedAt).not.toBeNull();

    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(textOf(reply)).toBe(catalog.feedback.completedNotice);

    // Now drive regTwo's flow: NPS tap + skip all three -- the broadcast-ask
    // prompt is never sent for regTwo.
    const regTwoStart = captured.length;
    await bot.handleUpdate(callbackUpdate(tgId, `feedback:nps:9:${regTwo}`) as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);

    const regTwoMessages = captured.slice(regTwoStart).filter((c) => c.method === "sendMessage");
    expect(regTwoMessages.some((m) => textOf(m) === catalog.feedback.broadcastAskPrompt)).toBe(false);
    expect(textOf(regTwoMessages.at(-1))).toBe(catalog.feedback.completedNotice);

    // Stale-tap check: a forged/leftover "yes" tap on regTwo does not flip
    // broadcastOptIn to true.
    await bot.handleUpdate(callbackUpdate(tgId, `feedback:broadcast:yes:${regTwo}`) as never);
    userRow = (await db.select().from(schema.users).where(eq(schema.users.id, user.id)))[0];
    expect(userRow?.broadcastOptIn).toBe(false);
  });

  it("accept case (separate fixture, user V): the second registration's flow does not re-ask, and broadcastOptIn stays true", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventOne = await seedPublishedEvent(chapterId, "Event One V");
    const eventTwo = await seedPublishedEvent(chapterId, "Event Two V");

    const tgId = nextTgId++;
    const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `acceptUser${tgId}`, lang: "ru" });
    const resultOne = await registerForEvent(db, user.id, eventOne, new Date("2026-08-31T00:00:00Z"));
    if (resultOne.kind !== "admitted" || resultOne.registrationId === undefined) {
      throw new Error(`accept fixture: firstReg did not admit -- ${resultOne.kind}`);
    }
    const firstReg = resultOne.registrationId;
    await db
      .update(schema.registrations)
      .set({ checkedInAt: new Date("2026-09-01T20:05:00Z"), checkInMethod: "qr" })
      .where(eq(schema.registrations.id, firstReg));

    const resultTwo = await registerForEvent(db, user.id, eventTwo, new Date("2026-08-31T00:00:00Z"));
    if (resultTwo.kind !== "admitted" || resultTwo.registrationId === undefined) {
      throw new Error(`accept fixture: secondReg did not admit -- ${resultTwo.kind}`);
    }
    const secondReg = resultTwo.registrationId;
    await db
      .update(schema.registrations)
      .set({ checkedInAt: new Date("2026-09-01T20:05:00Z"), checkInMethod: "qr" })
      .where(eq(schema.registrations.id, secondReg));

    const { bot, captured } = makeTestBot();

    await bot.handleUpdate(callbackUpdate(tgId, `feedback:nps:10:${firstReg}`) as never);
    let reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);

    await bot.handleUpdate(callbackUpdate(tgId, `feedback:broadcast:yes:${firstReg}`) as never);

    let userRow = (await db.select().from(schema.users).where(eq(schema.users.id, user.id)))[0];
    expect(userRow?.broadcastOptIn).toBe(true);
    expect(userRow?.broadcastOptInAskedAt).not.toBeNull();

    const secondRegStart = captured.length;
    await bot.handleUpdate(callbackUpdate(tgId, `feedback:nps:2:${secondReg}`) as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(tgId, "skip", textOf(reply) ?? "") as never);

    const secondRegMessages = captured.slice(secondRegStart).filter((c) => c.method === "sendMessage");
    expect(secondRegMessages.some((m) => textOf(m) === catalog.feedback.broadcastAskPrompt)).toBe(false);
    expect(textOf(secondRegMessages.at(-1))).toBe(catalog.feedback.completedNotice);

    userRow = (await db.select().from(schema.users).where(eq(schema.users.id, user.id)))[0];
    expect(userRow?.broadcastOptIn).toBe(true); // unchanged, still true
  });
});

// AC6 (no "want to speak" question anywhere; no talks table/entity) is a
// static git-grep check, run once by TEST-RUNNER as a shell action alongside
// this vitest run per test-specs/REQ-031.md's own instruction -- not a
// vitest it() here.

describe("REQ-031 S3 exploit -- forged/reused registration id in a callback or reply is refused, no write, across all three handlers", () => {
  it("Bob's forged NPS callback, text reply, and broadcast callback naming Alice's registration are all refused with no write", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, "S3 Event");

    const aliceTgId = nextTgId++;
    const alice = await resolveOrCreateUser(db, { tgId: BigInt(aliceTgId), tgUsername: `alice${aliceTgId}`, lang: "ru" });
    const aliceResult = await registerForEvent(db, alice.id, eventId, new Date("2026-08-31T00:00:00Z"));
    if (aliceResult.kind !== "admitted" || aliceResult.registrationId === undefined) {
      throw new Error(`S3 fixture: Alice's registration did not admit -- ${aliceResult.kind}`);
    }
    const A = aliceResult.registrationId;
    await db
      .update(schema.registrations)
      .set({ checkedInAt: new Date("2026-09-01T20:05:00Z"), checkInMethod: "qr" })
      .where(eq(schema.registrations.id, A));

    // Bob is a separate user with his own, unrelated registration for a
    // different event -- his own identity is all that matters here.
    const bobTgId = nextTgId++;
    const bob = await resolveOrCreateUser(db, { tgId: BigInt(bobTgId), tgUsername: `bob${bobTgId}`, lang: "ru" });
    const eventTwo = await seedPublishedEvent(chapterId, "S3 Event Two");
    await registerForEvent(db, bob.id, eventTwo, new Date("2026-08-31T00:00:00Z"));

    const { bot, captured } = makeTestBot();

    // Drive Alice's flow far enough to have both a feedback row and a
    // captured "liked" prompt.
    await bot.handleUpdate(callbackUpdate(aliceTgId, `feedback:nps:6:${A}`) as never);
    const likedReply = captured.filter((c) => c.method === "sendMessage").at(-1);
    const likedPromptTextA = textOf(likedReply) ?? "";

    // Attack 1 -- NPS callback forgery: Bob taps a callback naming Alice's
    // own registration id.
    await bot.handleUpdate(callbackUpdate(bobTgId, `feedback:nps:9:${A}`) as never);

    const answerCall1 = captured.filter((c) => c.method === "answerCallbackQuery").at(-1);
    expect(answerCall1?.payload["show_alert"]).toBe(true);
    expect(answerCall1?.payload["text"]).toBe(catalog.feedback.notYourFeedback);

    let feedbackRowsA = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, A));
    expect(feedbackRowsA[0]?.nps).toBe(6); // still 6, not overwritten to 9

    const nonARows = await db.select().from(schema.feedback);
    expect(nonARows.filter((r) => r.registrationId !== A)).toHaveLength(0);

    // Attack 2 -- text-reply forgery: Bob replies to Alice's own "liked"
    // prompt.
    const captureLenBeforeAttack2 = captured.length;
    await bot.handleUpdate(replyUpdate(bobTgId, "Fake answer", likedPromptTextA) as never);

    feedbackRowsA = await db.select().from(schema.feedback).where(eq(schema.feedback.registrationId, A));
    expect(feedbackRowsA[0]?.liked).toBeNull(); // unchanged

    const newSendsAfterAttack2 = captured
      .slice(captureLenBeforeAttack2)
      .filter((c) => c.method === "sendMessage");
    expect(newSendsAfterAttack2).toHaveLength(0);

    // Drive A's flow to the broadcast-ask step (answer/skip remaining
    // optional fields as Alice).
    await bot.handleUpdate(replyUpdate(aliceTgId, "Loved it", likedPromptTextA) as never);
    let reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(aliceTgId, "skip", textOf(reply) ?? "") as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    await bot.handleUpdate(replyUpdate(aliceTgId, "skip", textOf(reply) ?? "") as never);
    reply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(textOf(reply)).toBe(catalog.feedback.broadcastAskPrompt);

    const aliceUserBefore = (await db.select().from(schema.users).where(eq(schema.users.id, alice.id)))[0];
    const bobUserBefore = (await db.select().from(schema.users).where(eq(schema.users.id, bob.id)))[0];

    // Attack 3 -- broadcast callback forgery: Bob taps Alice's registration
    // id on the broadcast-ask step.
    await bot.handleUpdate(callbackUpdate(bobTgId, `feedback:broadcast:yes:${A}`) as never);

    const answerCall3 = captured.filter((c) => c.method === "answerCallbackQuery").at(-1);
    expect(answerCall3?.payload["show_alert"]).toBe(true);
    expect(answerCall3?.payload["text"]).toBe(catalog.feedback.notYourFeedback);

    const aliceUserAfter = (await db.select().from(schema.users).where(eq(schema.users.id, alice.id)))[0];
    const bobUserAfter = (await db.select().from(schema.users).where(eq(schema.users.id, bob.id)))[0];

    expect(aliceUserAfter?.broadcastOptIn).toBe(aliceUserBefore?.broadcastOptIn);
    expect(aliceUserAfter?.broadcastOptInAskedAt?.getTime()).toBe(aliceUserBefore?.broadcastOptInAskedAt?.getTime());
    expect(bobUserAfter?.broadcastOptIn).toBe(bobUserBefore?.broadcastOptIn);
    expect(bobUserAfter?.broadcastOptInAskedAt?.getTime()).toBe(bobUserBefore?.broadcastOptInAskedAt?.getTime());
  });
});
