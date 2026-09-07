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
  makeReminder24hConfirmCallbackHandler,
  makeReminder24hDeclineCallbackHandler,
  REMINDER24H_CONFIRM_PATTERN,
  REMINDER24H_DECLINE_PATTERN,
} from "./reminder24h.js";
import { createRateLimitedSender, DEFAULT_RATE_LIMITER_CONFIG } from "../scheduler/rateLimiter.js";

// docs/agents/design/REQ-026.md §7 — AC2: "I'll be there" sets
// reconfirmed_at, admission UNCHANGED; "Can't make it" withdraws, frees the
// seat (reuses withdrawRegistration). Real grammY dispatch, same
// infrastructure/skip discipline as handlers/withdraw.test.ts: real,
// migrated scratch Postgres (apps/bot/docker-compose.yml, TEST_DATABASE_URL).

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT reconfirmed_at FROM registrations LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[reminder24h.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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

  const sender = createRateLimitedSender(bot, DEFAULT_RATE_LIMITER_CONFIG);
  bot.callbackQuery(REMINDER24H_CONFIRM_PATTERN, makeReminder24hConfirmCallbackHandler(db));
  bot.callbackQuery(REMINDER24H_DECLINE_PATTERN, makeReminder24hDeclineCallbackHandler(db, sender));

  return { bot, captured };
}

let nextUpdateId = 1;
let nextTgId = 950_000_000;

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
      code: `chapter-r24h-${chapterSeq}`,
      name: `Chapter R24H ${chapterSeq}`,
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
      title: "Reminder24h Test Event",
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
  await publishEvent(db, organizer.id, eventId, chapterId, "Reminder24h Test Event", new Date());
  return eventId;
}

describe("reminder24h:confirm -- REQ-026 AC2 first half", () => {
  it("sets reconfirmed_at, leaves admission unchanged", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId);
    const tgId = nextTgId++;
    const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: "member1", lang: "ru" });
    const inserted = await db
      .insert(registrations)
      .values({ eventId, userId: user.id, admission: "admitted", source: "direct" })
      .returning({ id: registrations.id });
    const registrationId = inserted[0]?.id;
    if (registrationId === undefined) throw new Error("fixture insert returned no row");

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(callbackUpdate(tgId, `reminder24h:confirm:${registrationId}`) as never);

    const catalog = getCatalog("ru");
    const methods = captured.map((c) => c.method);
    expect(methods).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(textOf(captured[1])).toBe(catalog.reminder24h.reconfirmedReply);

    const rows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(rows[0]?.admission).toBe("admitted");
    expect(rows[0]?.reconfirmedAt).not.toBeNull();

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, registrationId));
    const reconfirmRows = auditRows.filter((r) => r.action === "registration.reconfirm");
    expect(reconfirmRows).toHaveLength(1);
  });

  it("refuses (not-eligible) for a withdrawn registration, leaving reconfirmed_at null", async (t) => {
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
      .values({ eventId, userId: user.id, admission: "withdrawn", source: "direct" })
      .returning({ id: registrations.id });
    const registrationId = inserted[0]?.id;
    if (registrationId === undefined) throw new Error("fixture insert returned no row");

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(callbackUpdate(tgId, `reminder24h:confirm:${registrationId}`) as never);

    const catalog = getCatalog("ru");
    expect(textOf(captured[1])).toBe(catalog.withdraw.refusedNotEligible);

    const rows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(rows[0]?.reconfirmedAt).toBeNull();
  });
});

describe("reminder24h:decline -- REQ-026 AC2 second half", () => {
  it("withdraws and frees the seat (reuses withdrawRegistration, identical to /withdraw's own confirm)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, 1);
    const tgId = nextTgId++;
    const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: "member3", lang: "ru" });
    const inserted = await db
      .insert(registrations)
      .values({ eventId, userId: user.id, admission: "admitted", source: "direct" })
      .returning({ id: registrations.id });
    const registrationId = inserted[0]?.id;
    if (registrationId === undefined) throw new Error("fixture insert returned no row");

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(callbackUpdate(tgId, `reminder24h:decline:${registrationId}`) as never);

    const catalog = getCatalog("ru");
    const methods = captured.map((c) => c.method);
    expect(methods).toEqual(["answerCallbackQuery", "sendMessage"]);
    expect(textOf(captured[1])).toBe(catalog.withdraw.confirmedReply);

    const rows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(rows[0]?.admission).toBe("withdrawn");

    const admittedAfter = await db.query.registrations.findMany({
      where: (reg, { eq: eqOp, and: andOp }) => andOp(eqOp(reg.eventId, eventId), eqOp(reg.admission, "admitted")),
    });
    expect(admittedAfter).toHaveLength(0);

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, registrationId));
    const withdrawRows = auditRows.filter((r) => r.action === "registration.withdraw");
    expect(withdrawRows).toHaveLength(1);
  });
});
