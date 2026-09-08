import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { chapters, profiles, registrations, users, venues } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { recordConsent } from "../domain/consent.js";
import { getInviteCodeById, issueBulkInviteCode } from "../domain/inviteCode.js";
import { makeConsentCallbackHandler, makeStartHandler } from "./start.js";
import { makeRedeemCommandHandler } from "./registration.js";

// docs/agents/design/REQ-038.md -- AC1 (both entry points), AC9 (consent gate on the `i_`
// deep link). Real grammY dispatch (bot.handleUpdate) against a live scratch Postgres, same
// infrastructure/skip discipline as handlers/start.test.ts / handlers/organizerRequests.db.test.ts.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT used_count FROM invite_codes LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[redeem.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
    "TRUNCATE notification_ledger, audit_log, invite_codes, registrations, events, venues, profiles, users, chapters CASCADE",
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
      result: { message_id: captured.length, date: Math.floor(Date.now() / 1000), chat: { id: 0, type: "private" } },
    } as never;
  });

  bot.command("start", makeStartHandler(db));
  bot.command("redeem", makeRedeemCommandHandler(db));
  bot.callbackQuery(/^consent:agree(?::.+)?$/, makeConsentCallbackHandler(db));

  return { bot, captured };
}

let nextUpdateId = 1;
let nextTgId = 1_051_000_000;

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

let chapterSeq = 0;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(chapters)
    .values({ code: `req038h-chapter-${chapterSeq}`, name: `REQ-038 Handler Chapter ${chapterSeq}`, timezone: "Asia/Tashkent", defaultLang: "en", active: true })
    .returning({ id: chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedVenue(chapterId: string): Promise<string> {
  const rows = await db
    .insert(venues)
    .values({ chapterId, name: "REQ-038 Handler Venue", address: "1 Test St", capacity: 500 })
    .returning({ id: venues.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedVenue: no row returned");
  return row.id;
}

async function seedPublishedEvent(chapterId: string, capacity: number): Promise<{ id: string; title: string; organizerId: string }> {
  const venueId = await seedVenue(chapterId);
  const organizerTgId = nextTgId++;
  const organizer = await resolveOrCreateUser(db, { tgId: BigInt(organizerTgId), tgUsername: `u${organizerTgId}`, lang: "en" });
  const title = `REQ-038 Handler Event ${Date.now()}-${Math.random()}`;
  const eventId = await createEvent(
    db,
    organizer.id,
    chapterId,
    {
      title,
      description: "A test event",
      format: "meetup",
      venueId,
      startsAt: new Date("2026-10-01T18:00:00Z"),
      endsAt: new Date("2026-10-01T20:00:00Z"),
      registrationClosesAt: null,
      capacity,
      requiresInvite: true,
      requiresApproval: false,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, title, new Date());
  return { id: eventId, title, organizerId: organizer.id };
}

async function seedConsentedUser(): Promise<{ id: string; tgId: number }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `u${tgId}`, lang: "en" });
  await recordConsent(db, user.id, new Date());
  return { id: user.id, tgId };
}

async function registrationRow(eventId: string, userId: string) {
  const rows = await db
    .select()
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)));
  return rows[0] ?? null;
}

async function profileCount(userId: string): Promise<number> {
  const rows = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId));
  return rows.length;
}

describe("AC1 -- both entry points admit, set invite_code_id, increment used_count by exactly one", () => {
  it("i_<code> deep link (/start i_<code>), already-consented user: admitted, invite_code_id set, used_count == 1", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const issued = await issueBulkInviteCode(db, event.organizerId, event.id, 5, new Date("2027-01-01T00:00:00Z"), new Date());
    const redeemer = await seedConsentedUser();

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(redeemer.tgId, `/start i_${issued.code}`) as never);

    expect(captured.some((c) => c.method === "sendMessage")).toBe(true);
    const row = await registrationRow(event.id, redeemer.id);
    expect(row?.admission).toBe("admitted");
    expect(row?.inviteCodeId).toBe(issued.id);
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(1);
  });

  it("typed /redeem <event_id> <code>, already-consented user: admitted, invite_code_id set, used_count == 1", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const issued = await issueBulkInviteCode(db, event.organizerId, event.id, 5, new Date("2027-01-01T00:00:00Z"), new Date());
    const redeemer = await seedConsentedUser();

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(redeemer.tgId, `/redeem ${event.id} ${issued.code}`) as never);

    expect(captured.some((c) => c.method === "sendMessage")).toBe(true);
    const row = await registrationRow(event.id, redeemer.id);
    expect(row?.admission).toBe("admitted");
    expect(row?.inviteCodeId).toBe(issued.id);
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(1);
  });
});

describe("AC9 -- a redeemer without consent is taken through the consent flow; no row is written before consent, and none exists if consent is never given", () => {
  it("unconsented redeemer, i_<code> deep link: consent prompt shown, zero rows written; tapping consent:agree resumes and completes the redemption", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const issued = await issueBulkInviteCode(db, event.organizerId, event.id, 5, new Date("2027-01-01T00:00:00Z"), new Date());
    const tgId = nextTgId++;

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(tgId, `/start i_${issued.code}`) as never);

    // Consent prompt shown; nothing about the redemption has run yet.
    expect(captured.some((c) => c.method === "sendMessage")).toBe(true);
    const redeemer = await db.select().from(users).where(eq(users.tgId, BigInt(tgId)));
    const redeemerId = redeemer[0]!.id;
    expect(await registrationRow(event.id, redeemerId)).toBeNull();
    expect(await profileCount(redeemerId)).toBe(0);
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(0);

    // Tap consent:agree with the deferred payload -- resumes and completes.
    captured.length = 0;
    await bot.handleUpdate(consentAgreeCallbackUpdate(tgId, `i_${issued.code}`) as never);

    const row = await registrationRow(event.id, redeemerId);
    expect(row?.admission).toBe("admitted");
    expect(row?.inviteCodeId).toBe(issued.id);
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(1);
  });

  it("unconsented redeemer who NEVER taps consent:agree: zero profiles rows, zero registration rows, used_count unchanged, despite holding a valid code", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    // This codebase's consent flow (domain/consent.ts, handlers/start.ts) has
    // no explicit "decline" affordance -- only `consent:agree`. AC9's
    // "declining" is therefore exercised here as its exact operational
    // meaning in this codebase: the consent prompt is shown, and the user
    // simply never taps it -- the standing state stays "never consented"
    // indefinitely, and no downstream write ever happens for them.
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const issued = await issueBulkInviteCode(db, event.organizerId, event.id, 5, new Date("2027-01-01T00:00:00Z"), new Date());
    const tgId = nextTgId++;

    const { bot } = makeTestBot();
    await bot.handleUpdate(commandUpdate(tgId, `/start i_${issued.code}`) as never);

    const redeemer = await db.select().from(users).where(eq(users.tgId, BigInt(tgId)));
    const redeemerId = redeemer[0]!.id;
    expect(redeemer[0]!.consentPdAt).toBeNull();
    expect(await registrationRow(event.id, redeemerId)).toBeNull();
    expect(await profileCount(redeemerId)).toBe(0);
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(0);

    // An unrelated later update for the same user (a bare, no-payload /start)
    // confirms the "never consented" state persists rather than having been
    // implicitly resolved some other way.
    await bot.handleUpdate(commandUpdate(tgId, "/start") as never);
    const redeemerAfter = await db.select().from(users).where(eq(users.tgId, BigInt(tgId)));
    expect(redeemerAfter[0]!.consentPdAt).toBeNull();
    expect(await registrationRow(event.id, redeemerId)).toBeNull();
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(0);
  });
});
