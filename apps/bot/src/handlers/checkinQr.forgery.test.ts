import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, profiles, registrations } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { addEventStaff } from "../domain/eventStaff.js";
import {
  performQrCheckIn,
  registerForEvent,
  withdrawRegistration,
} from "../domain/registration.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { getCatalog } from "../i18n/catalog.js";
import { makeStartHandler } from "./start.js";
import { CHECKIN_OVERRIDE_PATTERN, makeCheckinOverrideCallbackHandler } from "./checkinQr.js";

// docs/agents/test-specs/REQ-029.md -- own, independently designed cases
// distinct from BACKEND-DEV's committed checkinQr.db.test.ts (AC1
// cross-event-staff fixture, AC2 xmin zero-write proof, AC3 single-row
// waitlisted/requested/withdrawn cycle with button assertions on all three,
// AC5 company:null branch, AC6 cross-chapter organizer negative case, and
// the stale-token S4 recheck's dedicated direct-call sub-case).

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
      `[checkinQr.forgery.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
// Own reserved tgId band, distinct from checkinQr.db.test.ts's 941_000_000+
// (see test-specs/REQ-029.md's range table).
let nextTgId = 942_000_000;

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
      code: `chapter-req029-forgery-${chapterSeq}`,
      name: `Chapter REQ-029 Forgery ${chapterSeq}`,
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
): Promise<{ eventId: string; title: string; chapterId: string }> {
  const title = opts.title ?? "REQ-029 Forgery Test Event";
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
  return { eventId, title, chapterId };
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

describe("REQ-029 forgery AC1 -- staff for a DIFFERENT event is refused; audit row names the registration, not either event", () => {
  it("Cross-Staff (real EventStaff of Event Y) scanning Event X's token is refused as not-staff", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const eventX = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 5, title: "Event X" });
    const eventY = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 5, title: "Event Y" });
    const crossStaff = await seedStaff(eventY.eventId, eventY.title); // staff of Y only
    const attendee = await seedAdmittedRegistrant(eventX.eventId, { firstName: "Cross", lastName: "Attendee" });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(crossStaff.tgId, `/start ci_${attendee.qrToken}`) as never);

    const catalog = getCatalog("ru");
    const reply = captured.find((c) => c.method === "sendMessage");
    expect(textOf(reply)).toBe(catalog.checkinQr.notStaff);

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, attendee.registrationId));
    const refusalRows = auditRows.filter((r) => r.action === "checkin.refused");
    expect(refusalRows).toHaveLength(1);
    expect(refusalRows[0]?.entity).toBe("registration");
    expect(refusalRows[0]?.entityId).toBe(attendee.registrationId);
    expect(refusalRows[0]?.actorUserId).toBe(crossStaff.userId);

    const regRows = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    expect(regRows[0]?.checkedInAt).toBeNull();
    expect(regRows[0]?.checkedInBy).toBeNull();
    expect(regRows[0]?.checkInMethod).toBeNull();
  });
});

describe("REQ-029 forgery AC2 -- repeat scan is a genuine zero-write, proven via xmin", () => {
  it("second scan of the same token never physically rewrites the row (xmin unchanged)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 5 });
    const staff = await seedStaff(eventId, title);
    const attendee = await seedAdmittedRegistrant(eventId, { firstName: "Xmin", lastName: "Proof" });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);

    const afterFirst = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    expect(afterFirst[0]?.checkedInAt).not.toBeNull();
    expect(afterFirst[0]?.checkInMethod).toBe("qr");
    const checkedInAtAfterFirst = afterFirst[0]?.checkedInAt;
    const checkedInByAfterFirst = afterFirst[0]?.checkedInBy;

    const auditAfterFirst = await db.select().from(auditLog).where(eq(auditLog.entityId, attendee.registrationId));
    expect(auditAfterFirst.filter((r) => r.action === "registration.checkin")).toHaveLength(1);

    const before = await pool.query("SELECT xmin::text AS xmin FROM registrations WHERE id = $1", [
      attendee.registrationId,
    ]);

    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);

    const after = await pool.query("SELECT xmin::text AS xmin FROM registrations WHERE id = $1", [
      attendee.registrationId,
    ]);

    // The genuine zero-writes proof: the row was never physically rewritten.
    expect(after.rows[0].xmin).toBe(before.rows[0].xmin);

    const afterSecond = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    expect(afterSecond[0]?.checkedInAt?.getTime()).toBe(checkedInAtAfterFirst?.getTime());
    expect(afterSecond[0]?.checkedInBy).toBe(checkedInByAfterFirst);
    expect(afterSecond[0]?.checkInMethod).toBe("qr");

    const auditAfterSecond = await db.select().from(auditLog).where(eq(auditLog.entityId, attendee.registrationId));
    expect(auditAfterSecond.filter((r) => r.action === "registration.checkin")).toHaveLength(1);

    const secondReply = captured.filter((c) => c.method === "sendMessage")[1];
    expect(textOf(secondReply)).toContain(
      getCatalog("ru").checkinQr.alreadyCheckedIn.split("{at}")[0],
    );
  });
});

describe("REQ-029 forgery AC3 -- one row cycled waitlisted -> requested -> withdrawn, each scan refused with its own reason and its own override offer", () => {
  it("all three admission states asserted in sequence on the same registration, including the override button on every one", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 5 });
    const staff = await seedStaff(eventId, title);
    const attendee = await seedAdmittedRegistrant(eventId, { firstName: "Cycle", lastName: "Case" });

    const catalog = getCatalog("ru");
    const expectedKeys = {
      waitlisted: catalog.checkinQr.refusedWaitlisted,
      requested: catalog.checkinQr.refusedRequested,
      withdrawn: catalog.checkinQr.refusedWithdrawn,
    } as const;

    for (const admission of ["waitlisted", "requested", "withdrawn"] as const) {
      await pool.query("UPDATE registrations SET admission = $1 WHERE id = $2", [
        admission,
        attendee.registrationId,
      ]);

      const { bot, captured } = makeTestBot();
      await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);

      const reply = captured.find((c) => c.method === "sendMessage");
      expect(textOf(reply)).toBe(expectedKeys[admission]);

      const replyMarkup = reply?.payload["reply_markup"] as
        | { inline_keyboard: { text: string; callback_data: string }[][] }
        | undefined;
      const overrideButton = replyMarkup?.inline_keyboard
        .flat()
        .find((b) => b.callback_data === `checkin:override:${attendee.registrationId}`);
      expect(overrideButton).toBeDefined();
      expect(overrideButton?.text).toBe(catalog.checkinQr.overrideButtonLabel);

      const rows = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
      expect(rows[0]?.checkedInAt).toBeNull();
      expect(rows[0]?.admission).toBe(admission);
    }
  });
});

describe("REQ-029 forgery AC5 -- company:null omits its separator cleanly; never phone/email", () => {
  it("attendee A (with company) and attendee B (company: null) success screens, live counter both times", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 5 });
    const staff = await seedStaff(eventId, title);

    const a = await seedAdmittedRegistrant(eventId, {
      firstName: "Nurlan",
      lastName: "Bekov",
      company: "Orbit LLP",
      phone: "+77475551122",
      email: "nurlan.private@example.com",
    });
    const b = await seedAdmittedRegistrant(eventId, {
      firstName: "Saule",
      lastName: "Iskakova",
      company: null,
      phone: "+77015559988",
      email: "saule.private@example.com",
    });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${a.qrToken}`) as never);
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${b.qrToken}`) as never);

    const replies = captured.filter((c) => c.method === "sendMessage");
    const textA = textOf(replies[0]) ?? "";
    const textB = textOf(replies[1]) ?? "";

    expect(textA).toContain("Nurlan Bekov");
    expect(textA).toContain("Orbit LLP");
    expect(textA).not.toContain("+77475551122");
    expect(textA).not.toContain("nurlan.private@example.com");
    expect(textA).toContain("1");

    expect(textB).toContain("Saule Iskakova");
    expect(textB).not.toContain("+77015559988");
    expect(textB).not.toContain("saule.private@example.com");
    expect(textB).not.toContain(" — ");
    expect(textB).toContain("2");
  });
});

describe("REQ-029 forgery AC6 -- organizer override; negative case is an organizer for a DIFFERENT chapter", () => {
  it("positive: same-chapter organizer's override admits+checks in, exactly one audit row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 5 });
    const staff = await seedStaff(eventId, title);
    const attendee = await seedAdmittedRegistrant(eventId, {
      firstName: "Dias",
      lastName: "Amanov",
      company: "Northwind Systems",
    });
    await withdrawRegistration(db, attendee.registrationId, attendee.userId, new Date());

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);
    const refusalReply = captured.find((c) => c.method === "sendMessage");
    const replyMarkup = refusalReply?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    const overrideCallbackData = replyMarkup?.inline_keyboard
      .flat()
      .find((b) => b.callback_data.startsWith("checkin:override:"))?.callback_data;
    expect(overrideCallbackData).toBeDefined();

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
    expect(text).toContain("Dias Amanov");
    expect(text).toContain("Northwind Systems");
  });

  it("negative: an organizer for a DIFFERENT chapter tapping override is refused, no write", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterP = await seedChapter();
    const chapterQ = await seedChapter();
    const chapterQOrganizer = await seedOrganizer(chapterQ); // organizer, but for Chapter Q, not P

    const organizerP = await seedOrganizer(chapterP);
    const { eventId, title } = await seedPublishedEvent(chapterP, organizerP.userId, { capacity: 5 });
    const staff = await seedStaff(eventId, title);
    const attendee = await seedAdmittedRegistrant(eventId, { firstName: "ChapterP", lastName: "Attendee" });
    await withdrawRegistration(db, attendee.registrationId, attendee.userId, new Date());

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${attendee.qrToken}`) as never);
    const refusalReply = captured.find((c) => c.method === "sendMessage");
    const replyMarkup = refusalReply?.payload["reply_markup"] as
      | { inline_keyboard: { text: string; callback_data: string }[][] }
      | undefined;
    const overrideCallbackData = replyMarkup?.inline_keyboard
      .flat()
      .find((b) => b.callback_data.startsWith("checkin:override:"))?.callback_data;
    expect(overrideCallbackData).toBeDefined();

    // Chapter Q's organizer taps Chapter P's event's override button.
    await bot.handleUpdate(callbackUpdate(chapterQOrganizer.tgId, overrideCallbackData ?? "") as never);

    const rows = await db.select().from(registrations).where(eq(registrations.id, attendee.registrationId));
    expect(rows[0]?.admission).toBe("withdrawn");
    expect(rows[0]?.checkedInAt).toBeNull();

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, attendee.registrationId));
    expect(auditRows.filter((r) => r.action === "registration.override_admit_checkin")).toHaveLength(0);

    const answerCall = captured.find((c) => c.method === "answerCallbackQuery");
    const catalog = getCatalog("ru");
    expect(answerCall?.payload["show_alert"]).toBe(true);
    expect(answerCall?.payload["text"]).toBe(catalog.checkinQr.overrideNotAuthorized);
  });
});

