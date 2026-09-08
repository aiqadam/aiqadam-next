import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { auditLog, chapters, profiles, registrations, users, venues } from "../db/schema.js";
import { createEvent, publishEvent } from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { recordConsent } from "../domain/consent.js";
import { getInviteCodeById, issueCompanionInviteCode } from "../domain/inviteCode.js";
import type { NotificationSender } from "../domain/notification.js";
import { makeConsentCallbackHandler, makeStartHandler } from "./start.js";
import {
  COMPANION_CANCEL_CALLBACK,
  COMPANION_CONFIRM_PATTERN,
  makeCompanionCancelCallbackHandler,
  makeCompanionConfirmCallbackHandler,
  makeCompanionTextReplyHandler,
} from "./companion.js";

// docs/agents/design/REQ-039.md -- AC3, AC4 (full flow), AC6 (full single-use flow through both
// entry points), AC7, AC8, and the returning-guest fix. Real grammY dispatch
// (bot.handleUpdate) against a live scratch Postgres, same infrastructure/skip discipline as
// handlers/redeem.db.test.ts / handlers/feedback.db.test.ts's reply-to-message pattern.

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT grants_companion_of FROM invite_codes LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    console.warn(
      `[companion.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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

function makeTestBot(sender: NotificationSender): { bot: Bot; captured: Captured[] } {
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

  // Same registration order as index.ts's own companion block: start command,
  // consent callback, companion confirm/cancel callbacks, then the generic
  // message:text reply listener last.
  bot.command("start", makeStartHandler(db, sender));
  bot.callbackQuery(/^consent:agree(?::.+)?$/, makeConsentCallbackHandler(db, sender));
  bot.callbackQuery(COMPANION_CONFIRM_PATTERN, makeCompanionConfirmCallbackHandler(db, sender));
  bot.callbackQuery(COMPANION_CANCEL_CALLBACK, makeCompanionCancelCallbackHandler());
  bot.on("message:text", makeCompanionTextReplyHandler(db));

  return { bot, captured };
}

let nextUpdateId = 1;
let nextTgId = 1_062_000_000;

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
        message_id: nextUpdateId - 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: tgId, type: "private" as const },
        text: repliedToText,
      },
    },
  };
}

function companionConfirmCallbackUpdate(tgId: number, inviteCodeId: string, messageText: string) {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cbq_${nextUpdateId}`,
      from: { id: tgId, is_bot: false, first_name: "Test" },
      chat_instance: "test-chat-instance",
      data: `companion_confirm:${inviteCodeId}`,
      message: {
        message_id: 3,
        date: Math.floor(Date.now() / 1000),
        chat: { id: tgId, type: "private" as const },
        text: messageText,
      },
    },
  };
}

function textOf(entry: Captured | undefined): string {
  return (entry?.payload["text"] as string | undefined) ?? "";
}

function lastSendOrEdit(captured: Captured[]): Captured | undefined {
  return [...captured].reverse().find((c) => c.method === "sendMessage" || c.method === "editMessageText");
}

let chapterSeq = 0;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(chapters)
    .values({ code: `req039h-chapter-${chapterSeq}`, name: `REQ-039 Handler Chapter ${chapterSeq}`, timezone: "Asia/Tashkent", defaultLang: "en", active: true })
    .returning({ id: chapters.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedChapter: no row returned");
  return row.id;
}

async function seedVenue(chapterId: string): Promise<string> {
  const rows = await db
    .insert(venues)
    .values({ chapterId, name: "REQ-039 Handler Venue", address: "1 Test St", capacity: 500 })
    .returning({ id: venues.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedVenue: no row returned");
  return row.id;
}

async function seedPublishedEvent(chapterId: string, capacity: number): Promise<{ id: string; title: string; organizerId: string }> {
  const venueId = await seedVenue(chapterId);
  const organizerTgId = nextTgId++;
  const organizer = await resolveOrCreateUser(db, { tgId: BigInt(organizerTgId), tgUsername: `u${organizerTgId}`, lang: "en" });
  const title = `REQ-039 Handler Event ${Date.now()}-${Math.random()}`;
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
      requiresApproval: false,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, title, new Date());
  return { id: eventId, title, organizerId: organizer.id };
}

async function seedHost(): Promise<{ id: string; tgId: number }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `host${tgId}`, lang: "en" });
  return { id: user.id, tgId };
}

