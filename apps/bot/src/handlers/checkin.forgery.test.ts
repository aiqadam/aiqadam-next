import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, events, registrations } from "../db/schema.js";
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

// docs/agents/test-specs/REQ-028.md -- 5 independently designed cases, own
// fixtures, distinct from BACKEND-DEV's checkin.db.test.ts (AC1/AC3/AC4 each
// use a genuinely different interleaving/fixture there) plus two brand-new
// permanent regressions (cross-event forged toggle, concurrent double-toggle)
// formalizing findings SECURITY-REVIEWER verified ad hoc and reverted.
//
// TEST-RUNNER NOTE (deviation from the spec's own worked example, filed as a
// MINOR issue per core-directives.md's "Never resolve a conflict silently"):
// the spec's AC1 fixture describes lastName values "A0".."A11" and asserts
// the attendee named "A10" lands at sorted index 10 (page 1). Under Postgres's
// default text ordering (byte/lexicographic, matching JS string comparison),
// unpadded "A0".."A11" actually sorts as A0, A1, A10, A11, A2, A3, ... A9 --
// "A10" lands at index 2 (page 0), not index 10. This test instead
// zero-pads to "A00".."A11" so lexicographic order matches numeric order,
// which is what the spec's own narrative intent (deterministic order, target
// attendee on page 1 at index 10) requires. The scenario, assertions, and
// failure mode are otherwise implemented exactly as designed.

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
      `[checkin.forgery.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
// docs/agents/test-specs/REQ-028.md's reserved-range table -- 920_000_000+ is
// this new file's own unclaimed band.
let nextTgId = 920_000_000;

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

function findButton(
  replyMarkup: { inline_keyboard: { text: string; callback_data: string }[][] } | undefined,
  predicate: (b: { text: string; callback_data: string }) => boolean,
) {
  return replyMarkup?.inline_keyboard.flat().find(predicate);
}

let chapterSeq = 0;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(schema.chapters)
    .values({
      code: `chapter-req028-forgery-${chapterSeq}`,
      name: `Chapter REQ-028 Forgery ${chapterSeq}`,
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
  const title = opts.title ?? "REQ-028 Forgery Test Event";
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
    await db.insert(schema.profiles).values({
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

describe("REQ-028 AC1 (independent) -- stale admission change survives an intervening page-turn re-render", () => {
  it("page-0 render -> page-turn re-render (page 1) -> DB admission change -> stale toggle on the page-1 button: no write, stated refusal", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await resolveOrCreateUser(db, {
      tgId: BigInt(nextTgId++),
      tgUsername: "organizer-ac1f",
      lang: "ru",
    });
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.id, { capacity: 20 });
    const staff = await seedStaff(eventId, title);

    // 12 attendees, zero-padded lastName so lexicographic (Postgres default
    // text) order matches numeric order -- see the file-header note on why
    // "A0".."A11" (unpadded, as the spec's own prose names them) would NOT
    // deterministically place "A10" at sorted index 10.
    let targetRegistrationId = "";
    for (let i = 0; i < 12; i += 1) {
      const lastName = `A${String(i).padStart(2, "0")}`;
      const r = await seedAdmittedRegistrant(eventId, { firstName: `Att${i}`, lastName });
      if (i === 10) {
        targetRegistrationId = r.registrationId;
      }
    }
    expect(targetRegistrationId).not.toBe("");

    const { bot, captured } = makeTestBot();

    // Stale render: page 0. Target attendee (index 10) is NOT on this page.
    await bot.handleUpdate(commandUpdate(staff.tgId, `/checkin ${eventId}`) as never);
    const page0Reply = captured.find((c) => c.method === "sendMessage");
    expect(page0Reply).toBeDefined();
    const page0Markup = replyMarkupOf(page0Reply);
    expect(findButton(page0Markup, (b) => b.callback_data === `checkin:toggle:${targetRegistrationId}`)).toBeUndefined();
    const page0Message = asFakeMessage(staff.tgId, page0Reply);

    // Intervening page-turn re-render: page 1. THIS is where the target
    // attendee's real toggle button appears.
    await bot.handleUpdate(
      callbackUpdate(staff.tgId, `checkin:page:${eventId}:1`, page0Message) as never,
    );
    const pageTurnEdit = captured.find((c) => c.method === "editMessageText");
    expect(pageTurnEdit).toBeDefined();
    const page1Markup = replyMarkupOf(pageTurnEdit);
    const toggleButton = findButton(page1Markup, (b) => b.callback_data === `checkin:toggle:${targetRegistrationId}`);
    expect(toggleButton).toBeDefined();
    const page1Message = asFakeMessage(staff.tgId, pageTurnEdit);

    // The world moves on directly in the DB, AFTER the page-1 render that
    // produced this exact button.
    await pool.query("UPDATE registrations SET admission = 'withdrawn' WHERE id = $1", [
      targetRegistrationId,
    ]);

    // Stale tap against the page-1 button.
    await bot.handleUpdate(
      callbackUpdate(staff.tgId, toggleButton?.callback_data ?? "", page1Message) as never,
    );

    // Pass condition 1: no write.
    const rows = await db.select().from(registrations).where(eq(registrations.id, targetRegistrationId));
    expect(rows[0]?.checkedInAt).toBeNull();
    expect(rows[0]?.checkedInBy).toBeNull();
    expect(rows[0]?.checkInMethod).toBeNull();
    expect(rows[0]?.admission).toBe("withdrawn");

    // Pass condition 2: stated refusal.
    const answerCalls = captured.filter((c) => c.method === "answerCallbackQuery");
    const toggleAnswer = answerCalls[answerCalls.length - 1];
    expect(toggleAnswer?.payload["show_alert"]).toBe(true);
    const catalog = getCatalog("ru");
    expect(toggleAnswer?.payload["text"]).toBe(catalog.checkin.refusedNotAdmitted);

    // Pass condition 3: exactly one editMessageText call total (the
    // page-turn), none from the toggle.
    expect(captured.filter((c) => c.method === "editMessageText")).toHaveLength(1);

    // Pass condition 4: zero new checkin/checkin_undo audit rows.
    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, targetRegistrationId));
    const checkinAuditRows = auditRows.filter(
      (r) => r.action === "registration.checkin" || r.action === "registration.checkin_undo",
    );
    expect(checkinAuditRows).toHaveLength(0);
  });
});

describe("REQ-028 AC3 (independent) -- two attendees, one with no profiles row at all", () => {
  it("phone+email on file for A, no profile row at all for B: neither raw value leaks, B falls back to @member<tgId>", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await resolveOrCreateUser(db, {
      tgId: BigInt(nextTgId++),
      tgUsername: "organizer-ac3f",
      lang: "ru",
    });
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.id, { capacity: 5 });
    const staff = await seedStaff(eventId, title);

    const phone = "+998901112233";
    const email = "aliya.private@example.com";
    await seedAdmittedRegistrant(eventId, {
      firstName: "Aliya",
      lastName: "Suleimenova",
      phone,
      email,
    });
    // Attendee B: no profiles row at all (skip the profile param entirely).
    const b = await seedAdmittedRegistrant(eventId);

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/checkin ${eventId}`) as never);
    const listReply = captured.find((c) => c.method === "sendMessage");
    const text = textOf(listReply) ?? "";
    const replyMarkup = replyMarkupOf(listReply);
    const allButtonText = (replyMarkup?.inline_keyboard.flat() ?? []).map((b2) => b2.text).join("\n");

    expect(text).not.toContain(phone);
    expect(text).not.toContain(email);
    expect(allButtonText).not.toContain(phone);
    expect(allButtonText).not.toContain(email);

    const bButton = findButton(replyMarkup, (b2) => b2.callback_data === `checkin:toggle:${b.registrationId}`);
    expect(bButton).toBeDefined();
    expect(bButton?.text).toContain(`@member${b.tgId}`);
  });
});

