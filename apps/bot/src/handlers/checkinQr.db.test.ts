import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, profiles, registrations } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { addEventStaff } from "../domain/eventStaff.js";
import { generateQrToken, registerForEvent, withdrawRegistration } from "../domain/registration.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { getCatalog } from "../i18n/catalog.js";
import { makeStartHandler } from "./start.js";
import { CHECKIN_OVERRIDE_PATTERN, makeCheckinOverrideCallbackHandler } from "./checkinQr.js";

// docs/agents/design/REQ-029.md -- AC1-AC6, real grammY dispatch
// (bot.handleUpdate) against a live scratch Postgres, same infrastructure/
// skip discipline as checkin.db.test.ts.

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
      `[checkinQr.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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

  bot.command("start", makeStartHandler(db));
  bot.callbackQuery(CHECKIN_OVERRIDE_PATTERN, makeCheckinOverrideCallbackHandler(db));

  return { bot, captured };
}

let nextUpdateId = 1;
// Distinct range from every other *.test.ts file's own reserved tgId band --
// 941_000_000+ is unclaimed (checkin.db.test.ts already reserves
// 940_000_000+).
let nextTgId = 941_000_000;

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
        text: "placeholder",
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
      code: `chapter-req029-${chapterSeq}`,
      name: `Chapter REQ-029 ${chapterSeq}`,
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
  opts: { capacity: number; title?: string; endsAt?: Date } = { capacity: 100 },
): Promise<{ eventId: string; title: string }> {
  const title = opts.title ?? "REQ-029 Test Event";
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
      endsAt: opts.endsAt ?? new Date("2026-09-10T20:00:00Z"),
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

async function seedOrganizer(chapterId: string): Promise<{ userId: string; tgId: number }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `org${tgId}`, lang: "ru" });
  await db.update(schema.users).set({ role: "organizer", chapterId }).where(eq(schema.users.id, user.id));
  return { userId: user.id, tgId };
}

async function seedAdmittedRegistrant(
  eventId: string,
  profile: { firstName?: string | null; lastName?: string | null; company?: string | null; phone?: string | null; email?: string | null } = {},
): Promise<{ userId: string; tgId: number; registrationId: string; qrToken: string }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `member${tgId}`, lang: "ru" });
  const result = await registerForEvent(db, user.id, eventId, new Date("2026-09-01T00:00:00Z"));
  if (result.registrationId === undefined || result.kind !== "admitted" || result.qrToken === undefined) {
    throw new Error(`seedAdmittedRegistrant: expected admitted+qrToken, got ${result.kind}`);
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
  return { userId: user.id, tgId, registrationId: result.registrationId, qrToken: result.qrToken };
}

async function seedMemberUser(): Promise<{ userId: string; tgId: number }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `plainmember${tgId}`, lang: "ru" });
  return { userId: user.id, tgId };
}

describe("REQ-029 AC1 -- non-staff scan is refused AND writes an audit_log row naming the registration", () => {
  it("a non-EventStaff user scanning a valid admitted token is refused, and exactly one audit row names entity=registration/entityId=registrationId", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId);
    const attendee = await seedAdmittedRegistrant(eventId, { firstName: "Aigerim", lastName: "Zh" });
    const nonStaff = await seedMemberUser();

    const auditBefore = await db.select().from(auditLog).where(eq(auditLog.entityId, attendee.registrationId));
    // registerForEvent itself already wrote its own "registration.admit"
    // audit row for this same entityId -- assert there is no "checkin.refused"
    // row yet, not that the entityId has zero rows of any kind.
    expect(auditBefore.filter((r) => r.action === "checkin.refused")).toHaveLength(0);

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(nonStaff.tgId, `/start ci_${attendee.qrToken}`) as never);

    const catalog = getCatalog("ru");
    const reply = captured.find((c) => c.method === "sendMessage");
    expect(textOf(reply)).toBe(catalog.checkinQr.notStaff);

    // The crux: zero audit rows on refusal is a FAIL. Assert a row exists,
    // naming the registration (not just the event).
    const auditAfter = await db.select().from(auditLog).where(eq(auditLog.entityId, attendee.registrationId));
    const refusalRows = auditAfter.filter((r) => r.action === "checkin.refused");
    expect(refusalRows).toHaveLength(1);
    expect(refusalRows[0]?.entity).toBe("registration");
    expect(refusalRows[0]?.entityId).toBe(attendee.registrationId);
    expect(refusalRows[0]?.actorUserId).toBe(nonStaff.userId);

    // No check-in write happened.
    const regRows = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    expect(regRows[0]?.checkedInAt).toBeNull();

    void title;
  });
});

describe("REQ-029 AC2 -- staff scan checks in; the SAME token scanned again reports, never rewrites", () => {
  it("first scan sets checked_in_at/checked_in_by/check_in_method=qr; second scan is a zero-write report, checked_in_at byte-for-byte unchanged", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId);
    const staff = await seedStaff(eventId, title);
    const attendee = await seedAdmittedRegistrant(eventId, { firstName: "Bek", lastName: "N" });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);

    const afterFirst = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    expect(afterFirst[0]?.checkedInAt).not.toBeNull();
    expect(afterFirst[0]?.checkedInBy).toBe(staff.userId);
    expect(afterFirst[0]?.checkInMethod).toBe("qr");
    const checkedInAtAfterFirst = afterFirst[0]?.checkedInAt;

    const auditAfterFirst = await db.select().from(auditLog).where(eq(auditLog.entityId, attendee.registrationId));
    expect(auditAfterFirst.filter((r) => r.action === "registration.checkin")).toHaveLength(1);

    // Second scan of the SAME token.
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);

    const afterSecond = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    // Byte-for-byte unchanged.
    expect(afterSecond[0]?.checkedInAt?.getTime()).toBe(checkedInAtAfterFirst?.getTime());
    expect(afterSecond[0]?.checkedInBy).toBe(staff.userId);
    expect(afterSecond[0]?.checkInMethod).toBe("qr");

    // Zero additional writes: still exactly one registration.checkin audit
    // row, no new one from the repeat scan.
    const auditAfterSecond = await db.select().from(auditLog).where(eq(auditLog.entityId, attendee.registrationId));
    expect(auditAfterSecond.filter((r) => r.action === "registration.checkin")).toHaveLength(1);

    // The report names the time and the checker.
    const secondReply = captured.filter((c) => c.method === "sendMessage")[1];
    const catalog = getCatalog("ru");
    const expectedText = catalog.checkinQr.alreadyCheckedIn
      .replace(
        "{at}",
        new Intl.DateTimeFormat("ru-RU", {
          timeZone: "Asia/Tashkent",
          year: "numeric",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).format(checkedInAtAfterFirst as Date),
      )
      .replace("{by}", "@" + `staff${staff.tgId}`);
    expect(textOf(secondReply)).toBe(expectedText);
  });
});

describe("REQ-029 AC3 -- waitlisted/requested/withdrawn tokens refused with specific reason + override offer; checked_in_at stays NULL", () => {
  it("withdrawn (real domain transition, token preserved from a prior admission)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId);
    const staff = await seedStaff(eventId, title);
    const attendee = await seedAdmittedRegistrant(eventId, { firstName: "Withdraw", lastName: "Case" });

    // Genuine domain transition: admitted -> withdrawn. withdrawRegistration
    // only ever touches the `admission` column -- the qr_token issued at
    // admission time is left exactly as-is (domain/registration.ts §2.2 step
    // 4), so this is a REAL reachable "a withdrawn registration still has a
    // qr_token on it" state, not a synthetic DB row.
    await withdrawRegistration(db, attendee.registrationId, attendee.userId, new Date());

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);

    const catalog = getCatalog("ru");
    const reply = captured.find((c) => c.method === "sendMessage");
    expect(textOf(reply)).toBe(catalog.checkinQr.refusedWithdrawn);
    const replyMarkup = reply?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    const overrideButton = replyMarkup?.inline_keyboard.flat().find((b) => b.callback_data === `checkin:override:${attendee.registrationId}`);
    expect(overrideButton).toBeDefined();
    expect(overrideButton?.text).toBe(catalog.checkinQr.overrideButtonLabel);

    const rows = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    expect(rows[0]?.checkedInAt).toBeNull();
    expect(rows[0]?.admission).toBe("withdrawn");
  });

  it("waitlisted and requested (a qr_token present on a non-admitted row -- decideQrCheckinOutcome/performQrCheckIn's own table, exercised directly against the DB)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId);
    const staff = await seedStaff(eventId, title);

    for (const admission of ["waitlisted", "requested"] as const) {
      const attendee = await seedAdmittedRegistrant(eventId, { firstName: admission, lastName: "Case" });
      // registerForEvent never issues a qr_token to a waitlisted/requested
      // row (only 'admitted' does, domain/registration.ts §3.2 step 8) -- so
      // there is no public API path that produces a token-bearing waitlisted
      // row today. Simulating the admission flip while preserving the
      // already-issued token exercises exactly the state
      // decideQrCheckinOutcome/performQrCheckIn's own table names (§3.2),
      // which is the unit under test here.
      await pool.query("UPDATE registrations SET admission = $1 WHERE id = $2", [admission, attendee.registrationId]);

      const { bot, captured } = makeTestBot();
      await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);

      const catalog = getCatalog("ru");
      const expectedKey = admission === "waitlisted" ? "refusedWaitlisted" : "refusedRequested";
      const reply = captured.find((c) => c.method === "sendMessage");
      expect(textOf(reply)).toBe(catalog.checkinQr[expectedKey]);

      const rows = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
      expect(rows[0]?.checkedInAt).toBeNull();
      expect(rows[0]?.admission).toBe(admission);
    }
  });
});

describe("REQ-029 AC4 -- unknown token refused; a valid admitted token after ends_at is refused", () => {
  it("an unknown token is refused", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const someUser = await seedMemberUser();
    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(someUser.tgId, "/start ci_deadbeefdeadbeefdeadbeefdeadbeef") as never);
    const catalog = getCatalog("ru");
    const reply = captured.find((c) => c.method === "sendMessage");
    expect(textOf(reply)).toBe(catalog.checkinQr.unknownToken);
  });

  it("a valid admitted token scanned after the event's ends_at is refused", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    // ends_at in the past relative to "now" (this test runs well after 2020).
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId, {
      capacity: 10,
      endsAt: new Date("2020-01-01T00:00:00Z"),
    });
    const staff = await seedStaff(eventId, title);

    // registerForEvent's own decideRegistrationOutcome would refuse
    // ("event-finished") given an endsAt already in the past -- it enforces
    // the SAME timing rule this test is targeting, just at registration
    // time instead of check-in time. A direct insert models "was admitted
    // while the event was still open, is now being scanned after it ended,"
    // which registerForEvent has no way to construct given a fixed endsAt.
    const memberTgId = nextTgId++;
    const member = await resolveOrCreateUser(db, { tgId: BigInt(memberTgId), tgUsername: `ended${memberTgId}`, lang: "ru" });
    const qrToken = generateQrToken();
    const inserted = await db
      .insert(registrations)
      .values({ eventId, userId: member.id, admission: "admitted", source: "direct", qrToken })
      .returning({ id: registrations.id });
    const registrationId = inserted[0]?.id;
    if (registrationId === undefined) throw new Error("insert returned no row");

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${qrToken}`) as never);

    const catalog = getCatalog("ru");
    const reply = captured.find((c) => c.method === "sendMessage");
    expect(textOf(reply)).toBe(catalog.checkinQr.eventEnded);

    const rows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(rows[0]?.checkedInAt).toBeNull();
  });
});