async function seedConsentedGuest(): Promise<{ id: string; tgId: number }> {
  const tgId = nextTgId++;
  const user = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: `g${tgId}`, lang: "en" });
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

async function registrationCount(eventId: string, userId: string): Promise<number> {
  const rows = await db
    .select({ id: registrations.id })
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)));
  return rows.length;
}

async function profileCount(userId: string): Promise<number> {
  const rows = await db.select({ id: profiles.id }).from(profiles).where(eq(profiles.userId, userId));
  return rows.length;
}

async function userRow(tgId: number) {
  const rows = await db.select().from(users).where(eq(users.tgId, BigInt(tgId)));
  return rows[0] ?? null;
}

// Drives one brand-new guest through the full flow: /start i_<code>, consent
// tap, field reply, confirm tap. Returns the captured bot messages and the
// invite code id for follow-up assertions.
async function runFullCompanionFlow(
  bot: Bot,
  captured: Captured[],
  tgId: number,
  code: string,
  fields: { name: string; company: string; phone: string },
): Promise<{ inviteCodeId: string }> {
  await bot.handleUpdate(commandUpdate(tgId, `/start i_${code}`) as never); // consent prompt
  await bot.handleUpdate(consentAgreeCallbackUpdate(tgId, `i_${code}`) as never); // -> field prompt
  const fieldPromptText = textOf(lastSendOrEdit(captured));

  const codeRow = await db
    .select({ id: schema.inviteCodes.id })
    .from(schema.inviteCodes)
    .where(eq(schema.inviteCodes.code, code));
  const inviteCodeId = codeRow[0]!.id;

  await bot.handleUpdate(
    replyUpdate(tgId, `${fields.name} | ${fields.company} | ${fields.phone}`, fieldPromptText) as never,
  ); // -> confirm message
  const confirmText = textOf(lastSendOrEdit(captured));

  await bot.handleUpdate(companionConfirmCallbackUpdate(tgId, inviteCodeId, confirmText) as never); // -> the write

  return { inviteCodeId };
}

