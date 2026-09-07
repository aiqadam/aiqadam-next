import { Bot, GrammyError } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { createEvent, publishEvent } from "./event.js";
import { resolveOrCreateUser } from "./user.js";
import { registerForEvent } from "./registration.js";
import { sendLedgeredNotification, type NotificationSender } from "./notification.js";
import { createRateLimitedSender } from "../scheduler/rateLimiter.js";

// docs/agents/design/REQ-025.md / docs/agents/test-specs/REQ-025.md — new,
// committed permanent regression coverage for `sendLedgeredNotification`'s
// S10 truth table (AC3/AC4), the classification API surface, the concurrent-
// call race (both at the same-pool and separate-pool granularity), and
// `createRateLimitedSender`'s 429/backoff behavior (AC6). Same
// infrastructure/skip discipline as handlers/withdraw.test.ts and
// handlers/my.test.ts: real, migrated scratch Postgres
// (apps/bot/docker-compose.yml, TEST_DATABASE_URL).

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT 1 FROM notification_ledger LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[notification.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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

let chapterSeq = 0;
let nextTgId = 1000000900;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(schema.chapters)
    .values({
      code: `chapter-req025-${chapterSeq}`,
      name: `Chapter REQ-025 ${chapterSeq}`,
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
      title: "Notification Test Event",
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
  await publishEvent(db, organizer.id, eventId, chapterId, "Notification Test Event", new Date());
  return eventId;
}

async function seedRegistration(
  dbClient: NodePgDatabase<typeof schema>,
  tgId: number,
  opts: { blocked?: boolean; broadcastOptIn?: boolean } = {},
): Promise<{ userId: string; registrationId: string }> {
  const chapterId = await seedChapter();
  const eventId = await seedPublishedEvent(chapterId);
  const user = await resolveOrCreateUser(dbClient, {
    tgId: BigInt(tgId),
    tgUsername: `u${tgId}`,
    lang: "ru",
  });
  if (opts.blocked !== undefined || opts.broadcastOptIn !== undefined) {
    await dbClient
      .update(schema.users)
      .set({
        ...(opts.blocked !== undefined ? { blocked: opts.blocked } : {}),
        ...(opts.broadcastOptIn !== undefined ? { broadcastOptIn: opts.broadcastOptIn } : {}),
      })
      .where(eq(schema.users.id, user.id));
  }
  const result = await registerForEvent(dbClient, user.id, eventId, new Date());
  if (result.kind !== "admitted" || result.registrationId === undefined) {
    throw new Error(`seedRegistration: registerForEvent did not admit -- ${result.kind}`);
  }
  return { userId: user.id, registrationId: result.registrationId };
}

function makeFakeSender(): { sender: NotificationSender; sentTo: bigint[] } {
  const sentTo: bigint[] = [];
  return {
    sender: {
      async send(tgId) {
        sentTo.push(tgId);
      },
      async sendPhoto(tgId) {
        sentTo.push(tgId);
      },
    },
    sentTo,
  };
}

describe("sendLedgeredNotification -- REQ-025 S10 truth table (AC3/AC4)", () => {
  it("transactional + not-blocked -> sent", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const { userId, registrationId } = await seedRegistration(db, nextTgId++, { blocked: false });
    const { sender, sentTo } = makeFakeSender();
    const outcome = await sendLedgeredNotification({
      db,
      sender,
      registrationId,
      kind: "admission_result",
      classification: "transactional",
      userId,
      composeMessage: () => ({ kind: "text" as const, text: "test" }),
    });
    expect(outcome).toEqual({ kind: "sent" });
    expect(sentTo).toHaveLength(1);
    const rows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "admission_result"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("transactional + blocked -> skipped-blocked", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const { userId, registrationId } = await seedRegistration(db, nextTgId++, { blocked: true });
    const { sender, sentTo } = makeFakeSender();
    const outcome = await sendLedgeredNotification({
      db,
      sender,
      registrationId,
      kind: "admission_result",
      classification: "transactional",
      userId,
      composeMessage: () => ({ kind: "text" as const, text: "test" }),
    });
    expect(outcome).toEqual({ kind: "skipped-blocked" });
    expect(sentTo).toHaveLength(0);
    const rows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "admission_result"),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("marketing + opted-in + not-blocked -> sent", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const { userId, registrationId } = await seedRegistration(db, nextTgId++, {
      blocked: false,
      broadcastOptIn: true,
    });
    const { sender, sentTo } = makeFakeSender();
    const outcome = await sendLedgeredNotification({
      db,
      sender,
      registrationId,
      kind: "feedback_request",
      classification: "marketing",
      userId,
      composeMessage: () => ({ kind: "text" as const, text: "test" }),
    });
    expect(outcome).toEqual({ kind: "sent" });
    expect(sentTo).toHaveLength(1);
    const rows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "feedback_request"),
        ),
      );
    expect(rows).toHaveLength(1);
  });

  it("marketing + opted-out (not blocked) -> skipped-no-broadcast-opt-in", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const { userId, registrationId } = await seedRegistration(db, nextTgId++, {
      blocked: false,
      broadcastOptIn: false,
    });
    const { sender, sentTo } = makeFakeSender();
    const outcome = await sendLedgeredNotification({
      db,
      sender,
      registrationId,
      kind: "feedback_request",
      classification: "marketing",
      userId,
      composeMessage: () => ({ kind: "text" as const, text: "test" }),
    });
    expect(outcome).toEqual({ kind: "skipped-no-broadcast-opt-in" });
    expect(sentTo).toHaveLength(0);
    const rows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "feedback_request"),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("marketing + blocked -> skipped-blocked, even when opted in (ordering: blocked check precedes classification branch)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const { userId, registrationId } = await seedRegistration(db, nextTgId++, {
      blocked: true,
      broadcastOptIn: true,
    });
    const { sender, sentTo } = makeFakeSender();
    const outcome = await sendLedgeredNotification({
      db,
      sender,
      registrationId,
      kind: "feedback_request",
      classification: "marketing",
      userId,
      composeMessage: () => ({ kind: "text" as const, text: "test" }),
    });
    expect(outcome).toEqual({ kind: "skipped-blocked" });
    expect(sentTo).toHaveLength(0);
    const rows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "feedback_request"),
        ),
      );
    expect(rows).toHaveLength(0);
  });

  it("AC3: broadcast_opt_in=false -- transactional sends, marketing does not, for the same user/registration", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const { userId, registrationId } = await seedRegistration(db, nextTgId++, {
      blocked: false,
      broadcastOptIn: false,
    });
    const { sender, sentTo } = makeFakeSender();

    const outcome1 = await sendLedgeredNotification({
      db,
      sender,
      registrationId,
      kind: "admission_result",
      classification: "transactional",
      userId,
      composeMessage: () => ({ kind: "text" as const, text: "test transactional" }),
    });
    expect(outcome1).toEqual({ kind: "sent" });

    const outcome2 = await sendLedgeredNotification({
      db,
      sender,
      registrationId,
      kind: "waitlist_promotion",
      classification: "marketing",
      userId,
      composeMessage: () => ({ kind: "text" as const, text: "test marketing" }),
    });
    expect(outcome2).toEqual({ kind: "skipped-no-broadcast-opt-in" });

    expect(sentTo).toHaveLength(1);
  });
});

