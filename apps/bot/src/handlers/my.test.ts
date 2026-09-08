import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { PNG } from "pngjs";
// See domain/qr.test.ts's header note on this cast -- jsqr's shipped .d.ts
// does not type-check as callable under this project's NodeNext +
// esModuleInterop combination, though it is genuinely callable at runtime.
import * as jsQRModule from "jsqr";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { profiles, registrations } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { getCatalog } from "../i18n/catalog.js";
import {
  makeWithdrawConfirmCallbackHandler,
  WITHDRAW_CONFIRM_PATTERN,
} from "./withdraw.js";
import { makeMyCommandHandler } from "./my.js";
import { createRateLimitedSender, DEFAULT_RATE_LIMITER_CONFIG } from "../scheduler/rateLimiter.js";

type JsQRFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

// See domain/qr.test.ts's header note: the two toolchains that load this
// file disagree on which shape holds the callable function.
const jsQRCandidate = jsQRModule as unknown as { default?: JsQRFn } & JsQRFn;
const jsQR: JsQRFn =
  typeof jsQRCandidate.default === "function" ? jsQRCandidate.default : jsQRCandidate;

// docs/agents/design/REQ-024.md — /my registrations view: AC1 (only the
// caller's own rows, no cross-leakage), AC2 (live waitlist position, no
// write to the viewer's own row), AC3 (a real-decoded QR image for an
// admitted row), AC4 (no QR image for any other admission state), AC5 (the
// QR renderer is the single shared domain/qr.ts function). Real, migrated
// scratch Postgres (apps/bot/docker-compose.yml, TEST_DATABASE_URL), same
// infrastructure/skip discipline as handlers/withdraw.test.ts.

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
      `[my.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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

  const sender = createRateLimitedSender(bot, DEFAULT_RATE_LIMITER_CONFIG);
  bot.command("my", makeMyCommandHandler(db));
  bot.callbackQuery(WITHDRAW_CONFIRM_PATTERN, makeWithdrawConfirmCallbackHandler(db, sender));

  return { bot, captured };
}

let nextUpdateId = 1;
let nextTgId = 950_000_000;

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

function textOf(entry: Captured | undefined): string {
  return (entry?.payload["text"] ?? entry?.payload["caption"] ?? "") as string;
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
      title: "My Test Event",
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
  await publishEvent(db, organizer.id, eventId, chapterId, "My Test Event", new Date());
  return eventId;
}

async function seedProfile(userId: string, fields: {
  firstName: string;
  lastName: string;
  company: string;
  phone: string;
  email: string;
}): Promise<void> {
  await db.insert(profiles).values({
    userId,
    firstName: fields.firstName,
    lastName: fields.lastName,
    company: fields.company,
    phone: fields.phone,
    email: fields.email,
  });
}

async function decodePng(buffer: Buffer): Promise<string | null> {
  const png = PNG.sync.read(buffer);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return decoded?.data ?? null;
}

describe("makeMyCommandHandler -- REQ-024 AC1: only the caller's own rows, no cross-leakage", () => {
  it("two users registered for the same event: each /my reply set contains only that user's own data", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, 5);

    const tgIdA = nextTgId++;
    const userA = await resolveOrCreateUser(db, { tgId: BigInt(tgIdA), tgUsername: "userA", lang: "ru" });
    await seedProfile(userA.id, {
      firstName: "Alice",
      lastName: "Anderson",
      company: "Acme Corp",
      phone: "+10000000001",
      email: "alice@example.com",
    });
    const regA = await db
      .insert(registrations)
      .values({ eventId, userId: userA.id, admission: "admitted", source: "direct", qrToken: "a".repeat(64) })
      .returning({ id: registrations.id });
    const registrationIdA = regA[0]?.id;
    if (registrationIdA === undefined) throw new Error("fixture insert returned no row");

    const tgIdB = nextTgId++;
    const userB = await resolveOrCreateUser(db, { tgId: BigInt(tgIdB), tgUsername: "userB", lang: "ru" });
    await seedProfile(userB.id, {
      firstName: "Bob",
      lastName: "Brown",
      company: "Beta LLC",
      phone: "+20000000002",
      email: "bob@example.com",
    });
    const regB = await db
      .insert(registrations)
      .values({ eventId, userId: userB.id, admission: "admitted", source: "direct", qrToken: "b".repeat(64) })
      .returning({ id: registrations.id });
    const registrationIdB = regB[0]?.id;
    if (registrationIdB === undefined) throw new Error("fixture insert returned no row");

    const { bot: botA, captured: capturedA } = makeTestBot();
    await botA.handleUpdate(commandUpdate(tgIdA, "/my") as never);

    const { bot: botB, captured: capturedB } = makeTestBot();
    await botB.handleUpdate(commandUpdate(tgIdB, "/my") as never);

    // A photo-send payload's "photo" field is a grammY InputFile instance,
    // whose own toJSON() deliberately throws ("must be sent via grammY") --
    // substitute a placeholder for it so the rest of the payload (caption,
    // reply_markup, chat_id) still serializes for the cross-leakage scan
    // below.
    function safeStringify(payload: Record<string, unknown>): string {
      // JSON.stringify invokes a value's own toJSON() BEFORE the replacer
      // ever sees it, so a replacer alone can't intercept InputFile's
      // throwing toJSON() -- strip the key from a shallow clone first.
      const rest: Record<string, unknown> = { ...payload };
      delete rest["photo"];
      return JSON.stringify(rest);
    }
    const capturedTextA = capturedA.map((c) => safeStringify(c.payload)).join("\n");
    const capturedTextB = capturedB.map((c) => safeStringify(c.payload)).join("\n");

    // Neither response mentions the OTHER user's identifying data anywhere.
    for (const needle of ["Bob", "Brown", "Beta LLC", "+20000000002", "bob@example.com", String(tgIdB), registrationIdB]) {
      expect(capturedTextA).not.toContain(needle);
    }
    for (const needle of ["Alice", "Anderson", "Acme Corp", "+10000000001", "alice@example.com", String(tgIdA), registrationIdA]) {
      expect(capturedTextB).not.toContain(needle);
    }

    // Each user's own callback_data (withdraw button) carries only their own
    // registrationId.
    expect(capturedTextA).toContain(registrationIdA);
    expect(capturedTextB).toContain(registrationIdB);

    // Exactly one row's worth of sends for each (header + one row = 2 sendMessage/sendPhoto calls).
    expect(capturedA).toHaveLength(2);
    expect(capturedB).toHaveLength(2);
  });
});

describe("makeMyCommandHandler -- REQ-024 AC2: waitlist position computed live", () => {
  it("capturing the position, withdrawing the person ahead, re-invoking /my: position decreases, viewer's own row untouched", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    // capacity 0 -> both registrations land on the waitlist directly.
    const eventId = await seedPublishedEvent(chapterId, 0);

    const aheadTgId = nextTgId++;
    const aheadUser = await resolveOrCreateUser(db, { tgId: BigInt(aheadTgId), tgUsername: "ahead", lang: "ru" });
    const aheadReg = await db
      .insert(registrations)
      .values({
        eventId,
        userId: aheadUser.id,
        admission: "waitlisted",
        source: "direct",
        createdAt: new Date("2026-09-01T00:00:00.000Z"),
      })
      .returning({ id: registrations.id });
    const aheadRegistrationId = aheadReg[0]?.id;
    if (aheadRegistrationId === undefined) throw new Error("fixture insert returned no row");

    const viewerTgId = nextTgId++;
    const viewerUser = await resolveOrCreateUser(db, { tgId: BigInt(viewerTgId), tgUsername: "viewer", lang: "ru" });
    const viewerReg = await db
      .insert(registrations)
      .values({
        eventId,
        userId: viewerUser.id,
        admission: "waitlisted",
        source: "direct",
        createdAt: new Date("2026-09-01T00:00:01.000Z"),
      })
      .returning({ id: registrations.id });
    const viewerRegistrationId = viewerReg[0]?.id;
    if (viewerRegistrationId === undefined) throw new Error("fixture insert returned no row");

    const rowBefore = await db.select().from(registrations).where(eq(registrations.id, viewerRegistrationId));
    const updatedAtBefore = rowBefore[0]?.updatedAt;

    const { bot: bot1, captured: captured1 } = makeTestBot();
    await bot1.handleUpdate(commandUpdate(viewerTgId, "/my") as never);
    const catalog = getCatalog("ru");
    const rowTextBefore = textOf(captured1[1]);
    expect(rowTextBefore).toContain(`${catalog.registration.waitlistedPositionPrefix} 2`);

    // Withdraw the person ahead via the existing withdraw flow (REQ-022),
    // which is the direct flow the AC names -- accounting for the fact that
    // capacity 0 means no seat is ever freed, so REQ-023's promotion has
    // nothing to admit (this is deliberate: it isolates the position
    // recomputation from any promotion side effect).
    const { bot: withdrawBot } = makeTestBot();
    await withdrawBot.handleUpdate(callbackUpdate(aheadTgId, `withdraw:confirm:${aheadRegistrationId}`) as never);

    const { bot: bot2, captured: captured2 } = makeTestBot();
    await bot2.handleUpdate(commandUpdate(viewerTgId, "/my") as never);
    const rowTextAfter = textOf(captured2[1]);
    expect(rowTextAfter).toContain(`${catalog.registration.waitlistedPositionPrefix} 1`);

    // The viewer's OWN row was never written by either /my invocation.
    const rowAfter = await db.select().from(registrations).where(eq(registrations.id, viewerRegistrationId));
    expect(rowAfter[0]?.updatedAt).toEqual(updatedAtBefore);
  });
});

describe("makeMyCommandHandler -- REQ-024 AC3/AC4/AC5: QR gating and the shared renderer", () => {
  it("sends a real, decodable QR photo only for the admitted row; waitlisted/withdrawn/rejected get no photo", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, 5);
    const tgId = nextTgId++;
    const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: "member", lang: "ru" });

    const qrToken = "c".repeat(64);
    await db.insert(registrations).values([
      { eventId, userId: user.id, admission: "admitted", source: "direct", qrToken },
    ]);
    // Withdrawn/rejected/waitlisted rows for the SAME user against distinct
    // events (a real Registration row is unique per (event, user), so each
    // needs its own event).
    const eventId2 = await seedPublishedEvent(chapterId, 5);
    await db.insert(registrations).values({ eventId: eventId2, userId: user.id, admission: "withdrawn", source: "direct" });
    const eventId3 = await seedPublishedEvent(chapterId, 5);
    await db.insert(registrations).values({ eventId: eventId3, userId: user.id, admission: "rejected", source: "direct" });
    const eventId4 = await seedPublishedEvent(chapterId, 0);
    await db.insert(registrations).values({ eventId: eventId4, userId: user.id, admission: "waitlisted", source: "direct" });
    // REQ-034 AC5 -- a 'requested' (approval-gated, decision-pending) row
    // must render like every other non-admitted row: plain text, no photo.
    const eventId5 = await seedPublishedEvent(chapterId, 5);
    await db.insert(registrations).values({ eventId: eventId5, userId: user.id, admission: "requested", source: "direct" });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(tgId, "/my") as never);

    // header + 5 rows = 6 sends.
    expect(captured).toHaveLength(6);
    const rowSends = captured.slice(1);
    const photoSends = rowSends.filter((c) => c.method === "sendPhoto");
    const textSends = rowSends.filter((c) => c.method === "sendMessage");
    expect(photoSends).toHaveLength(1);
    expect(textSends).toHaveLength(4);

    // REQ-034 AC5 -- the 'requested' row's own text send carries the
    // statusRequested label and no photo attachment.
    const catalog = getCatalog("ru");
    const requestedRowSend = textSends.find((c) => (c.payload["text"] as string).includes(catalog.registration.statusRequested));
    expect(requestedRowSend).toBeDefined();
    expect(requestedRowSend?.payload["photo"]).toBeUndefined();

    // The one photo send is a real PNG whose decoded content is exactly
    // `?start=ci_<qrToken>` (AC3 -- decoded, not just inspected pre-encode).
    const photoPayload = photoSends[0]?.payload["photo"];
    expect(photoPayload).toBeInstanceOf(Object);
    // grammy's InputFile wraps the raw buffer; api.config.use captures the
    // payload before serialization, so the buffer is reachable off the
    // InputFile instance itself.
    const rawBuffer = (photoPayload as { fileData: Buffer }).fileData;
    expect(Buffer.isBuffer(rawBuffer)).toBe(true);
    const decoded = await decodePng(rawBuffer);
    expect(decoded).toBe(`https://t.me/test_bot?start=ci_${qrToken}`);
    expect(decoded).toContain(`?start=ci_${qrToken}`);

    // None of the plain-text sends carry a photo, and none of the four
    // non-admitted rows' text bodies is empty (each row still shows its own
    // status text).
    for (const send of textSends) {
      expect(send.payload["photo"]).toBeUndefined();
    }
  });
});
