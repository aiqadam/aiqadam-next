import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, events, profiles, registrations } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { addEventStaff } from "../domain/eventStaff.js";
import { registerForEvent } from "../domain/registration.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { getCatalog } from "../i18n/catalog.js";
import {
  CHECKIN_PAGE_PATTERN,
  CHECKIN_TOGGLE_PATTERN,
  makeCheckInHandler,
  makeCheckinPageCallbackHandler,
  makeCheckinToggleCallbackHandler,
} from "./checkin.js";

// docs/agents/design/REQ-028.md -- AC1-AC6, real grammY dispatch
// (bot.handleUpdate) against a live scratch Postgres, same infrastructure/
// skip discipline as event.dispatch.test.ts/reminder24h.test.ts.

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT checked_in_by, check_in_method FROM registrations LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[checkin.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
    "TRUNCATE notification_ledger, audit_log, event_staff, registrations, events, venues, profiles, users, chapters CASCADE",
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
    if (method === "editMessageText") {
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

  bot.command("checkin", makeCheckInHandler(db));
  bot.callbackQuery(CHECKIN_TOGGLE_PATTERN, makeCheckinToggleCallbackHandler(db));
  bot.callbackQuery(CHECKIN_PAGE_PATTERN, makeCheckinPageCallbackHandler(db));

  return { bot, captured };
}

let nextUpdateId = 1;
// Distinct range from every other *.test.ts file's own reserved tgId band
// (see event.dispatch.test.ts's own header comment for the full list) --
// 940_000_000+ is unclaimed there.
let nextTgId = 940_000_000;

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

interface FakeMessage {
  message_id: number;
  date: number;
  chat: { id: number; type: "private" };
  text: string;
  reply_markup?: { inline_keyboard: { text: string; callback_data: string }[][] };
}

function callbackUpdate(tgId: number, data: string, message: FakeMessage) {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cbq_${nextUpdateId}`,
      from: { id: tgId, is_bot: false, first_name: "Test" },
      chat_instance: "test-chat-instance",
      data,
      message,
    },
  };
}

function textOf(entry: Captured | undefined): string | undefined {
  return entry?.payload["text"] as string | undefined;
}

function replyMarkupOf(
  entry: Captured | undefined,
): { inline_keyboard: { text: string; callback_data: string }[][] } | undefined {
  return entry?.payload["reply_markup"] as
    | { inline_keyboard: { text: string; callback_data: string }[][] }
    | undefined;
}

function asFakeMessage(tgId: number, entry: Captured | undefined): FakeMessage {
  return {
    message_id: 2,
    date: Math.floor(Date.now() / 1000),
    chat: { id: tgId, type: "private" },
    text: textOf(entry) ?? "",
    reply_markup: replyMarkupOf(entry),
  };
}

let chapterSeq = 0;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(schema.chapters)
    .values({
      code: `chapter-req028-${chapterSeq}`,
      name: `Chapter REQ-028 ${chapterSeq}`,
      timezone: "Asia/Tashkent",
      defaultLang: "ru",
      active: true,
    })
    .returning({ id: schema.chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedPublishedEvent(
  chapterId: string,
  organizerId: string,
  opts: { capacity: number; title?: string } = { capacity: 100 },
): Promise<{ eventId: string; title: string }> {
  const title = opts.title ?? "REQ-028 Test Event";
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

async function seedStaff(eventId: string, eventTitle: string): Promise<{ userId: string; tgId: number }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `staff${tgId}`, lang: "ru" });
  await addEventStaff(db, user.id, eventId, user.id, eventTitle, new Date());
  return { userId: user.id, tgId };
}

interface ProfileFields {
  firstName?: string | null;
  lastName?: string | null;
  company?: string | null;
  phone?: string | null;
  email?: string | null;
}

async function seedAdmittedRegistrant(
  eventId: string,
  profile: ProfileFields = {},
): Promise<{ userId: string; tgId: number; registrationId: string }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `member${tgId}`, lang: "ru" });
  const result = await registerForEvent(db, user.id, eventId, new Date("2026-09-01T00:00:00Z"));
  if (result.registrationId === undefined || result.kind !== "admitted") {
    throw new Error(`seedAdmittedRegistrant: expected admitted, got ${result.kind}`);
  }
  if (Object.keys(profile).length > 0) {
    await db.insert(profiles).values({
      userId: user.id,
      firstName: profile.firstName ?? null,
      lastName: profile.lastName ?? null,
      company: profile.company ?? null,
      phone: profile.phone ?? null,
      email: profile.email ?? null,
    });
  }
  return { userId: user.id, tgId, registrationId: result.registrationId };
}

function findButton(
  replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] } | undefined,
  predicate: (b: { text: string; callback_data: string }) => boolean,
) {
  return replyMarkup?.inline_keyboard.flat().find(predicate);
}

describe("REQ-028 AC1 -- genuine stale-render-then-write-time-change interleaving", () => {
  it("admission changed to withdrawn directly in the DB AFTER the list was rendered but BEFORE the toggle: no write, stated refusal", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await resolveOrCreateUser(db, {
      tgId: BigInt(nextTgId++),
      tgUsername: "organizer",
      lang: "ru",
    });
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.id);
    const staff = await seedStaff(eventId, title);
    const attendee = await seedAdmittedRegistrant(eventId, { firstName: "Aigerim", lastName: "Zh" });

    // Step 1: render the list -- this is the STALE render. Its callback_data
    // is captured and used below, unmodified, after the DB has moved on.
    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/checkin ${eventId}`) as never);
    const listReply = captured.find((c) => c.method === "sendMessage");
    expect(listReply).toBeDefined();
    const replyMarkup = replyMarkupOf(listReply);
    const toggleButton = findButton(replyMarkup, (b) => b.callback_data === `checkin:toggle:${attendee.registrationId}`);
    expect(toggleButton).toBeDefined();
    const staleMessage = asFakeMessage(staff.tgId, listReply);

    // Step 2: the world moves on WITHOUT going through the bot at all -- a
    // raw SQL UPDATE, exactly modeling "admission changed directly in the
    // DB" between the render and the tap.
    await pool.query("UPDATE registrations SET admission = 'withdrawn' WHERE id = $1", [
      attendee.registrationId,
    ]);

    // Step 3: press the STALE toggle button -- its callback_data still says
    // only the registrationId, carrying no snapshot of the now-stale
    // admission value.
    await bot.handleUpdate(
      callbackUpdate(staff.tgId, toggleButton?.callback_data ?? "", staleMessage) as never,
    );

    // No write: checked_in_at/checked_in_by/check_in_method are untouched.
    const rows = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    expect(rows[0]?.checkedInAt).toBeNull();
    expect(rows[0]?.checkedInBy).toBeNull();
    expect(rows[0]?.checkInMethod).toBeNull();
    expect(rows[0]?.admission).toBe("withdrawn");

    // Stated refusal: an alert popup, not a silent no-op.
    const answerCall = captured.find((c) => c.method === "answerCallbackQuery");
    expect(answerCall).toBeDefined();
    expect(answerCall?.payload["show_alert"]).toBe(true);
    const catalog = getCatalog("ru");
    expect(answerCall?.payload["text"]).toBe(catalog.checkin.refusedNotAdmitted);

    // No message edit -- the stale render is deliberately left as-is.
    expect(captured.find((c) => c.method === "editMessageText")).toBeUndefined();

    // No new audit_log row for a check-in/undo action on this registration.
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, attendee.registrationId));
    const checkinAuditRows = auditRows.filter(
      (r) => r.action === "registration.checkin" || r.action === "registration.checkin_undo",
    );
    expect(checkinAuditRows).toHaveLength(0);
  });
});