describe("sendLedgeredNotification -- concurrent-call race (REQ-025)", () => {
  it("two concurrent calls for the same (registrationId, kind) result in exactly one send", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const { userId, registrationId } = await seedRegistration(db, nextTgId++, { blocked: false });
    const { sender, sentTo } = makeFakeSender();

    const callOnce = () =>
      sendLedgeredNotification({
        db,
        sender,
        registrationId,
        kind: "admission_result",
        classification: "transactional",
        userId,
        composeMessage: () => ({ kind: "text" as const, text: "concurrent test" }),
      });

    const [outcomeA, outcomeB] = await Promise.all([callOnce(), callOnce()]);

    const outcomes = [outcomeA.kind, outcomeB.kind].sort();
    expect(outcomes).toEqual(["sent", "skipped-already-sent"]);
    expect(sentTo.length).toBe(1);
    const ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "admission_result"),
        ),
      );
    expect(ledgerRows.length).toBe(1);
  });

  it("two concurrent calls from two SEPARATE connection pools still result in exactly one send", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const { userId, registrationId } = await seedRegistration(db, nextTgId++, { blocked: false });
    const poolB = new Pool({ connectionString: TEST_DATABASE_URL });
    const dbB = drizzle(poolB, { schema });
    const { sender: senderA, sentTo: sentToA } = makeFakeSender();
    const { sender: senderB, sentTo: sentToB } = makeFakeSender();

    try {
      const [outcomeA, outcomeB] = await Promise.all([
        sendLedgeredNotification({
          db,
          sender: senderA,
          registrationId,
          kind: "waitlist_promotion",
          classification: "transactional",
          userId,
          composeMessage: () => ({ kind: "text" as const, text: "pool A" }),
        }),
        sendLedgeredNotification({
          db: dbB,
          sender: senderB,
          registrationId,
          kind: "waitlist_promotion",
          classification: "transactional",
          userId,
          composeMessage: () => ({ kind: "text" as const, text: "pool B" }),
        }),
      ]);

      const outcomes = [outcomeA.kind, outcomeB.kind].sort();
      expect(outcomes).toEqual(["sent", "skipped-already-sent"]);
      expect(sentToA.length + sentToB.length).toBe(1);
    } finally {
      await poolB.end();
    }
  });
});

