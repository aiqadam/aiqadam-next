import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { registrations } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { getCatalog } from "../i18n/catalog.js";
import { makeRegisterCallbackHandler, REGISTER_CALLBACK_PATTERN } from "./registration.js";

// docs/agents/design/REQ-021.md — AC1 (waitlisted confirmation states a
// computed position), exercised through a real grammY dispatch
// (bot.handleUpdate()), same infrastructure/skip discipline as
// handlers/start.test.ts: real, migrated scratch Postgres
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
      `[registration.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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

  bot.callbackQuery(REGISTER_CALLBACK_PATTERN, makeRegisterCallbackHandler(db));

  return { bot, captured };
}

let nextUpdateId = 1;
let nextTgId = 800_000_000;

function registerCallbackUpdate(tgId: number, eventId: string) {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cbq_${nextUpdateId}`,
      from: { id: tgId, is_bot: false, first_name: "Test" },
      chat_instance: "test-chat-instance",
      data: `register:${eventId}`,
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

async function seedFullyBookedPublishedEvent(chapterId: string): Promise<string> {
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
      title: "Full Event",
      description: "A fully booked test event",
      format: "meetup",
      venueId,
      startsAt: new Date("2026-10-01T18:00:00Z"),
      endsAt: new Date("2026-10-01T20:00:00Z"),
      registrationClosesAt: null,
      capacity: 1,
      requiresInvite: false,
      requiresApproval: false,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, "Full Event", new Date());

  // Fill the single seat so the event is at capacity before the test's own
  // registration attempt.
  const filler = await resolveOrCreateUser(db, { tgId: BigInt(nextTgId++), tgUsername: "filler", lang: "ru" });
  await db.insert(registrations).values({
    eventId,
    userId: filler.id,
    admission: "admitted",
    source: "direct",
  });

  return eventId;
}

describe("makeRegisterCallbackHandler -- REQ-021 AC1: waitlisted confirmation states a computed position", () => {
  it("a registration against a fully-booked event replies with position 1", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const chapterId = await seedChapter();
    const eventId = await seedFullyBookedPublishedEvent(chapterId);

    const { bot, captured } = makeTestBot();
    const tgId = nextTgId++;
    await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: "waiter", lang: "ru" });

    await bot.handleUpdate(registerCallbackUpdate(tgId, eventId) as never);

    const methods = captured.map((c) => c.method);
    expect(methods).toEqual(["answerCallbackQuery", "sendMessage"]);

    const replyText = textOf(captured[1]) ?? "";
    const catalog = getCatalog("ru");
    expect(replyText).toContain(catalog.registration.waitlistedPrefix);
    expect(replyText).toContain(`${catalog.registration.waitlistedPositionPrefix} 1`);
    expect(replyText).toContain(catalog.registration.waitlistedWhatNext);

    const rows = await db.select().from(registrations).where(eq(registrations.eventId, eventId));
    const waitlistedRow = rows.find((r) => r.admission === "waitlisted");
    expect(waitlistedRow).toBeDefined();
  });

  it("the second waitlisted registrant against the same event replies with position 2", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const chapterId = await seedChapter();
    const eventId = await seedFullyBookedPublishedEvent(chapterId);

    const { bot: bot1 } = makeTestBot();
    const tgId1 = nextTgId++;
    await resolveOrCreateUser(db, { tgId: BigInt(tgId1), tgUsername: "waiter1", lang: "ru" });
    await bot1.handleUpdate(registerCallbackUpdate(tgId1, eventId) as never);

    const { bot: bot2, captured: captured2 } = makeTestBot();
    const tgId2 = nextTgId++;
    await resolveOrCreateUser(db, { tgId: BigInt(tgId2), tgUsername: "waiter2", lang: "ru" });
    await bot2.handleUpdate(registerCallbackUpdate(tgId2, eventId) as never);

    const catalog = getCatalog("ru");
    const replyText = textOf(captured2[1]) ?? "";
    expect(replyText).toContain(`${catalog.registration.waitlistedPositionPrefix} 2`);
  });
});
