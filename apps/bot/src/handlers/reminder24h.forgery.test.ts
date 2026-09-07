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

// docs/agents/test-specs/REQ-026.md — "Forged-callback non-authorization" --
// permanent, committed regression coverage for the property
// SECURITY-REVIEWER verified ad hoc in Step 2c (scratch file, not
// committed). This spec's own construction: own fixture, own tg_id range
// (990_000_000+, distinct from every other file's range in this codebase),
// same real grammY dispatch pattern reminder24h.test.ts uses.

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
      `[reminder24h.forgery.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
let nextTgId = 990_000_000;

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
      code: `chapter-r24h-forge-${chapterSeq}`,
      name: `Chapter R24H Forge ${chapterSeq}`,
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
      title: "Reminder24h Forgery Test Event",
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
  await publishEvent(db, organizer.id, eventId, chapterId, "Reminder24h Forgery Test Event", new Date());
  return eventId;
}

describe("reminder24h:confirm/:decline -- forged callback naming another user's registrationId", () => {
  it("an attacker with no registration of their own cannot reconfirm a victim's registration", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId);
    const victimTgId = nextTgId++;
    const victim = await resolveOrCreateUser(db, { tgId: BigInt(victimTgId), tgUsername: "victim1", lang: "ru" });
    const inserted = await db
      .insert(registrations)
      .values({ eventId, userId: victim.id, admission: "admitted", source: "direct" })
      .returning({ id: registrations.id });
    const victimRegistrationId = inserted[0]?.id;
    if (victimRegistrationId === undefined) throw new Error("fixture insert returned no row");

    const attackerTgId = nextTgId++;
    await resolveOrCreateUser(db, { tgId: BigInt(attackerTgId), tgUsername: "attacker1", lang: "ru" });
    // Attacker has NO registration row of their own at all.

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(callbackUpdate(attackerTgId, `reminder24h:confirm:${victimRegistrationId}`) as never);

    const catalog = getCatalog("ru");
    expect(textOf(captured[1])).toBe(catalog.withdraw.refusedNotFound);

    const victimRow = (await db.select().from(registrations).where(eq(registrations.id, victimRegistrationId)))[0];
    expect(victimRow?.admission).toBe("admitted");
    expect(victimRow?.reconfirmedAt).toBeNull();

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, victimRegistrationId));
    expect(auditRows.filter((r) => r.action === "registration.reconfirm")).toHaveLength(0);
  });

  it("an attacker WITH their own separate registration cannot decline (withdraw) a victim's registration", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, 5);
    const victimTgId = nextTgId++;
    const victim = await resolveOrCreateUser(db, { tgId: BigInt(victimTgId), tgUsername: "victim2", lang: "ru" });
    const victimRow = await db
      .insert(registrations)
      .values({ eventId, userId: victim.id, admission: "admitted", source: "direct" })
      .returning({ id: registrations.id });
    const victimRegistrationId = victimRow[0]?.id;
    if (victimRegistrationId === undefined) throw new Error("fixture insert returned no row");

    const attackerTgId = nextTgId++;
    const attacker = await resolveOrCreateUser(db, { tgId: BigInt(attackerTgId), tgUsername: "attacker2", lang: "ru" });
    const attackerRowInsert = await db
      .insert(registrations)
      .values({ eventId, userId: attacker.id, admission: "admitted", source: "direct" })
      .returning({ id: registrations.id });
    const attackerRegistrationId = attackerRowInsert[0]?.id;
    if (attackerRegistrationId === undefined) throw new Error("fixture insert returned no row");

    const { bot, captured } = makeTestBot();
    // Attacker forges a decline naming the VICTIM's registrationId, not their own.
    await bot.handleUpdate(callbackUpdate(attackerTgId, `reminder24h:decline:${victimRegistrationId}`) as never);

    const catalog = getCatalog("ru");
    expect(textOf(captured[1])).toBe(catalog.withdraw.refusedNotFound);

    const victimAfter = (await db.select().from(registrations).where(eq(registrations.id, victimRegistrationId)))[0];
    expect(victimAfter?.admission).toBe("admitted"); // seat NOT freed

    const attackerAfter = (
      await db.select().from(registrations).where(eq(registrations.id, attackerRegistrationId))
    )[0];
    expect(attackerAfter?.admission).toBe("admitted"); // attacker's own row untouched -- no silent redirect

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, victimRegistrationId));
    expect(auditRows.filter((r) => r.action === "registration.withdraw")).toHaveLength(0);
  });
});

describe("reminder24h:confirm -- REQ-026 AC2 order-of-operations: reconfirm after decline is impossible", () => {
  it("a confirm dispatched on the same registrationId after a prior decline is refused, not silently reconfirmed", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, 5);
    const tgId = nextTgId++;
    const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: "doubletap1", lang: "ru" });
    const inserted = await db
      .insert(registrations)
      .values({ eventId, userId: user.id, admission: "admitted", source: "direct" })
      .returning({ id: registrations.id });
    const registrationId = inserted[0]?.id;
    if (registrationId === undefined) throw new Error("fixture insert returned no row");

    const catalog = getCatalog("ru");

    // First dispatch: decline -- withdraws, frees the seat.
    const declineBot = makeTestBot();
    await declineBot.bot.handleUpdate(callbackUpdate(tgId, `reminder24h:decline:${registrationId}`) as never);
    expect(textOf(declineBot.captured[1])).toBe(catalog.withdraw.confirmedReply);

    const afterDecline = (await db.select().from(registrations).where(eq(registrations.id, registrationId)))[0];
    expect(afterDecline?.admission).toBe("withdrawn");

    // Second dispatch: the SAME user taps confirm on the same (now stale) message.
    const confirmBot = makeTestBot();
    await confirmBot.bot.handleUpdate(callbackUpdate(tgId, `reminder24h:confirm:${registrationId}`) as never);
    expect(textOf(confirmBot.captured[1])).toBe(catalog.withdraw.refusedNotEligible);

    const afterConfirm = (await db.select().from(registrations).where(eq(registrations.id, registrationId)))[0];
    expect(afterConfirm?.admission).toBe("withdrawn");
    expect(afterConfirm?.reconfirmedAt).toBeNull();

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, registrationId));
    expect(auditRows.filter((r) => r.action === "registration.reconfirm")).toHaveLength(0);
  });
});