describe("REQ-029 forgery S4 -- stale-token recheck, closes the zero-coverage gap", () => {
  it("sub-case A: full /start dispatch of the OLD, superseded token is refused as unknown; sub-case B: a direct performQrCheckIn call with the same stale token exercises the recheck itself, proven via xmin zero-write", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const { eventId, title } = await seedPublishedEvent(chapterId, organizer.userId, { capacity: 1 });
    const staff = await seedStaff(eventId, title);

    const tgId = nextTgId++;
    const attendeeUser = await resolveOrCreateUser(db, {
      tgId: BigInt(tgId),
      tgUsername: `stale${tgId}`,
      lang: "ru",
    });

    const first = await registerForEvent(db, attendeeUser.id, eventId, new Date("2026-09-01T00:00:00Z"));
    if (first.registrationId === undefined || first.kind !== "admitted" || first.qrToken === undefined) {
      throw new Error(`expected admitted+qrToken, got ${first.kind}`);
    }
    const registrationId = first.registrationId;
    const t1 = first.qrToken;

    await withdrawRegistration(db, registrationId, attendeeUser.id, new Date());

    const stillT1 = await pool.query("SELECT qr_token FROM registrations WHERE id = $1", [registrationId]);
    expect(stillT1.rows[0].qr_token).toBe(t1);

    const second = await registerForEvent(db, attendeeUser.id, eventId, new Date("2026-09-02T00:00:00Z"));
    expect(second.registrationId).toBe(registrationId);
    expect(second.qrToken).toBeDefined();
    expect(second.qrToken).not.toBe(t1);
    const t2 = second.qrToken as string;

    const liveToken = await pool.query("SELECT qr_token FROM registrations WHERE id = $1", [registrationId]);
    expect(liveToken.rows[0].qr_token).toBe(t2);

    // Sub-case A -- ordinary sequential dispatch of the OLD token: refused as
    // unknown at the unlocked lookup stage (never reaches performQrCheckIn's
    // own recheck under ordinary dispatch -- see spec's own reachability
    // argument).
    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(commandUpdate(staff.tgId, `/start ci_${t1}`) as never);
    const catalog = getCatalog("ru");
    const reply = captured.find((c) => c.method === "sendMessage");
    expect(textOf(reply)).toBe(catalog.checkinQr.unknownToken);

    const regAfterA = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    expect(regAfterA[0]?.checkedInAt).toBeNull();

    // Sub-case B -- direct call to performQrCheckIn with the real
    // registrationId paired with the now-stale t1: the only deterministic
    // way to exercise the S4 recheck line itself.
    const before = await pool.query("SELECT xmin::text AS xmin FROM registrations WHERE id = $1", [
      registrationId,
    ]);

    const outcome = await performQrCheckIn(db, registrationId, t1, staff.userId, new Date());
    expect(outcome.kind).toBe("unknown-token");

    const after = await pool.query("SELECT xmin::text AS xmin FROM registrations WHERE id = $1", [
      registrationId,
    ]);
    expect(after.rows[0].xmin).toBe(before.rows[0].xmin);

    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, registrationId));
    expect(auditRows.filter((r) => r.action === "registration.checkin")).toHaveLength(0);
  });
});