describe("REQ-028 AC2 -- toggle sets/clears checked_in_at, exactly one audit_log row per write", () => {
  it("tap sets checked_in_at/checked_in_by/check_in_method='manual'; tap again clears checked_in_at only", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await resolveOrCreateUser(db, {
      tgId: BigInt(nextTgId++),
      tgUsername: "organizer2",
      lang: "ru",
    });
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.id);
    const staff = await seedStaff(eventId, title);
    const attendee = await seedAdmittedRegistrant(eventId, { firstName: "Bek", lastName: "N" });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/checkin ${eventId}`) as never);
    const listReply = captured.find((c) => c.method === "sendMessage");
    const replyMarkup = replyMarkupOf(listReply);
    const toggleButton = findButton(replyMarkup, (b) => b.callback_data === `checkin:toggle:${attendee.registrationId}`);
    const message = asFakeMessage(staff.tgId, listReply);

    // First tap: check-in.
    await bot.handleUpdate(
      callbackUpdate(staff.tgId, toggleButton?.callback_data ?? "", message) as never,
    );
    const afterCheckIn = await db
      .select()
      .from(registrations)
      .where(eq(registrations.id, attendee.registrationId));
    expect(afterCheckIn[0]?.checkedInAt).not.toBeNull();
    expect(afterCheckIn[0]?.checkedInBy).toBe(staff.userId);
    expect(afterCheckIn[0]?.checkInMethod).toBe("manual");

    const auditAfterFirst = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, attendee.registrationId));
    expect(auditAfterFirst.filter((r) => r.action === "registration.checkin")).toHaveLength(1);
    expect(auditAfterFirst.filter((r) => r.action === "registration.checkin_undo")).toHaveLength(0);

    // Second tap (same stale-shaped message object -- our handler always
    // recomputes its own header/labels, never trusts the caller's copy):
    // undo.
    await bot.handleUpdate(
      callbackUpdate(staff.tgId, toggleButton?.callback_data ?? "", message) as never,
    );
    const afterUndo = await db
      .select()
      .from(registrations)
      .where(eq(registrations.id, attendee.registrationId));
    expect(afterUndo[0]?.checkedInAt).toBeNull();
    // checked_in_by/check_in_method are left as whatever the check-in wrote
    // (design §3.2 step 5) -- only checked_in_at is cleared.
    expect(afterUndo[0]?.checkedInBy).toBe(staff.userId);
    expect(afterUndo[0]?.checkInMethod).toBe("manual");

    const auditAfterSecond = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, attendee.registrationId));
    expect(auditAfterSecond.filter((r) => r.action === "registration.checkin")).toHaveLength(1);
    expect(auditAfterSecond.filter((r) => r.action === "registration.checkin_undo")).toHaveLength(1);
  });
});

describe("REQ-028 AC3 -- no phone/email anywhere in the rendered list", () => {
  it("a rendered list with a phone+email on file leaks neither raw value", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await resolveOrCreateUser(db, {
      tgId: BigInt(nextTgId++),
      tgUsername: "organizer3",
      lang: "ru",
    });
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.id);
    const staff = await seedStaff(eventId, title);
    const phone = "+77011234567";
    const email = "attendee-secret@example.com";
    await seedAdmittedRegistrant(eventId, { firstName: "Dana", lastName: "K", phone, email });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/checkin ${eventId}`) as never);
    const listReply = captured.find((c) => c.method === "sendMessage");
    const text = textOf(listReply) ?? "";
    const replyMarkup = replyMarkupOf(listReply);
    const allButtonText = (replyMarkup?.inline_keyboard.flat() ?? []).map((b) => b.text).join("\n");

    expect(text).not.toContain(phone);
    expect(text).not.toContain(email);
    expect(allButtonText).not.toContain(phone);
    expect(allButtonText).not.toContain(email);
  });
});