// ---------------------------------------------------------------------------
// AC3 -- abandoning the companion flow AT OR BEFORE consent leaves zero new
// profiles rows and zero new registrations rows for that guest. See this
// file's own header note on the corrected scope of AC3's "zero users rows"
// wording (SECURITY-REVIEWER, step-02c handoff).
// ---------------------------------------------------------------------------
describe("AC3 -- abandoning at or before consent leaves zero profiles/registrations rows", () => {
  it("brand-new guest abandons BEFORE tapping consent:agree: zero profiles, zero registrations; the baseline users row carries no PII beyond tg_id/tg_username/lang, consent_pd_at still null", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const host = await seedHost();
    const issued = await issueCompanionInviteCode(db, event.organizerId, event.id, host.id, new Date("2027-01-01T00:00:00Z"), new Date());
    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    const tgId = nextTgId++;

    await bot.handleUpdate(commandUpdate(tgId, `/start i_${issued.code}`) as never);

    expect(captured.some((c) => c.method === "sendMessage")).toBe(true); // consent prompt shown
    const user = await userRow(tgId);
    expect(user).not.toBeNull();
    expect(user?.consentPdAt).toBeNull();
    expect(user?.chapterId).toBeNull();
    // No column on `users` even exists to carry a name/phone/company (confirmed
    // against schema.ts's users table definition) -- the only place PII for
    // this guest could land is `profiles`, asserted zero below.
    expect(await profileCount(user!.id)).toBe(0);
    expect(await registrationCount(event.id, user!.id)).toBe(0);
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(0);
  });

  it("brand-new guest taps consent:agree (legitimate write) but abandons BEFORE replying with fields: zero profiles, zero registrations", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const host = await seedHost();
    const issued = await issueCompanionInviteCode(db, event.organizerId, event.id, host.id, new Date("2027-01-01T00:00:00Z"), new Date());
    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    const tgId = nextTgId++;

    await bot.handleUpdate(commandUpdate(tgId, `/start i_${issued.code}`) as never);
    await bot.handleUpdate(consentAgreeCallbackUpdate(tgId, `i_${issued.code}`) as never); // -> field prompt, no write

    expect(captured.some((c) => c.method === "sendMessage")).toBe(true);
    const user = await userRow(tgId);
    expect(user?.consentPdAt).not.toBeNull(); // consent itself is a legitimate, already-given write
    expect(await profileCount(user!.id)).toBe(0);
    expect(await registrationCount(event.id, user!.id)).toBe(0);
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// AC4 -- completing the flow collects name, phone and company and nothing
// further: walked end to end via the real conversation, confirming the
// registration and Profile rows land correctly and no experience-level/
// student-flag/links question is ever asked (grepped from every message the
// bot sent during the flow).
// ---------------------------------------------------------------------------
describe("AC4 -- completing the flow collects exactly name/phone/company, nothing further", () => {
  it("full flow (consent -> field reply -> confirm tap) admits, sets invited_by_user_id, writes exactly name/company/phone; no message sent anywhere in the flow asks about experience/student/links", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const host = await seedHost();
    const issued = await issueCompanionInviteCode(db, event.organizerId, event.id, host.id, new Date("2027-01-01T00:00:00Z"), new Date());
    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    const tgId = nextTgId++;

    await runFullCompanionFlow(bot, captured, tgId, issued.code, {
      name: "Companion Guest",
      company: "Beta LLC",
      phone: "+998907654321",
    });

    const user = await userRow(tgId);
    const row = await registrationRow(event.id, user!.id);
    expect(row?.admission).toBe("admitted");
    expect(row?.invitedByUserId).toBe(host.id);
    expect(row?.inviteCodeId).toBe(issued.id);

    const profileRows = await db.select().from(profiles).where(eq(profiles.userId, user!.id));
    const profile = profileRows[0];
    expect(profile?.firstName).toBe("Companion Guest");
    expect(profile?.company).toBe("Beta LLC");
    expect(profile?.phone).toBe("+998907654321");
    expect(profile?.email).toBeNull();
    expect(profile?.position).toBeNull();
    expect(profile?.isStudent).toBeNull();
    expect(profile?.experienceLevel).toBeNull();
    expect(profile?.linksGithub).toBeNull();
    expect(profile?.linksLinkedin).toBeNull();
    expect(profile?.linksSite).toBeNull();

    // No message the bot sent anywhere in this whole flow asks about
    // experience level, student status, or links -- the reduced field set
    // (AC4/USER-STORIES B8) is the entire conversation.
    const allSentText = captured
      .filter((c) => c.method === "sendMessage" || c.method === "editMessageText")
      .map((c) => textOf(c))
      .join("\n")
      .toLowerCase();
    expect(allSentText).not.toMatch(/experience|student|github|linkedin|portfolio|website link/);
  });
});

// ---------------------------------------------------------------------------
// AC6 -- a second person attempting to redeem a single-use companion code is
// refused and no registration is created, exercised through the full
// conversation for BOTH guests (unlike File 1's domain-level shape, this
// proves the handler-level UX -- guest B is still shown the field-collection
// prompt, since spent-ness is only known once the confirm tap actually calls
// redeemInviteCode) and confirms the host is notified exactly once overall.
// ---------------------------------------------------------------------------
describe("AC6 -- single-use companion code: second guest's full conversation ends in refusal, host notified only once", () => {
  it("guestA completes the flow (admitted); guestB independently completes the SAME conversation shape and is refused at the confirm step; zero registration/profile for guestB; host notified exactly once total", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const host = await seedHost();
    const issued = await issueCompanionInviteCode(db, event.organizerId, event.id, host.id, new Date("2027-01-01T00:00:00Z"), new Date());
    const { sender, sent } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);

    const tgIdA = nextTgId++;
    await runFullCompanionFlow(bot, captured, tgIdA, issued.code, { name: "Guest A", company: "A Co", phone: "+998900000011" });
    const userA = await userRow(tgIdA);
    expect((await registrationRow(event.id, userA!.id))?.admission).toBe("admitted");
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(1);

    const tgIdB = nextTgId++;
    captured.length = 0;
    await runFullCompanionFlow(bot, captured, tgIdB, issued.code, { name: "Guest B", company: "B Co", phone: "+998900000012" });
    const userB = await userRow(tgIdB);
    expect(await registrationCount(event.id, userB!.id)).toBe(0);
    expect(await profileCount(userB!.id)).toBe(0);
    expect((await getInviteCodeById(db, issued.id))?.usedCount).toBe(1); // unchanged

    // Refusal message shown to guest B, editMessageText from the confirm
    // callback's own reply step.
    expect(captured.some((c) => c.method === "editMessageText")).toBe(true);

    // The host was notified exactly once overall (guestA's admission only) --
    // guestB's refusal never reaches the "writing outcomes" branch that
    // triggers a host notification.
    expect(sent.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// AC7 -- both guest and host receive exactly one message on a successful
// companion registration; the host's message contains the guest's name and
// company and neither phone nor email. Exercised via the RETURNING-GUEST
// direct-redemption branch (the returning-guest fix, tested here per this
// run's brief), which is also the exact construction AC7's own issue text
// asks for: "storing both [phone AND email] on the guest" -- a brand-new
// guest never has an email at all (the companion flow never asks for one),
// so only a returning guest with a pre-existing, richer Profile row can
// genuinely exercise the "neither phone nor email" assertion against a
// guest who actually HAS an email on file.
// ---------------------------------------------------------------------------
describe("AC7 -- exactly one message each; host sees name+company only, never phone or email", () => {
  it("returning guest (existing Profile row with BOTH phone and email set) redeems directly: exactly one message to guest, exactly one to host; host's message contains name+company, neither phone nor email", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const host = await seedHost();
    const issued = await issueCompanionInviteCode(db, event.organizerId, event.id, host.id, new Date("2027-01-01T00:00:00Z"), new Date());

    const guest = await seedConsentedGuest();
    const guestPhone = "+998909998877";
    const guestEmail = "returning.guest@example.com";
    await db.insert(profiles).values({
      userId: guest.id,
      firstName: "Returning Guest",
      company: "Gamma Inc",
      phone: guestPhone,
      email: guestEmail,
    });

    const { sender, sent } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);

    await bot.handleUpdate(commandUpdate(guest.tgId, `/start i_${issued.code}`) as never);

    // Exactly one message to the guest: the field-collection conversation was
    // skipped entirely (existingProfile !== null), so the single reply IS the
    // registration outcome.
    const guestMessages = captured.filter((c) => c.method === "sendMessage" || c.method === "editMessageText");
    expect(guestMessages.length).toBe(1);

    const row = await registrationRow(event.id, guest.id);
    expect(row?.admission).toBe("admitted");
    expect(row?.invitedByUserId).toBe(host.id); // the returning-guest fix: attribution still holds

    // Exactly one message to the host.
    expect(sent.length).toBe(1);
    const hostMessage = sent[0]!.text;
    expect(hostMessage).toContain("Returning Guest");
    expect(hostMessage).toContain("Gamma Inc");
    expect(hostMessage).not.toContain(guestPhone);
    expect(hostMessage).not.toContain(guestEmail);

    // The pre-existing, richer Profile row was left untouched (companionProfile
    // stays null on this branch -- no INSERT, and onConflictDoNothing would
    // no-op even under a race).
    expect(await profileCount(guest.id)).toBe(1);
    const profileRows = await db.select().from(profiles).where(eq(profiles.userId, guest.id));
    expect(profileRows[0]?.email).toBe(guestEmail);
  });
});

// ---------------------------------------------------------------------------
// AC8 -- the guest's phone appears in NO log line and in NO audit_log
// payload.
// ---------------------------------------------------------------------------
describe("AC8 -- guest's phone appears in no log line and no audit_log payload", () => {
  it("after a full successful companion flow, no audit_log row's payload/action/entity contains the guest's phone string", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const host = await seedHost();
    const issued = await issueCompanionInviteCode(db, event.organizerId, event.id, host.id, new Date("2027-01-01T00:00:00Z"), new Date());
    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);
    const tgId = nextTgId++;
    const phone = "+998901237890";

    await runFullCompanionFlow(bot, captured, tgId, issued.code, { name: "Audit Check Guest", company: "Delta", phone });

    const allAuditRows = await db.select().from(auditLog);
    expect(allAuditRows.length).toBeGreaterThan(0);
    for (const row of allAuditRows) {
      expect(row.action).not.toContain(phone);
      expect(row.entity).not.toContain(phone);
      expect(JSON.stringify(row.payload)).not.toContain(phone);
    }
  });

  it("static: no console/logger call anywhere in inviteCode.ts, companion.ts, or start.ts -- structurally, no log line can ever carry the guest's phone", () => {
    const repoRoot = join(import.meta.dirname, "..", "..", "..", "..");
    const filesToCheck = [
      join(repoRoot, "apps", "bot", "src", "domain", "inviteCode.ts"),
      join(repoRoot, "apps", "bot", "src", "handlers", "companion.ts"),
      join(repoRoot, "apps", "bot", "src", "handlers", "start.ts"),
    ];
    for (const filePath of filesToCheck) {
      const text = readFileSync(filePath, "utf8");
      expect(text, `${filePath} must contain no console./logger. call`).not.toMatch(/console\.|logger\./);
    }
  });
});