describe("REQ-029 AC5 -- success screen shows name+company+counter, never phone/email", () => {
  it("a successful scan's reply contains name and company but neither the phone nor the email on file", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId);
    const staff = await seedStaff(eventId, title);
    const phone = "+77011234567";
    const email = "attendee-secret@example.com";
    const attendee = await seedAdmittedRegistrant(eventId, {
      firstName: "Dana",
      lastName: "K",
      company: "Acme Corp",
      phone,
      email,
    });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);

    const reply = captured.find((c) => c.method === "sendMessage");
    const text = textOf(reply) ?? "";
    expect(text).toContain("Dana K");
    expect(text).toContain("Acme Corp");
    expect(text).toContain("1"); // live counter, first check-in for this event
    expect(text).not.toContain(phone);
    expect(text).not.toContain(email);
  });
});

describe("REQ-029 AC6 -- organizer override admits+checks in a refused attendee, exactly one audit_log row", () => {
  it("tapping override on a withdrawn registration's refusal writes exactly one registration.override_admit_checkin audit row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId);
    const staff = await seedStaff(eventId, title);
    const attendee = await seedAdmittedRegistrant(eventId, { firstName: "Override", lastName: "Case", company: "Beta LLC" });

    await withdrawRegistration(db, attendee.registrationId, attendee.userId, new Date());

    const { bot, captured } = makeTestBot();
    // Trigger the refusal + override offer.
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);
    const refusalReply = captured.find((c) => c.method === "sendMessage");
    const replyMarkup = refusalReply?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    const overrideCallbackData = replyMarkup?.inline_keyboard.flat().find((b) => b.callback_data.startsWith("checkin:override:"))?.callback_data;
    expect(overrideCallbackData).toBeDefined();

    // Organizer taps the override button.
    await bot.handleUpdate(callbackUpdate(organizer.tgId, overrideCallbackData ?? "") as never);

    const rows = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    expect(rows[0]?.admission).toBe("admitted");
    expect(rows[0]?.checkedInAt).not.toBeNull();
    expect(rows[0]?.checkedInBy).toBe(organizer.userId);
    expect(rows[0]?.checkInMethod).toBe("manual");

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, attendee.registrationId));
    const overrideRows = auditRows.filter((r) => r.action === "registration.override_admit_checkin");
    expect(overrideRows).toHaveLength(1);
    expect(overrideRows[0]?.actorUserId).toBe(organizer.userId);

    const successReply = captured.filter((c) => c.method === "sendMessage")[1];
    const text = textOf(successReply) ?? "";
    expect(text).toContain("Override Case");
    expect(text).toContain("Beta LLC");
  });

  it("a plain EventStaff volunteer (not organizer) tapping override is refused, no write", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId);
    const staff = await seedStaff(eventId, title);
    const attendee = await seedAdmittedRegistrant(eventId, { firstName: "Staffonly", lastName: "Case" });
    await withdrawRegistration(db, attendee.registrationId, attendee.userId, new Date());

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);
    const refusalReply = captured.find((c) => c.method === "sendMessage");
    const replyMarkup = refusalReply?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    const overrideCallbackData = replyMarkup?.inline_keyboard.flat().find((b) => b.callback_data.startsWith("checkin:override:"))?.callback_data;

    // The staff volunteer (EventStaff, not organizer) taps their own refusal's override button.
    await bot.handleUpdate(callbackUpdate(staff.tgId, overrideCallbackData ?? "") as never);

    const rows = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    expect(rows[0]?.admission).toBe("withdrawn");
    expect(rows[0]?.checkedInAt).toBeNull();

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, attendee.registrationId));
    expect(auditRows.filter((r) => r.action === "registration.override_admit_checkin")).toHaveLength(0);

    const answerCall = captured.find((c) => c.method === "answerCallbackQuery");
    const catalog = getCatalog("ru");
    expect(answerCall?.payload["text"]).toBe(catalog.checkinQr.overrideNotAuthorized);
  });
});