describe("REQ-028 AC4 -- live counter is fresh count(checked_in_at IS NOT NULL), no write to events", () => {
  it("a check-in set directly in the DB (bypassing the bot) is reflected on the very next render, and events is untouched", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await resolveOrCreateUser(db, {
      tgId: BigInt(nextTgId++),
      tgUsername: "organizer4",
      lang: "ru",
    });
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.id);
    const staff = await seedStaff(eventId, title);
    const a = await seedAdmittedRegistrant(eventId, { firstName: "Ela", lastName: "M" });
    await seedAdmittedRegistrant(eventId, { firstName: "Farid", lastName: "T" });

    const eventBefore = await db.select().from(events).where(eq(events.id, eventId));

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/checkin ${eventId}`) as never);
    const firstText = textOf(captured.find((c) => c.method === "sendMessage")) ?? "";
    const catalog = getCatalog("ru");
    expect(firstText).toContain(
      catalog.checkin.listHeader.replace("{event}", title).replace("{checkedIn}", "0").replace("{total}", "2"),
    );

    // Set one check-in directly in the DB, entirely bypassing the bot/toggle
    // path -- this is what proves the counter is a fresh read, not a stored
    // or cached value.
    await pool.query(
      "UPDATE registrations SET checked_in_at = now(), checked_in_by = $1, check_in_method = 'manual' WHERE id = $2",
      [a.userId, a.registrationId],
    );

    await bot.handleUpdate(commandUpdate(staff.tgId, `/checkin ${eventId}`) as never);
    const secondSend = captured.filter((c) => c.method === "sendMessage")[1];
    const secondText = textOf(secondSend) ?? "";
    expect(secondText).toContain(
      catalog.checkin.listHeader.replace("{event}", title).replace("{checkedIn}", "1").replace("{total}", "2"),
    );

    const eventAfter = await db.select().from(events).where(eq(events.id, eventId));
    expect(eventAfter).toEqual(eventBefore);
  });
});

describe("REQ-028 AC5 -- only admission='admitted' rows appear", () => {
  it("waitlisted and withdrawn registrants never appear in the rendered list", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await resolveOrCreateUser(db, {
      tgId: BigInt(nextTgId++),
      tgUsername: "organizer5",
      lang: "ru",
    });
    // capacity 1 -> the second registrant waitlists.
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.id, { capacity: 1 });
    const staff = await seedStaff(eventId, title);

    const admitted = await seedAdmittedRegistrant(eventId, { firstName: "Gulnaz", lastName: "Waitlist-Never" });

    const waitlistedTgId = nextTgId++;
    const waitlistedUser = await resolveOrCreateUser(db, {
      tgId: BigInt(waitlistedTgId),
      tgUsername: "waitlisted-user",
      lang: "ru",
    });
    const waitlistedResult = await registerForEvent(db, waitlistedUser.id, eventId, new Date("2026-09-01T00:00:01Z"));
    expect(waitlistedResult.kind).toBe("waitlisted");
    await db.insert(profiles).values({ userId: waitlistedUser.id, firstName: "Hidden", lastName: "Waitlisted" });

    const withdrawnTgId = nextTgId++;
    const withdrawnUser = await resolveOrCreateUser(db, {
      tgId: BigInt(withdrawnTgId),
      tgUsername: "withdrawn-user",
      lang: "ru",
    });
    await db.insert(registrations).values({
      eventId,
      userId: withdrawnUser.id,
      admission: "withdrawn",
      source: "direct",
    });
    await db.insert(profiles).values({ userId: withdrawnUser.id, firstName: "Hidden", lastName: "Withdrawn" });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/checkin ${eventId}`) as never);
    const listReply = captured.find((c) => c.method === "sendMessage");
    const text = textOf(listReply) ?? "";
    const replyMarkup = replyMarkupOf(listReply);
    const buttonTexts = (replyMarkup?.inline_keyboard.flat() ?? []).map((b) => b.text);

    expect(buttonTexts.some((t2) => t2.includes("Gulnaz"))).toBe(true);
    expect(text).not.toContain("Waitlisted");
    expect(text).not.toContain("Withdrawn");
    expect(buttonTexts.join("\n")).not.toContain("Waitlisted");
    expect(buttonTexts.join("\n")).not.toContain("Withdrawn");
  });
});