// ---------------------------------------------------------------------------
// Returning-guest fix (not its own AC, core to this rework): a guest with an
// EXISTING Profile row redeems a companion code -> skips field-collection,
// redeems directly, invited_by_user_id still set correctly, host still
// notified. (AC7's own describe block above already exercises this end to
// end with the phone/email content assertions; this block adds the
// skip-conversation and idempotent-insert shape explicitly.)
// ---------------------------------------------------------------------------
describe("Returning guest -- existing Profile row skips field-collection, redeems directly, attribution and host notification still hold", () => {
  it("no field-collection prompt is ever sent to a returning guest (only one bot message total: the outcome)", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const chapterId = await seedChapter();
    const event = await seedPublishedEvent(chapterId, 10);
    const host = await seedHost();
    const issued = await issueCompanionInviteCode(db, event.organizerId, event.id, host.id, new Date("2027-01-01T00:00:00Z"), new Date());

    const guest = await seedConsentedGuest();
    await db.insert(profiles).values({
      userId: guest.id,
      firstName: "Already Onboarded",
      company: "Existing Co",
      phone: "+998900001234",
    });

    const { sender } = makeFakeSender();
    const { bot, captured } = makeTestBot(sender);

    await bot.handleUpdate(commandUpdate(guest.tgId, `/start i_${issued.code}`) as never);

    const sentTexts = captured
      .filter((c) => c.method === "sendMessage" || c.method === "editMessageText")
      .map((c) => textOf(c));
    expect(sentTexts.length).toBe(1); // no "reply with Name | Company | Phone" prompt anywhere
    expect(sentTexts[0]).not.toMatch(/Name \| Company \| Phone/i);

    const row = await registrationRow(event.id, guest.id);
    expect(row?.admission).toBe("admitted");
    expect(row?.invitedByUserId).toBe(host.id);
    expect(await profileCount(guest.id)).toBe(1); // no second Profile row inserted
  });
});
