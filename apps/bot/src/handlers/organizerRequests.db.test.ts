import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, registrations, users } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { addEventStaff } from "../domain/eventStaff.js";
import { registerForEvent } from "../domain/registration.js";
import type { NotificationSender } from "../domain/notification.js";
import { getCatalog } from "../i18n/catalog.js";
import {
  formatRejectReasonPrompt,
  makeRequestApproveCallbackHandler,
  makeRequestApproveCancelCallbackHandler,
  makeRequestApproveConfirmCallbackHandler,
  makeRequestDetailCallbackHandler,
  makeRequestRejectCallbackHandler,
  makeRequestRejectTextReplyHandler,
  makeRequestsListHandler,
  makeRequestsPageCallbackHandler,
  REQ_APPROVE_CANCEL_PATTERN,
  REQ_APPROVE_CONFIRM_PATTERN,
  REQ_APPROVE_PATTERN,
  REQ_OPEN_PATTERN,
  REQ_PAGE_PATTERN,
  REQ_REJECT_PATTERN,
} from "./organizerRequests.js";

// docs/agents/design/REQ-035.md -- AC1, AC2, AC4, AC6, AC7, AC9. Real grammY
// dispatch (bot.handleUpdate) against a live scratch Postgres, same
// infrastructure/skip discipline as handlers/walkin.db.test.ts.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

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
      `[organizerRequests.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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

function makeFakeSender(): { sender: NotificationSender; sent: { tgId: bigint; text: string }[] } {
  const sent: { tgId: bigint; text: string }[] = [];
  return {
    sender: {
      async send(tgId, text) {
        sent.push({ tgId, text });
      },
      async sendPhoto(tgId, _photo, caption) {
        sent.push({ tgId, text: caption });
      },
    },
    sent,
  };
}

function makeTestBot(sender: NotificationSender): { bot: Bot; captured: Captured[]; getLastMessageText: () => string } {
  const captured: Captured[] = [];
  let lastMessageText = "";
  const bot = new Bot("000000:TEST-TOKEN-NOT-REAL", { botInfo: FAKE_BOT_INFO });

  bot.api.config.use(async (_prev, method, payload) => {
    captured.push({ method, payload: payload as Record<string, unknown> });
    if (method === "answerCallbackQuery") {
      return { ok: true, result: true } as never;
    }
    if (method === "editMessageText") {
      lastMessageText = (payload as Record<string, unknown>)["text"] as string;
      return { ok: true, result: true } as never;
    }
    if (method === "sendMessage") {
      lastMessageText = (payload as Record<string, unknown>)["text"] as string;
    }
    return {
      ok: true,
      result: { message_id: captured.length, date: Math.floor(Date.now() / 1000), chat: { id: 0, type: "private" } },
    } as never;
  });

  bot.command("requests", makeRequestsListHandler(db));
  bot.callbackQuery(REQ_PAGE_PATTERN, makeRequestsPageCallbackHandler(db));
  bot.callbackQuery(REQ_OPEN_PATTERN, makeRequestDetailCallbackHandler(db));
  bot.callbackQuery(REQ_APPROVE_CONFIRM_PATTERN, makeRequestApproveConfirmCallbackHandler(db, sender));
  bot.callbackQuery(REQ_APPROVE_CANCEL_PATTERN, makeRequestApproveCancelCallbackHandler(db));
  bot.callbackQuery(REQ_APPROVE_PATTERN, makeRequestApproveCallbackHandler(db, sender));
  bot.callbackQuery(REQ_REJECT_PATTERN, makeRequestRejectCallbackHandler(db));
  bot.on("message:text", makeRequestRejectTextReplyHandler(db, sender));

  return { bot, captured, getLastMessageText: () => lastMessageText };
}

let nextUpdateId = 1;
let nextTgId = 1_021_000_000;

function callbackUpdate(tgId: number, data: string, messageText: string) {
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
        text: messageText,
      },
    },
  };
}

function replyUpdate(tgId: number, text: string, repliedToText: string) {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: tgId, type: "private" as const },
      from: { id: tgId, is_bot: false, first_name: "Test" },
      text,
      reply_to_message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: tgId, type: "private" as const },
        text: repliedToText,
      },
    },
  };
}

function textOf(entry: Captured | undefined): string | undefined {
  return entry?.payload["text"] as string | undefined;
}

async function seedChapter(code: string): Promise<string> {
  const rows = await db
    .insert(schema.chapters)
    .values({ code, name: code, timezone: "Asia/Tashkent", defaultLang: "en", active: true })
    .returning({ id: schema.chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedVenue(chapterId: string): Promise<string> {
  const rows = await db
    .insert(schema.venues)
    .values({ chapterId, name: "Test Venue", address: "1 Test St", capacity: 500 })
    .returning({ id: schema.venues.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedVenue: no row returned");
  return row.id;
}

async function seedUser(tgId: number, opts: { role?: "member" | "organizer" | "owner"; chapterId?: string | null } = {}) {
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `u${tgId}`, lang: "en" });
  if (opts.role !== undefined || opts.chapterId !== undefined) {
    await db
      .update(users)
      .set({
        ...(opts.role !== undefined ? { role: opts.role } : {}),
        ...(opts.chapterId !== undefined ? { chapterId: opts.chapterId } : {}),
      })
      .where(eq(users.id, user.id));
  }
  return user;
}

async function seedEvent(chapterId: string, capacity: number): Promise<{ id: string; title: string; organizerId: string }> {
  const venueId = await seedVenue(chapterId);
  const organizerTgId = nextTgId++;
  const organizer = await seedUser(organizerTgId, { role: "organizer", chapterId });
  const title = `REQ-035 Handler Event ${Date.now()}-${Math.random()}`;
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
      requiresInvite: false,
      requiresApproval: true,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, title, new Date());
  return { id: eventId, title, organizerId: organizer.id };
}

async function seedPendingRequest(eventId: string): Promise<{ registrationId: string; userId: string; tgId: number }> {
  const tgId = nextTgId++;
  const user = await seedUser(tgId);
  const result = await registerForEvent(db, user.id, eventId, new Date("2026-09-01T00:00:00Z"));
  if (result.kind !== "requested" || result.registrationId === undefined) {
    throw new Error(`seedPendingRequest: expected 'requested', got ${result.kind}`);
  }
  return { registrationId: result.registrationId, userId: user.id, tgId };
}

async function getRegistrationRow(registrationId: string) {
  const rows = await db.select().from(registrations).where(eq(registrations.id, registrationId));
  return rows[0]!;
}

async function countAuditRows(entityId: string): Promise<number> {
  const rows = await db.select({ id: auditLog.id }).from(auditLog).where(eq(auditLog.entityId, entityId));
  return rows.length;
}

const catalog = getCatalog("en");

describe("AC1 -- approving sets admission=admitted, issues a non-null qr_token, and notifies the person", () => {
  it("organizer taps Approve; row reads back admitted with a 64-hex-char qr_token; the registrant is notified with the event title", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterCode = `ac1-${Date.now()}`;
    const chapterId = await seedChapter(chapterCode);
    const event = await seedEvent(chapterId, 5);
    const req = await seedPendingRequest(event.id);
    const organizerTgId = nextTgId++;
    await seedUser(organizerTgId, { role: "organizer", chapterId });

    const { sender, sent } = makeFakeSender();
    const { bot } = makeTestBot(sender);

    await bot.handleUpdate(callbackUpdate(organizerTgId, `req:approve:${req.registrationId}`, "detail view") as never);

    const row = await getRegistrationRow(req.registrationId);
    expect(row.admission).toBe("admitted");
    expect(row.qrToken).not.toBeNull();
    expect(row.qrToken).toMatch(/^[0-9a-f]{64}$/);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.tgId).toBe(BigInt(req.tgId));
    expect(sent[0]!.text).toContain(event.title);
    expect(sent[0]!.text).not.toContain("{event}"); // the placeholder must be replaced, not leaked verbatim
  });
});

describe("AC2 -- rejecting sets admission=rejected, notifies with BOTH the reason and the onward path", () => {
  it("organizer taps Reject, supplies a reason via reply; row reads back rejected; the captured message carries the verbatim reason and the events-list onward path", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter(`ac2-${Date.now()}`);
    const event = await seedEvent(chapterId, 5);
    const req = await seedPendingRequest(event.id);
    const organizerTgId = nextTgId++;
    await seedUser(organizerTgId, { role: "organizer", chapterId });

    const { sender, sent } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);

    await bot.handleUpdate(callbackUpdate(organizerTgId, `req:reject:${req.registrationId}`, "detail view") as never);

    const promptEntry = captured.find((c) => c.method === "sendMessage");
    const promptText = textOf(promptEntry);
    expect(promptText).toBeDefined();
    expect(promptText!).toContain(`Reject ref: ${req.registrationId}`);
    expect(promptText!).toBe(formatRejectReasonPrompt(catalog.organizerRequests.rejectReasonPrompt, req.registrationId));

    const REASON = "Sorry, we've reached capacity for this cohort's meetup track.";
    await bot.handleUpdate(replyUpdate(organizerTgId, REASON, promptText!) as never);

    const row = await getRegistrationRow(req.registrationId);
    expect(row.admission).toBe("rejected");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.tgId).toBe(BigInt(req.tgId));
    expect(sent[0]!.text).toContain(REASON);
    expect(sent[0]!.text).toContain(catalog.event.deepLinkSeeUpcoming);

    expect(await countAuditRows(req.registrationId)).toBe(1);
    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, req.registrationId));
    expect(auditRows[0]!.action).toBe("registration.reject");
    expect((auditRows[0]!.payload as { reason?: string } | null)?.reason).toBe(REASON);
  });
});

describe("AC4 -- at-capacity approve requires explicit confirmation; dismiss leaves it unchanged; confirm admits and logs the override", () => {
  it("dismissing the override prompt leaves admission=requested unchanged and sends no notification; confirming admits and writes exactly one override audit row", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter(`ac4-${Date.now()}`);
    const event = await seedEvent(chapterId, 1); // capacity 1
    const reqA = await seedPendingRequest(event.id);
    const reqB = await seedPendingRequest(event.id);
    const organizerTgId = nextTgId++;
    await seedUser(organizerTgId, { role: "organizer", chapterId });

    const { sender, sent } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);

    // Fill the only seat with reqA.
    await bot.handleUpdate(callbackUpdate(organizerTgId, `req:approve:${reqA.registrationId}`, "detail A") as never);
    expect((await getRegistrationRow(reqA.registrationId)).admission).toBe("admitted");
    expect(sent).toHaveLength(1);

    // reqB now hits the capacity gate.
    await bot.handleUpdate(callbackUpdate(organizerTgId, `req:approve:${reqB.registrationId}`, "detail B") as never);
    const rowAfterFirstTap = await getRegistrationRow(reqB.registrationId);
    expect(rowAfterFirstTap.admission).toBe("requested"); // unchanged -- only offered a prompt
    expect(await countAuditRows(reqB.registrationId)).toBe(0);
    expect(sent).toHaveLength(1); // no second notification yet

    // Dismiss.
    await bot.handleUpdate(callbackUpdate(organizerTgId, `req:approve_cancel:${reqB.registrationId}`, "override prompt") as never);
    const rowAfterDismiss = await getRegistrationRow(reqB.registrationId);
    expect(rowAfterDismiss.admission).toBe("requested"); // still unchanged
    expect(await countAuditRows(reqB.registrationId)).toBe(0); // no audit row from the dismiss
    expect(sent).toHaveLength(1); // still no notification for reqB
    const cancelReply = captured.filter((c) => c.method === "sendMessage").at(-1);
    expect(textOf(cancelReply)).toBe(catalog.organizerRequests.overrideCancelledNote);

    // Approve again -> same gate -> confirm this time.
    await bot.handleUpdate(callbackUpdate(organizerTgId, `req:approve:${reqB.registrationId}`, "detail B again") as never);
    await bot.handleUpdate(callbackUpdate(organizerTgId, `req:approve_confirm:${reqB.registrationId}`, "override prompt 2") as never);

    const rowAfterConfirm = await getRegistrationRow(reqB.registrationId);
    expect(rowAfterConfirm.admission).toBe("admitted");
    expect(rowAfterConfirm.qrToken).not.toBeNull();
    expect(await countAuditRows(reqB.registrationId)).toBe(1);
    const auditRows = await db.select().from(auditLog).where(eq(auditLog.entityId, reqB.registrationId));
    expect(auditRows[0]!.action).toBe("registration.approve_override");
    expect(sent).toHaveLength(2); // reqA's + reqB's, and no more
  });
});

describe("AC6 -- a member, and separately an EventStaff member, invoking approve directly are both refused, registration unchanged", () => {
  it("a plain member constructing req:approve:<id> callback data is refused with the registration unchanged", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter(`ac6a-${Date.now()}`);
    const event = await seedEvent(chapterId, 5);
    const req = await seedPendingRequest(event.id);
    const memberTgId = nextTgId++;
    await seedUser(memberTgId, { role: "member" });

    const { sender, sent } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);

    await bot.handleUpdate(callbackUpdate(memberTgId, `req:approve:${req.registrationId}`, "detail view") as never);

    const row = await getRegistrationRow(req.registrationId);
    expect(row.admission).toBe("requested");
    expect(row.qrToken).toBeNull();
    expect(await countAuditRows(req.registrationId)).toBe(0);
    expect(sent).toHaveLength(0);
    const answer = captured.find((c) => c.method === "answerCallbackQuery");
    expect((answer?.payload["text"] as string | undefined)).toBe(catalog.organizerRequests.notAuthorized);
  });

  it("an EventStaff member for that same event constructing req:approve:<id> callback data is refused with the registration unchanged", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter(`ac6b-${Date.now()}`);
    const event = await seedEvent(chapterId, 5);
    const req = await seedPendingRequest(event.id);
    const staffTgId = nextTgId++;
    const staffUser = await seedUser(staffTgId, { role: "member" });
    await addEventStaff(db, event.organizerId, event.id, staffUser.id, event.title, new Date());

    const { sender, sent } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);

    await bot.handleUpdate(callbackUpdate(staffTgId, `req:approve:${req.registrationId}`, "detail view") as never);

    const row = await getRegistrationRow(req.registrationId);
    expect(row.admission).toBe("requested");
    expect(row.qrToken).toBeNull();
    expect(await countAuditRows(req.registrationId)).toBe(0);
    expect(sent).toHaveLength(0);
    const answer = captured.find((c) => c.method === "answerCallbackQuery");
    expect((answer?.payload["text"] as string | undefined)).toBe(catalog.organizerRequests.notAuthorized);
  });
});

describe("AC7 -- a chapter-A organizer invoking approve on a chapter-B event is refused", () => {
  it("organizer scoped to chapter A cannot approve a request against chapter B's event", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterA = await seedChapter(`ac7-a-${Date.now()}`);
    const chapterB = await seedChapter(`ac7-b-${Date.now()}`);
    const eventB = await seedEvent(chapterB, 5);
    const req = await seedPendingRequest(eventB.id);
    const organizerATgId = nextTgId++;
    await seedUser(organizerATgId, { role: "organizer", chapterId: chapterA });

    const { sender, sent } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);

    await bot.handleUpdate(callbackUpdate(organizerATgId, `req:approve:${req.registrationId}`, "detail view") as never);

    const row = await getRegistrationRow(req.registrationId);
    expect(row.admission).toBe("requested");
    expect(row.qrToken).toBeNull();
    expect(await countAuditRows(req.registrationId)).toBe(0);
    expect(sent).toHaveLength(0);
    const answer = captured.find((c) => c.method === "answerCallbackQuery");
    expect((answer?.payload["text"] as string | undefined)).toBe(catalog.organizerRequests.notAuthorized);
  });
});

describe("AC9 -- both notifications reach a user with broadcast_opt_in=false", () => {
  it("the approval notification is sent to a registrant with broadcast_opt_in=false", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter(`ac9a-${Date.now()}`);
    const event = await seedEvent(chapterId, 5);
    const req = await seedPendingRequest(event.id);
    await db.update(users).set({ broadcastOptIn: false, blocked: false }).where(eq(users.id, req.userId));
    const organizerTgId = nextTgId++;
    await seedUser(organizerTgId, { role: "organizer", chapterId });

    const { sender, sent } = makeFakeSender();
    const { bot } = makeTestBot(sender);

    await bot.handleUpdate(callbackUpdate(organizerTgId, `req:approve:${req.registrationId}`, "detail view") as never);

    expect(sent).toHaveLength(1);
    expect(sent[0]!.tgId).toBe(BigInt(req.tgId));
    const userRow = (await db.select().from(users).where(eq(users.id, req.userId)))[0]!;
    expect(userRow.broadcastOptIn).toBe(false); // unchanged -- confirms this wasn't flipped to make the send possible
  });

  it("the rejection notification is sent to a registrant with broadcast_opt_in=false", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter(`ac9b-${Date.now()}`);
    const event = await seedEvent(chapterId, 5);
    const req = await seedPendingRequest(event.id);
    await db.update(users).set({ broadcastOptIn: false, blocked: false }).where(eq(users.id, req.userId));
    const organizerTgId = nextTgId++;
    await seedUser(organizerTgId, { role: "organizer", chapterId });

    const { sender, sent } = makeFakeSender();
    const { bot } = makeTestBot(sender);

    await bot.handleUpdate(callbackUpdate(organizerTgId, `req:reject:${req.registrationId}`, "detail view") as never);
    await bot.handleUpdate(
      replyUpdate(organizerTgId, "Not a fit this time.", formatRejectReasonPrompt(catalog.organizerRequests.rejectReasonPrompt, req.registrationId)) as never,
    );

    expect(sent).toHaveLength(1);
    expect(sent[0]!.tgId).toBe(BigInt(req.tgId));
    const userRow = (await db.select().from(users).where(eq(users.id, req.userId)))[0]!;
    expect(userRow.broadcastOptIn).toBe(false);
  });
});