describe("REQ-028 AC6 -- search narrows the list by name (>=10 attendees, exact match)", () => {
  it("a name-fragment query returns exactly the one matching attendee out of 10+", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await resolveOrCreateUser(db, {
      tgId: BigInt(nextTgId++),
      tgUsername: "organizer6",
      lang: "ru",
    });
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.id, { capacity: 50 });
    const staff = await seedStaff(eventId, title);

    for (let i = 0; i < 10; i += 1) {
      await seedAdmittedRegistrant(eventId, { firstName: `Guest${i}`, lastName: "Common" });
    }
    await seedAdmittedRegistrant(eventId, { firstName: "Zharkyn", lastName: "Unique" });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/checkin ${eventId} Zharkyn`) as never);
    const listReply = captured.find((c) => c.method === "sendMessage");
    const replyMarkup = replyMarkupOf(listReply);
    const buttons = (replyMarkup?.inline_keyboard.flat() ?? []).filter((b) =>
      b.callback_data.startsWith("checkin:toggle:"),
    );

    expect(buttons).toHaveLength(1);
    expect(buttons[0]?.text).toContain("Zharkyn");
    expect(buttons[0]?.text).toContain("Unique");

    const text = textOf(listReply) ?? "";
    // No pagination row for a search view (unpaginated, design §1.4).
    expect(text).not.toContain("Guest");
  });
});
