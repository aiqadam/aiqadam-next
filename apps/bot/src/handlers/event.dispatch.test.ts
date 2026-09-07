import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { registrations } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { registerForEvent, withdrawRegistration } from "../domain/registration.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { getCatalog } from "../i18n/catalog.js";
import { makeEventCancelHandler, notifyNonWithdrawnRegistrants } from "./event.js";
import { createRateLimitedSender, DEFAULT_RATE_LIMITER_CONFIG } from "../scheduler/rateLimiter.js";

// docs/agents/test-specs/REQ-027.md — AC1-AC5 plus a non-organizer-refusal
// case, all driven through a REAL bot.handleUpdate() dispatch of
// /event_cancel (the first committed test anywhere in this repo to dispatch
// makeEventCancelHandler through grammY at all -- BACKEND-DEV's own
// event.db.test.ts calls notifyNonWithdrawnRegistrants directly). Same
// infrastructure/skip discipline as withdraw.test.ts.

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
      `[event.dispatch.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
  bot.command("event_cancel", makeEventCancelHandler(db, sender));

  return { bot, captured };
}

let nextUpdateId = 1;
// REQ-027 spec: 960_000_000+ -- distinct from every other range in this
// codebase (event.db.test.ts 980_000_000+, reminder24h*.test.ts/my.test.ts
// 950_000_000+/990_000_000+, reminderJobs.db.test.ts 970_000_000+,
// withdraw.test.ts/start.test.ts 900_000_000+, registration.test.ts
// 800_000_000+, notification.test.ts 1000000900+).
let nextTgId = 960_000_000;

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

function textOf(entry: Captured | undefined): string | undefined {
  return entry?.payload["text"] as string | undefined;
}

function chatIdOf(entry: Captured | undefined): string | undefined {
  const raw = entry?.payload["chat_id"];
  return raw === undefined ? undefined : String(raw);
}

let chapterSeq = 0;

async function seedChapter(defaultLang: "ru" | "en" = "ru"): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(schema.chapters)
    .values({
      code: `chapter-req027-dispatch-${chapterSeq}`,
      name: `Chapter REQ-027 Dispatch ${chapterSeq}`,
      timezone: "Asia/Tashkent",
      defaultLang,
      active: true,
    })
    .returning({ id: schema.chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedOrganizer(chapterId: string): Promise<{ userId: string; tgId: number }> {
  const tgId = nextTgId++;
  const organizer = await resolveOrCreateUser(db, {
    tgId: BigInt(tgId),
    tgUsername: `organizer${tgId}`,
    lang: "ru",
  });
  // users.role defaults to "member" with no chapter_id -- makeEventCancelHandler
  // calls requireOrganizerForChapter, which needs role="organizer" (or
  // "owner") AND (for "organizer") a matching chapterId to authorize, per
  // domain/eventAuthorization.ts's checkOrganizerForChapter.
  await db
    .update(schema.users)
    .set({ role: "organizer", chapterId })
    .where(eq(schema.users.id, organizer.id));
  return { userId: organizer.id, tgId };
}

interface SeedEventOptions {
  capacity: number;
  title?: string;
}

async function seedPublishedEvent(
  chapterId: string,
  organizerId: string,
  opts: SeedEventOptions,
): Promise<{ eventId: string; title: string }> {
  const title = opts.title ?? "REQ-027 Dispatch Test Event";
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
      endsAt: new Date("2026-09-10T20:00:00Z"),
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

async function seedRegistrant(
  eventId: string,
  registerAt: Date,
  opts: { broadcastOptIn?: boolean; lang?: "ru" | "en" } = {},
): Promise<{ userId: string; tgId: number; registrationId: string; admission: string }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, {
    tgId: BigInt(tgId),
    tgUsername: `member${tgId}`,
    lang: opts.lang ?? "ru",
  });
  if (opts.broadcastOptIn !== undefined) {
    await db
      .update(schema.users)
      .set({ broadcastOptIn: opts.broadcastOptIn })
      .where(eq(schema.users.id, user.id));
  }
  const result = await registerForEvent(db, user.id, eventId, registerAt);
  if (result.registrationId === undefined) {
    throw new Error(`seedRegistrant: registerForEvent did not create a row -- ${result.kind}`);
  }
  return { userId: user.id, tgId, registrationId: result.registrationId, admission: result.kind };
}

describe("makeEventCancelHandler -- REQ-027 AC1: real /event_cancel dispatch, 2 admitted + 5 waitlisted + 2 withdrawn", () => {
  it("exactly 7 registrant notifications, none to either withdrawn registrant, plus the organizer's own confirmation last", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 2 });

    const registerAt = new Date("2026-09-01T00:00:00Z");
    const admitted = [
      await seedRegistrant(eventId, registerAt),
      await seedRegistrant(eventId, registerAt),
    ];
    const waitlisted = [
      await seedRegistrant(eventId, registerAt),
      await seedRegistrant(eventId, registerAt),
      await seedRegistrant(eventId, registerAt),
      await seedRegistrant(eventId, registerAt),
      await seedRegistrant(eventId, registerAt),
    ];
    for (const reg of admitted) {
      expect(reg.admission).toBe("admitted");
    }
    for (const reg of waitlisted) {
      expect(reg.admission).toBe("waitlisted");
    }

    const toWithdraw1 = await seedRegistrant(eventId, registerAt);
    const toWithdraw2 = await seedRegistrant(eventId, registerAt);
    expect(toWithdraw1.admission).toBe("waitlisted");
    expect(toWithdraw2.admission).toBe("waitlisted");
    await withdrawRegistration(db, toWithdraw1.registrationId, toWithdraw1.userId, new Date("2026-09-01T01:00:00Z"));
    await withdrawRegistration(db, toWithdraw2.registrationId, toWithdraw2.userId, new Date("2026-09-01T01:00:00Z"));

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(organizer.tgId, `/event_cancel ${eventId}`) as never);

    const sendMessageCalls = captured.filter((c) => c.method === "sendMessage");
    expect(sendMessageCalls).toHaveLength(8);

    const nonWithdrawnTgIds = new Set([...admitted, ...waitlisted].map((r) => r.tgId.toString()));
    const withdrawnTgIds = new Set([toWithdraw1.tgId.toString(), toWithdraw2.tgId.toString()]);
    const registrantSends = sendMessageCalls.filter((c) => nonWithdrawnTgIds.has(chatIdOf(c) ?? ""));
    expect(registrantSends).toHaveLength(7);
    const sendsToWithdrawn = sendMessageCalls.filter((c) => withdrawnTgIds.has(chatIdOf(c) ?? ""));
    expect(sendsToWithdrawn).toHaveLength(0);

    // The organizer's own confirmation is the LAST captured sendMessage call.
    const catalog = getCatalog("ru");
    const lastCall = sendMessageCalls[sendMessageCalls.length - 1];
    expect(chatIdOf(lastCall)).toBe(organizer.tgId.toString());
    expect(textOf(lastCall)).toBe(`${catalog.event.cancelSuccessPrefix} ${title}`);

    const ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(eq(schema.notificationLedger.kind, "event_cancelled"));
    expect(ledgerRows).toHaveLength(7);
    const nonWithdrawnRegistrationIds = new Set(
      [...admitted, ...waitlisted].map((r) => r.registrationId),
    );
    for (const row of ledgerRows) {
      expect(nonWithdrawnRegistrationIds.has(row.registrationId)).toBe(true);
    }

    const eventRows = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
    expect(eventRows[0]?.status).toBe("cancelled");
  });
});

describe("makeEventCancelHandler -- REQ-027 AC2: batch re-run after a real dispatch adds no messages", () => {
  it("first dispatch sends 3 registrant notifications + 1 organizer reply; a direct second batch run adds zero", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 5 });

    const registerAt = new Date("2026-09-01T00:00:00Z");
    const regs = [
      await seedRegistrant(eventId, registerAt),
      await seedRegistrant(eventId, registerAt),
      await seedRegistrant(eventId, registerAt),
    ];
    for (const reg of regs) {
      expect(reg.admission).toBe("admitted");
    }

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(organizer.tgId, `/event_cancel ${eventId}`) as never);

    const sendMessageCalls = captured.filter((c) => c.method === "sendMessage");
    expect(sendMessageCalls).toHaveLength(4);

    const ledgerAfterFirst = await db
      .select()
      .from(schema.notificationLedger)
      .where(eq(schema.notificationLedger.kind, "event_cancelled"));
    expect(ledgerAfterFirst).toHaveLength(3);

    // Second run: models "the batch is re-run by some means other than a
    // second command dispatch" -- a fresh sender2 capturing its own array.
    const sent2: unknown[] = [];
    const sender2 = {
      async send(tgId: bigint, text: string) {
        sent2.push({ tgId, text });
      },
      async sendPhoto() {
        throw new Error("notifyNonWithdrawnRegistrants never sends a photo");
      },
    };
    await notifyNonWithdrawnRegistrants(db, sender2, eventId, title);
    expect(sent2).toHaveLength(0);

    const ledgerAfterSecond = await db
      .select()
      .from(schema.notificationLedger)
      .where(eq(schema.notificationLedger.kind, "event_cancelled"));
    expect(ledgerAfterSecond).toHaveLength(3);
  });
});

describe("makeEventCancelHandler -- REQ-027 AC3: broadcast_opt_in=false still receives it, via real dispatch", () => {
  it("both the opted-out and opted-in registrant receive the cancellation", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 5 });

    const registerAt = new Date("2026-09-01T00:00:00Z");
    const regA = await seedRegistrant(eventId, registerAt, { broadcastOptIn: false });
    const regB = await seedRegistrant(eventId, registerAt);

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(organizer.tgId, `/event_cancel ${eventId}`) as never);

    const sendMessageCalls = captured.filter((c) => c.method === "sendMessage");
    const chatIds = sendMessageCalls.map((c) => chatIdOf(c));
    expect(chatIds).toContain(regA.tgId.toString());
    expect(chatIds).toContain(regB.tgId.toString());
    // 2 registrant notifications + 1 organizer confirmation.
    expect(sendMessageCalls).toHaveLength(3);

    const ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(eq(schema.notificationLedger.kind, "event_cancelled"));
    expect(ledgerRows).toHaveLength(2);
    const registrationIds = new Set([regA.registrationId, regB.registrationId]);
    for (const row of ledgerRows) {
      expect(registrationIds.has(row.registrationId)).toBe(true);
    }
  });
});

describe("makeEventCancelHandler -- REQ-027 AC4: registrations rows survive cancellation unchanged, via real dispatch", () => {
  it("full before/after row set is deep-equal; only events.status changes", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 2 });

    const registerAt = new Date("2026-09-01T00:00:00Z");
    const admitted1 = await seedRegistrant(eventId, registerAt);
    const admitted2 = await seedRegistrant(eventId, registerAt);
    const waitlisted1 = await seedRegistrant(eventId, registerAt);
    const waitlisted2 = await seedRegistrant(eventId, registerAt);
    const toWithdraw = await seedRegistrant(eventId, registerAt);
    expect(admitted1.admission).toBe("admitted");
    expect(admitted2.admission).toBe("admitted");
    expect(waitlisted1.admission).toBe("waitlisted");
    expect(waitlisted2.admission).toBe("waitlisted");
    await withdrawRegistration(db, toWithdraw.registrationId, toWithdraw.userId, new Date("2026-09-01T01:00:00Z"));

    const beforeRows = await db.select().from(registrations).where(eq(registrations.eventId, eventId));
    const sortById = (rows: typeof beforeRows) =>
      [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const beforeSorted = sortById(beforeRows);
    expect(beforeSorted).toHaveLength(5);

    const { bot } = makeTestBot();
    await bot.handleUpdate(commandUpdate(organizer.tgId, `/event_cancel ${eventId}`) as never);

    const afterRows = await db.select().from(registrations).where(eq(registrations.eventId, eventId));
    const afterSorted = sortById(afterRows);

    expect(afterSorted).toHaveLength(5);
    expect(afterSorted).toEqual(beforeSorted);

    const admissionById = new Map(afterSorted.map((r) => [r.id, r.admission]));
    expect(admissionById.get(admitted1.registrationId)).toBe("admitted");
    expect(admissionById.get(admitted2.registrationId)).toBe("admitted");
    expect(admissionById.get(waitlisted1.registrationId)).toBe("waitlisted");
    expect(admissionById.get(waitlisted2.registrationId)).toBe("waitlisted");
    expect(admissionById.get(toWithdraw.registrationId)).toBe("withdrawn");

    const eventRows = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
    expect(eventRows[0]?.status).toBe("cancelled");
  });
});

describe("makeEventCancelHandler -- REQ-027 AC5: onward-path message, via real dispatch, own title/own en lang", () => {
  it("header, exact event title, and deepLinkSeeUpcoming appear in that exact line order, in the registrant's own resolved lang", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter("ru");
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, {
      capacity: 5,
      title: "Regression Verification Meetup",
    });

    const registerAt = new Date("2026-09-01T00:00:00Z");
    const reg = await seedRegistrant(eventId, registerAt, { lang: "en" });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(organizer.tgId, `/event_cancel ${eventId}`) as never);

    const registrantSend = captured.find(
      (c) => c.method === "sendMessage" && chatIdOf(c) === reg.tgId.toString(),
    );
    expect(registrantSend).toBeDefined();
    const text = textOf(registrantSend) ?? "";
    const catalog = getCatalog("en");

    const lines = text.split("\n");
    expect(lines[0]).toBe(catalog.event.cancelledNotificationHeader);
    expect(lines[1]).toBe("Regression Verification Meetup");
    expect(lines[2]).toBe(catalog.event.deepLinkSeeUpcoming);
  });
});

describe("makeEventCancelHandler -- non-organizer /event_cancel is refused (REQ-016 regression, new dispatch coverage)", () => {
  it("an unrelated non-organizer is refused: no cancellation, no notifications", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 5 });

    const registerAt = new Date("2026-09-01T00:00:00Z");
    const reg1 = await seedRegistrant(eventId, registerAt);
    const reg2 = await seedRegistrant(eventId, registerAt);

    // A third, unrelated user -- never granted a staff row for this chapter.
    const attackerTgId = nextTgId++;
    await resolveOrCreateUser(db, { tgId: BigInt(attackerTgId), tgUsername: "attacker", lang: null });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(attackerTgId, `/event_cancel ${eventId}`) as never);

    const catalog = getCatalog("ru");
    const sendMessageCalls = captured.filter((c) => c.method === "sendMessage");
    expect(sendMessageCalls).toHaveLength(1);
    expect(textOf(sendMessageCalls[0])).toBe(catalog.event.notAuthorized);

    const eventRows = await db.select().from(schema.events).where(eq(schema.events.id, eventId));
    expect(eventRows[0]?.status).toBe("published");

    const registrantTgIds = new Set([reg1.tgId.toString(), reg2.tgId.toString()]);
    const sendsToRegistrants = sendMessageCalls.filter((c) => registrantTgIds.has(chatIdOf(c) ?? ""));
    expect(sendsToRegistrants).toHaveLength(0);

    const ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(eq(schema.notificationLedger.kind, "event_cancelled"));
    expect(ledgerRows).toHaveLength(0);
  });
});
