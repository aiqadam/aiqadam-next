import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { eventStaff } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { getCatalog } from "../i18n/catalog.js";
import { makeStaffAddHandler, makeStaffRemoveHandler } from "./staff.js";

// docs/issues/ISS-0020.yaml (S10: "blocked users are skipped in both
// [transactional and marketing] cases") + docs/agents/design/ISS-0020-fix.md
// (reworked to close SEC-1, the timing side-channel SECURITY-REVIEWER found
// in the first implementation). Real grammY dispatch (bot.handleUpdate()),
// same infrastructure/skip discipline as handlers/withdraw.test.ts and
// handlers/event.dispatch.test.ts: real, migrated scratch Postgres
// (apps/bot/docker-compose.yml, TEST_DATABASE_URL), network replaced by an
// api.config.use capturing transformer.
//
// WF-03 Step 4 fail-then-pass proof (docs/agents/test-specs/ISS-0020.md
// records the full transcript): every case in the two "regression" describe
// blocks below was run against the pre-fix commit (09377bd, before
// 7585829's first ISS-0020 implementation) with this exact file copied in
// unchanged, and FAILED there for the reason each case's comment states.
// Then run again against the post-fix branch tip (850726d) and PASSED.

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT blocked FROM users LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[staff.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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
  await pool.query("TRUNCATE audit_log, event_staff, registrations, events, venues, profiles, users, chapters CASCADE");
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
    if (method === "getMe") {
      return { ok: true, result: FAKE_BOT_INFO } as never;
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

  bot.command("staff_add", makeStaffAddHandler(db));
  bot.command("staff_remove", makeStaffRemoveHandler(db));

  return { bot, captured };
}

let nextUpdateId = 1;
// Fresh range: every existing *.test.ts range tops out at
// notification.test.ts's 1_000_000_900+ (the highest of all: 800_000_000
// (registration), 900_000_000 (withdraw/start), 920_000_000
// (checkin.forgery), 940_000_000-943_000_000 (checkin/checkinQr/walkin
// db+forgery), 950_000_000 (my/reminder24h), 960_000_000
// (event.dispatch), 970_000_000 (reminderJobs.db), 980_000_000
// (event.db), 990_000_000 (reminder24h.forgery), 993_000_000-996_000_000
// (feedbackJobs.db/feedback.db/noShowJobs.db/noShow.db),
// 1_000_000_900 (notification.test.ts)). REQ-032 only claimed up to
// 996_000_000; notification.test.ts already goes past that, so this file
// claims 1_010_000_000+ -- clear of all of the above, including
// notification.test.ts.
let nextTgId = 1_010_000_000;

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

let chapterSeq = 0;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(schema.chapters)
    .values({
      code: `chapter-iss0020-${chapterSeq}`,
      name: `Chapter ISS-0020 ${chapterSeq}`,
      timezone: "Asia/Tashkent",
      defaultLang: "ru",
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
  // users.role defaults to "member" with no chapter_id -- makeStaffAddHandler/
  // makeStaffRemoveHandler call requireOrganizerForChapter, which needs
  // role="organizer" (or "owner") AND (for "organizer") a matching chapterId
  // to authorize, per domain/eventAuthorization.ts's checkOrganizerForChapter
  // (same setup as handlers/event.dispatch.test.ts's seedOrganizer).
  await db
    .update(schema.users)
    .set({ role: "organizer", chapterId })
    .where(eq(schema.users.id, organizer.id));
  return { userId: organizer.id, tgId };
}

async function seedPublishedEvent(chapterId: string, organizerId: string, title: string): Promise<string> {
  const eventId = await createEvent(
    db,
    organizerId,
    chapterId,
    {
      title,
      description: "A test event",
      format: "meetup",
      venueId: null,
      startsAt: new Date("2026-10-01T18:00:00Z"),
      endsAt: new Date("2026-10-01T20:00:00Z"),
      registrationClosesAt: null,
      capacity: 20,
      requiresInvite: false,
      requiresApproval: false,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizerId, eventId, chapterId, title, new Date());
  return eventId;
}

async function seedTargetUser(tgUsername: string, opts: { blocked: boolean }): Promise<{ userId: string; tgId: number }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername, lang: "ru" });
  if (opts.blocked) {
    await db.update(schema.users).set({ blocked: true }).where(eq(schema.users.id, user.id));
  }
  return { userId: user.id, tgId };
}

async function getStaffRow(eventId: string, userId: string) {
  const rows = await db
    .select()
    .from(eventStaff)
    .where(eq(eventStaff.eventId, eventId));
  return rows.find((r) => r.userId === userId) ?? null;
}