describe("REQ-028 AC4 (independent) -- live counter through two real toggle-driven writes", () => {
  it("check-in, check-in, undo (via toggleCheckIn dispatch) moves the header 0/3 -> 1/3 -> 2/3 -> 1/3; events row unchanged", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await resolveOrCreateUser(db, {
      tgId: BigInt(nextTgId++),
      tgUsername: "organizer-ac4f",
      lang: "ru",
    });
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.id, { capacity: 5 });
    const staff = await seedStaff(eventId, title);

    const a1 = await seedAdmittedRegistrant(eventId, { firstName: "One", lastName: "First" });
    const a2 = await seedAdmittedRegistrant(eventId, { firstName: "Two", lastName: "Second" });
    await seedAdmittedRegistrant(eventId, { firstName: "Three", lastName: "Third" });

    const catalog = getCatalog("ru");
    const header = (checkedIn: number, total: number): string =>
      catalog.checkin.listHeader
        .replace("{event}", title)
        .replace("{checkedIn}", String(checkedIn))
        .replace("{total}", String(total));

    const eventBefore = await db.select().from(events).where(eq(events.id, eventId));

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/checkin ${eventId}`) as never);
    const listReply = captured.find((c) => c.method === "sendMessage");
    expect(textOf(listReply)).toContain(header(0, 3));
    const replyMarkup = replyMarkupOf(listReply);
    const message = asFakeMessage(staff.tgId, listReply);
    const button1 = findButton(replyMarkup, (b) => b.callback_data === `checkin:toggle:${a1.registrationId}`);
    const button2 = findButton(replyMarkup, (b) => b.callback_data === `checkin:toggle:${a2.registrationId}`);
    expect(button1).toBeDefined();
    expect(button2).toBeDefined();

    // Toggle 1: check-in attendee 1.
    await bot.handleUpdate(callbackUpdate(staff.tgId, button1?.callback_data ?? "", message) as never);
    const edits = () => captured.filter((c) => c.method === "editMessageText");
    expect(textOf(edits()[0])).toContain(header(1, 3));

    // Toggle 2: check-in attendee 2.
    await bot.handleUpdate(callbackUpdate(staff.tgId, button2?.callback_data ?? "", message) as never);
    expect(textOf(edits()[1])).toContain(header(2, 3));

    // Toggle 3: undo attendee 1.
    await bot.handleUpdate(callbackUpdate(staff.tgId, button1?.callback_data ?? "", message) as never);
    expect(textOf(edits()[2])).toContain(header(1, 3));

    const eventAfter = await db.select().from(events).where(eq(events.id, eventId));
    expect(eventAfter).toEqual(eventBefore);
  });
});

describe("REQ-028 cross-event forged toggle -- permanent regression for SECURITY-REVIEWER's reverted ad hoc test", () => {
  it("staff of Event A forging checkin:toggle:<Event B's victim registrationId> is refused against the freshly-derived Event B, not Event A", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await resolveOrCreateUser(db, {
      tgId: BigInt(nextTgId++),
      tgUsername: "organizer-forged",
      lang: "ru",
    });
    const eventA = await seedPublishedEvent(chapterId, organizer.id, { capacity: 5, title: "Event A" });
    const eventB = await seedPublishedEvent(chapterId, organizer.id, { capacity: 5, title: "Event B" });

    // Staff-A is staff for Event A only.
    const staffA = await seedStaff(eventA.eventId, eventA.title);

    // Victim registered (admitted) to Event B.
    const victim = await seedAdmittedRegistrant(eventB.eventId, { firstName: "Victim", lastName: "Vee" });

    // Staff-A never renders Event B's /checkin list -- the forged
    // callback_data + FakeMessage pairing is hand-built, mirroring an
    // attacker-replayed callback against a message the bot did send at some
    // point (arbitrary text/reply_markup).
    const forgedMessage: FakeMessage = {
      message_id: 999,
      date: Math.floor(Date.now() / 1000),
      chat: { id: staffA.tgId, type: "private" },
      text: "Event: Event A\nChecked in: 0 / 0",
      reply_markup: { inline_keyboard: [] },
    };

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      callbackUpdate(staffA.tgId, `checkin:toggle:${victim.registrationId}`, forgedMessage) as never,
    );

    const catalog = getCatalog("ru");
    const answerCall = captured.find((c) => c.method === "answerCallbackQuery");
    expect(answerCall?.payload["show_alert"]).toBe(true);
    expect(answerCall?.payload["text"]).toBe(catalog.checkin.notAuthorized);

    const victimRow = await db.select().from(registrations).where(eq(registrations.id, victim.registrationId));
    expect(victimRow[0]?.checkedInAt).toBeNull();
    expect(victimRow[0]?.checkedInBy).toBeNull();
    expect(victimRow[0]?.checkInMethod).toBeNull();

    expect(captured.find((c) => c.method === "editMessageText")).toBeUndefined();

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, eventB.eventId));
    const refusedRows = auditRows.filter((r) => r.action === "checkin.refused");
    expect(refusedRows).toHaveLength(1);

    const victimAuditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.entityId, victim.registrationId));
    const checkinAuditRows = victimAuditRows.filter(
      (r) => r.action === "registration.checkin" || r.action === "registration.checkin_undo",
    );
    expect(checkinAuditRows).toHaveLength(0);
  });
});

describe("REQ-028 genuine concurrent double-toggle -- READ COMMITTED serialization property", () => {
  it("two Promise.all'd dispatches of the identical toggle callback net to exactly one check-in followed by one undo", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await resolveOrCreateUser(db, {
      tgId: BigInt(nextTgId++),
      tgUsername: "organizer-race",
      lang: "ru",
    });
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.id, { capacity: 5 });
    const staff = await seedStaff(eventId, title);
    const attendee = await seedAdmittedRegistrant(eventId, { firstName: "Race", lastName: "R" });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/checkin ${eventId}`) as never);
    const listReply = captured.find((c) => c.method === "sendMessage");
    const replyMarkup = replyMarkupOf(listReply);
    const toggleButton = findButton(replyMarkup, (b) => b.callback_data === `checkin:toggle:${attendee.registrationId}`);
    expect(toggleButton).toBeDefined();
    const message = asFakeMessage(staff.tgId, listReply);
    const toggleCallbackData = toggleButton?.callback_data ?? "";

    // Two separate bot.handleUpdate() calls against the same in-process
    // bot/db pool, fired concurrently -- each opens its own db.transaction,
    // genuinely racing two Postgres transactions on the same row via
    // toggleCheckIn's `.for("update")` lock (SECURITY-REVIEWER's "S6
    // CONCURRENT-TOGGLE RACE TRACE"). Under READ COMMITTED, the second
    // transaction blocks on the lock until the first commits ("check-in"),
    // then re-reads the now-committed row and correctly decides "undo" --
    // never a second "check-in". Net effect: check-in, then immediate undo,
    // so the expected final state is checkedInAt === null.
    await expect(
      Promise.all([
        bot.handleUpdate(callbackUpdate(staff.tgId, toggleCallbackData, message) as never),
        bot.handleUpdate(callbackUpdate(staff.tgId, toggleCallbackData, message) as never),
      ]),
    ).resolves.not.toThrow();

    const rows = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    expect(rows[0]?.checkedInAt).toBeNull();

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, attendee.registrationId));
    expect(auditRows.filter((r) => r.action === "registration.checkin")).toHaveLength(1);
    expect(auditRows.filter((r) => r.action === "registration.checkin_undo")).toHaveLength(1);

    const answerCalls = captured.filter((c) => c.method === "answerCallbackQuery");
    expect(answerCalls).toHaveLength(2);
  });
});