// REQ-025.md §5 -- 429/backoff-retry behavior of createRateLimitedSender,
// against a real grammY Bot with a stubbed api.config.use transformer (same
// interception point handlers/*.test.ts already uses).

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

describe("createRateLimitedSender -- REQ-025 AC6: 429 backoff-and-retry", () => {
  it("a 429 on the first attempt is retried and the message is delivered exactly once", async () => {
    const bot = new Bot("000000:TEST-TOKEN-NOT-REAL", { botInfo: FAKE_BOT_INFO });
    let callCount = 0;
    const sendMessageCalls: unknown[] = [];
    bot.api.config.use(async (_prev, method, payload) => {
      if (method !== "sendMessage") {
        return { ok: true, result: true } as never;
      }
      sendMessageCalls.push(payload);
      callCount += 1;
      if (callCount === 1) {
        return {
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 0",
          parameters: { retry_after: 0 },
        } as never;
      }
      return {
        ok: true,
        result: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: 0, type: "private" } },
      } as never;
    });

    const sender = createRateLimitedSender(bot, {
      maxMessagesPerSecond: 25,
      maxRetries: 5,
      initialBackoffMs: 1000,
      maxBackoffMs: 30000,
    });

    await sender.send(123456789n, "hello");

    expect(callCount).toBe(2);
    expect(sendMessageCalls.length).toBe(2);
  });

  it("exhaustion: a persistent 429 causes send() to reject after exactly maxRetries attempts", async () => {
    const bot = new Bot("000000:TEST-TOKEN-NOT-REAL", { botInfo: FAKE_BOT_INFO });
    let callCount = 0;
    bot.api.config.use(async (_prev, method) => {
      if (method !== "sendMessage") {
        return { ok: true, result: true } as never;
      }
      callCount += 1;
      return {
        ok: false,
        error_code: 429,
        description: "Too Many Requests: retry after 0",
        parameters: { retry_after: 0 },
      } as never;
    });

    const sender = createRateLimitedSender(bot, {
      maxMessagesPerSecond: 25,
      maxRetries: 2,
      initialBackoffMs: 10,
      maxBackoffMs: 100,
    });

    await expect(sender.send(123456789n, "hello")).rejects.toBeInstanceOf(GrammyError);
    expect(callCount).toBe(2);
  });

  it("a non-429 error is not retried -- send() rejects immediately with exactly one attempt", async () => {
    const bot = new Bot("000000:TEST-TOKEN-NOT-REAL", { botInfo: FAKE_BOT_INFO });
    let callCount = 0;
    bot.api.config.use(async (_prev, method) => {
      if (method !== "sendMessage") {
        return { ok: true, result: true } as never;
      }
      callCount += 1;
      return {
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was blocked by the user",
      } as never;
    });

    const sender = createRateLimitedSender(bot, {
      maxMessagesPerSecond: 25,
      maxRetries: 5,
      initialBackoffMs: 1000,
      maxBackoffMs: 30000,
    });

    await expect(sender.send(123456789n, "hello")).rejects.toBeInstanceOf(GrammyError);
    expect(callCount).toBe(1);
  });
});