describe("ISS-0020 regression: makeStaffAddHandler skips notification for a blocked target", () => {
  it("blocked target: never sent a Telegram message, but IS assigned as staff and the organizer is told delivery failed", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const eventId = await seedPublishedEvent(chapterId, organizer.userId, "ISS-0020 Add Blocked");
    const target = await seedTargetUser("blocked-target-add", { blocked: true });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(organizer.tgId, `/staff_add ${eventId} blocked-target-add`) as never,
    );

    // Pre-fix (09377bd): staff.ts called ctx.api.sendMessage(Number(targetUser.tgId), body)
    // unconditionally, with no blocked check at all -- this assertion would
    // have found the blocked user's tgId among the sendMessage chat_ids and
    // FAILED. Post-fix, the blocked branch calls ctx.api.getMe() instead.
    const sendMessageChatIds = captured
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload["chat_id"]);
    expect(sendMessageChatIds).not.toContain(target.tgId);

    // Structural timing-cover assertion (ISS-0020-SEC-1 rework, design
    // §2.1): the blocked branch must still perform exactly one Bot API
    // network round-trip (getMe()) in place of the skipped sendMessage, so
    // the organizer's reply latency does not distinguish "blocked" from
    // "some other send failure." Pre-fix, no getMe() call existed anywhere
    // in staff.ts -- this assertion would also have FAILED pre-fix.
    const methods = captured.map((c) => c.method);
    expect(methods).toContain("getMe");

    // Organizer is told the notification did not reach the target (design
    // §3) -- reusing the existing notificationFailedNote mechanism.
    const catalog = getCatalog("ru");
    const organizerReply = captured.find((c) => c.method === "sendMessage" && c.payload["chat_id"] === organizer.tgId);
    expect(textOf(organizerReply)).toContain(catalog.staff.notificationFailedNote);

    // The staff mutation itself still committed for the blocked target (S10
    // concerns notification delivery only, not authorization to act).
    const staffRow = await getStaffRow(eventId, target.userId);
    expect(staffRow).not.toBeNull();
  });
});

describe("ISS-0020 non-regression: makeStaffAddHandler still notifies a non-blocked target", () => {
  it("non-blocked target: receives the real assignment notification, no failure note, staff row exists", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const eventId = await seedPublishedEvent(chapterId, organizer.userId, "ISS-0020 Add Not Blocked");
    const target = await seedTargetUser("clear-target-add", { blocked: false });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(organizer.tgId, `/staff_add ${eventId} clear-target-add`) as never,
    );

    const targetSend = captured.find(
      (c) => c.method === "sendMessage" && c.payload["chat_id"] === target.tgId,
    );
    expect(targetSend).toBeDefined();
    const catalog = getCatalog("ru");
    expect(textOf(targetSend)).toContain(catalog.staff.assignmentNotificationBody.replace("{event}", "ISS-0020 Add Not Blocked"));

    const organizerReply = captured.find(
      (c) => c.method === "sendMessage" && c.payload["chat_id"] === organizer.tgId,
    );
    expect(textOf(organizerReply)).not.toContain(catalog.staff.notificationFailedNote);

    const staffRow = await getStaffRow(eventId, target.userId);
    expect(staffRow).not.toBeNull();
  });
});

describe("ISS-0020 regression: makeStaffRemoveHandler skips notification for a blocked target", () => {
  it("blocked target: never sent a Telegram message, but IS removed as staff and the organizer is told delivery failed", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const eventId = await seedPublishedEvent(chapterId, organizer.userId, "ISS-0020 Remove Blocked");
    const target = await seedTargetUser("blocked-target-remove", { blocked: true });
    await db.insert(eventStaff).values({ eventId, userId: target.userId });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(organizer.tgId, `/staff_remove ${eventId} blocked-target-remove`) as never,
    );

    // Pre-fix (09377bd): makeStaffRemoveHandler called ctx.api.sendMessage
    // unconditionally -- this assertion would have FAILED pre-fix.
    const sendMessageChatIds = captured
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.payload["chat_id"]);
    expect(sendMessageChatIds).not.toContain(target.tgId);

    // Structural timing-cover assertion, same reasoning as the add-handler
    // case above -- would also have FAILED pre-fix (no getMe() call existed).
    const methods = captured.map((c) => c.method);
    expect(methods).toContain("getMe");

    const catalog = getCatalog("ru");
    const organizerReply = captured.find((c) => c.method === "sendMessage" && c.payload["chat_id"] === organizer.tgId);
    expect(textOf(organizerReply)).toContain(catalog.staff.notificationFailedNote);

    // The removal itself still committed for the blocked target.
    const staffRow = await getStaffRow(eventId, target.userId);
    expect(staffRow).toBeNull();
  });
});

describe("ISS-0020 non-regression: makeStaffRemoveHandler still notifies a non-blocked target", () => {
  it("non-blocked target: receives the real removal notification, no failure note, staff row is gone", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const organizer = await seedOrganizer(chapterId);
    const eventId = await seedPublishedEvent(chapterId, organizer.userId, "ISS-0020 Remove Not Blocked");
    const target = await seedTargetUser("clear-target-remove", { blocked: false });
    await db.insert(eventStaff).values({ eventId, userId: target.userId });

    const { bot, captured } = makeTestBot();
    await bot.handleUpdate(
      commandUpdate(organizer.tgId, `/staff_remove ${eventId} clear-target-remove`) as never,
    );

    const targetSend = captured.find(
      (c) => c.method === "sendMessage" && c.payload["chat_id"] === target.tgId,
    );
    expect(targetSend).toBeDefined();
    const catalog = getCatalog("ru");
    expect(textOf(targetSend)).toContain(catalog.staff.removalNotificationBody.replace("{event}", "ISS-0020 Remove Not Blocked"));

    const organizerReply = captured.find(
      (c) => c.method === "sendMessage" && c.payload["chat_id"] === organizer.tgId,
    );
    expect(textOf(organizerReply)).not.toContain(catalog.staff.notificationFailedNote);

    const staffRow = await getStaffRow(eventId, target.userId);
    expect(staffRow).toBeNull();
  });
});
