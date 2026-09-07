import { Pool } from "pg";
import { PNG } from "pngjs";
import * as jsQRModule from "jsqr";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { registrations } from "../db/schema.js";
import {
  buildEventCardContent,
  createEvent,
  getEventByIdWithChapterTimezone,
  publishEvent,
  updateEvent,
} from "../domain/event.js";
import { resolveOrCreateUser } from "../domain/user.js";
import { registerForEvent } from "../domain/registration.js";
import { getVenueById } from "../domain/venue.js";
import type { NotificationButton, NotificationSender } from "../domain/notification.js";
import { makeReminder24hJob, makeReminder3hJob } from "./reminderJobs.js";

// docs/agents/design/REQ-026.md — job-level verification for AC1, AC4, AC5,
// AC6, AC7, AC8, AC10 (AC2/AC3 covered elsewhere: handlers/reminder24h.test.ts
// and the genuine two-process kill scripts). Real Postgres, same
// infrastructure/skip discipline as domain/notification.test.ts.

type JsQRFn = (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const jsQRCandidate = jsQRModule as unknown as { default?: JsQRFn } & JsQRFn;
const jsQR: JsQRFn = typeof jsQRCandidate.default === "function" ? jsQRCandidate.default : jsQRCandidate;

async function decodePng(buffer: Buffer): Promise<string | null> {
  const png = PNG.sync.read(buffer);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return decoded?.data ?? null;
}

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
      `[reminderJobs.db.test.ts] skipping DB-backed suite: scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated -- ${(err as Error).message}`,
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

let chapterSeq = 0;
let nextTgId = 970_000_000;

async function seedChapter(): Promise<string> {
  chapterSeq += 1;
  const rows = await db
    .insert(schema.chapters)
    .values({
      code: `chapter-req026-${chapterSeq}`,
      name: `Chapter REQ-026 ${chapterSeq}`,
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
    .values({
      chapterId,
      name: "Test Venue",
      address: "123 Test St, Test City",
      yandexUrl: "https://yandex.example/map",
      googleUrl: "https://google.example/map",
      capacity: 100,
    })
    .returning({ id: schema.venues.id });
  const row = rows[0];
  if (row === undefined) throw new Error("seedVenue: no row returned");
  return row.id;
}

interface SeedEventOptions {
  startsAt: Date;
  endsAt: Date;
  capacity?: number;
}

async function seedPublishedEvent(chapterId: string, opts: SeedEventOptions): Promise<string> {
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
      title: "Reminder Job Test Event",
      description: "A test event",
      format: "meetup",
      venueId,
      startsAt: opts.startsAt,
      endsAt: opts.endsAt,
      registrationClosesAt: null,
      capacity: opts.capacity ?? 5,
      requiresInvite: false,
      requiresApproval: false,
      coverFileId: null,
    },
    new Date(),
  );
  await publishEvent(db, organizer.id, eventId, chapterId, "Reminder Job Test Event", new Date());
  return eventId;
}

async function seedOrganizer(): Promise<string> {
  const organizer = await resolveOrCreateUser(db, {
    tgId: BigInt(nextTgId++),
    tgUsername: `organizer${nextTgId}`,
    lang: "ru",
  });
  return organizer.id;
}

async function seedAdmittedRegistration(
  eventId: string,
  opts: { broadcastOptIn?: boolean; registerAt?: Date } = {},
): Promise<{ userId: string; registrationId: string }> {
  const user = await resolveOrCreateUser(db, {
    tgId: BigInt(nextTgId++),
    tgUsername: `member${nextTgId}`,
    lang: "ru",
  });
  if (opts.broadcastOptIn !== undefined) {
    await db
      .update(schema.users)
      .set({ broadcastOptIn: opts.broadcastOptIn })
      .where(eq(schema.users.id, user.id));
  }
  // Register at a time well before the event's own startsAt/endsAt fixture
  // window -- never the real wall clock, since this suite's fixture events
  // are dated relative to a fixed evaluationTime, not "now" (decisions/0006).
  const registerAt = opts.registerAt ?? new Date("2026-08-31T00:00:00Z");
  const result = await registerForEvent(db, user.id, eventId, registerAt);
  if (result.kind !== "admitted" || result.registrationId === undefined) {
    throw new Error(`seedAdmittedRegistration: registerForEvent did not admit -- ${result.kind}`);
  }
  return { userId: user.id, registrationId: result.registrationId };
}

interface CapturedText {
  kind: "text";
  tgId: bigint;
  text: string;
  buttons?: NotificationButton[];
}
interface CapturedPhoto {
  kind: "photo";
  tgId: bigint;
  photo: Buffer;
  caption: string;
}
type Captured = CapturedText | CapturedPhoto;

function makeFakeSender(): { sender: NotificationSender; sent: Captured[] } {
  const sent: Captured[] = [];
  return {
    sender: {
      async send(tgId, text, buttons) {
        sent.push({ kind: "text", tgId, text, buttons });
      },
      async sendPhoto(tgId, photo, caption) {
        sent.push({ kind: "photo", tgId, photo, caption });
      },
    },
    sent,
  };
}

const BOT_USERNAME = "test_bot";

describe("makeReminder24hJob -- REQ-026 AC1: exactly one message with both buttons", () => {
  it("event exactly 24h out, 1 admitted registration -> one send, confirm+decline buttons", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-09-02T00:00:00Z"), // exactly 24h from evaluationTime
      endsAt: new Date("2026-09-02T02:00:00Z"),
    });
    const { registrationId } = await seedAdmittedRegistration(eventId);

    const { sender, sent } = makeFakeSender();
    const job = makeReminder24hJob(db, sender, 300000);
    await job.run(evaluationTime);

    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message?.kind).toBe("text");
    if (message?.kind !== "text") throw new Error("expected text message");
    expect(message.buttons).toHaveLength(2);
    expect(message.buttons?.[0]?.callbackData).toBe(`reminder24h:confirm:${registrationId}`);
    expect(message.buttons?.[1]?.callbackData).toBe(`reminder24h:decline:${registrationId}`);

    const ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, registrationId),
          eq(schema.notificationLedger.kind, "reminder_24h"),
        ),
      );
    expect(ledgerRows).toHaveLength(1);
  });
});

describe("makeReminder24hJob -- REQ-026 AC4: withdrawn before job runs -> nothing sent", () => {
  it("a registration withdrawn before either job runs is excluded from selection entirely", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-09-02T00:00:00Z"),
      endsAt: new Date("2026-09-02T02:00:00Z"),
    });
    const { registrationId } = await seedAdmittedRegistration(eventId);
    await db.update(registrations).set({ admission: "withdrawn" }).where(eq(registrations.id, registrationId));

    const { sender: sender24, sent: sent24 } = makeFakeSender();
    await makeReminder24hJob(db, sender24, 300000).run(evaluationTime);
    expect(sent24).toHaveLength(0);

    const { sender: sender3, sent: sent3 } = makeFakeSender();
    await makeReminder3hJob(db, sender3, BOT_USERNAME, 300000).run(evaluationTime);
    expect(sent3).toHaveLength(0);

    const ledgerRows = await db
      .select()
      .from(schema.notificationLedger)
      .where(eq(schema.notificationLedger.registrationId, registrationId));
    expect(ledgerRows).toHaveLength(0);
  });
});

describe("makeReminder24hJob / makeReminder3hJob -- REQ-026 AC10: broadcast_opt_in=false still receives both", () => {
  it("transactional classification bypasses broadcast_opt_in for both reminders", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    const event24 = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-09-02T00:00:00Z"),
      endsAt: new Date("2026-09-02T02:00:00Z"),
    });
    const { registrationId: reg24 } = await seedAdmittedRegistration(event24, { broadcastOptIn: false });

    // A separate chapter/event, started well outside the 24h job's own
    // window (36h out), so it is exercised ONLY by the 3h job below -- kept
    // deliberately out of the 24h window to avoid the (correct, by design)
    // over-inclusive-window overlap the 24h job would otherwise also pick up
    // for a 2h-out event (§3.1's own stated "over-inclusive" reasoning).
    const chapterId2 = await seedChapter();
    const event3 = await seedPublishedEvent(chapterId2, {
      startsAt: new Date("2026-09-01T02:00:00Z"), // 2h out -- within the 3h window
      endsAt: new Date("2026-09-01T04:00:00Z"),
    });
    const { registrationId: reg3 } = await seedAdmittedRegistration(event3, { broadcastOptIn: false });

    const { sender: sender24, sent: sent24 } = makeFakeSender();
    await makeReminder24hJob(db, sender24, 300000).run(evaluationTime);
    // The 24h job's own window also legitimately catches the 2h-out event3
    // registration (over-inclusive by design, §3.1) -- what AC10 actually
    // asserts is that reg24's own send happened despite broadcast_opt_in
    // being false, which the ledger check below verifies directly.
    expect(sent24.length).toBeGreaterThanOrEqual(1);

    const { sender: sender3, sent: sent3 } = makeFakeSender();
    await makeReminder3hJob(db, sender3, BOT_USERNAME, 300000).run(evaluationTime);
    expect(sent3.length).toBeGreaterThanOrEqual(1);

    const ledger24 = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, reg24),
          eq(schema.notificationLedger.kind, "reminder_24h"),
        ),
      );
    expect(ledger24).toHaveLength(1);

    const ledger3 = await db
      .select()
      .from(schema.notificationLedger)
      .where(
        and(
          eq(schema.notificationLedger.registrationId, reg3),
          eq(schema.notificationLedger.kind, "reminder_3h"),
        ),
      );
    expect(ledger3).toHaveLength(1);
  });
});

describe("makeReminder3hJob -- REQ-026 AC5: address, both map links, chapter-tz start, real QR decode", () => {
  it("composes a photo message with every required field and a QR decoding to the exact deep link", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-09-01T02:00:00Z"),
      endsAt: new Date("2026-09-01T04:00:00Z"),
    });
    const { registrationId } = await seedAdmittedRegistration(eventId);

    const regRow = await db.select().from(registrations).where(eq(registrations.id, registrationId));
    const qrToken = regRow[0]?.qrToken;
    expect(qrToken).toMatch(/^[0-9a-f]{64}$/);

    const { sender, sent } = makeFakeSender();
    await makeReminder3hJob(db, sender, BOT_USERNAME, 300000).run(evaluationTime);

    expect(sent).toHaveLength(1);
    const message = sent[0];
    expect(message?.kind).toBe("photo");
    if (message?.kind !== "photo") throw new Error("expected photo message");

    expect(message.caption).toContain("123 Test St, Test City");
    expect(message.caption).toContain("https://yandex.example/map");
    expect(message.caption).toContain("https://google.example/map");

    const event = await getEventByIdWithChapterTimezone(db, eventId);
    if (event === null || event.startsAt === null) throw new Error("event not found");
    const { formatDateTimeInTimezone } = await import("../i18n/formatTimeInTimezone.js");
    const startsAtText = formatDateTimeInTimezone(event.startsAt, event.chapterTimezone, "ru");
    expect(message.caption).toContain(startsAtText);

    const decoded = await decodePng(message.photo);
    expect(decoded).toBe(`https://t.me/${BOT_USERNAME}?start=ci_${qrToken}`);
  });
});

describe("makeReminder3hJob -- REQ-026 AC6/AC7/AC8: doors-time rendering", () => {
  it("AC6: a doors agenda item -> BOTH doors time and starts_at are quoted", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-09-01T02:00:00Z"),
      endsAt: new Date("2026-09-01T04:00:00Z"),
    });
    await updateEvent(
      db,
      await seedOrganizer(),
      eventId,
      chapterId,
      { agenda: [{ kind: "doors", at: "2026-09-01T01:30:00Z", label: "Doors open" }] },
      ["agenda"],
      new Date(),
    );
    await seedAdmittedRegistration(eventId);

    const { sender, sent } = makeFakeSender();
    await makeReminder3hJob(db, sender, BOT_USERNAME, 300000).run(evaluationTime);

    const message = sent[0];
    if (message?.kind !== "photo") throw new Error("expected photo message");

    const event = await getEventByIdWithChapterTimezone(db, eventId);
    if (event === null || event.startsAt === null) throw new Error("event not found");
    const { formatDateTimeInTimezone } = await import("../i18n/formatTimeInTimezone.js");
    const doorsText = formatDateTimeInTimezone(new Date("2026-09-01T01:30:00Z"), event.chapterTimezone, "ru");
    const startsText = formatDateTimeInTimezone(event.startsAt, event.chapterTimezone, "ru");

    expect(message.caption).toContain(doorsText);
    expect(message.caption).toContain(startsText);

    // AC7: byte-for-byte identical to REQ-017's own card rendering for the
    // same event/doors-item -- literal string-equality proof, not "looks
    // the same".
    const venue = event.venueId !== null ? await getVenueById(db, event.venueId) : null;
    const admittedRows = await db
      .select({ id: registrations.id })
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.admission, "admitted")));
    const cardContent = buildEventCardContent(event, venue, admittedRows.length, "ru");
    const cardDoorsLine = cardContent.agendaLines.find((line) => line.label === "Doors open");
    expect(cardDoorsLine).toBeDefined();
    expect(cardDoorsLine?.timeText).toBe(doorsText);
    expect(doorsText).toBe(cardDoorsLine?.timeText as string);
    expect(message.caption).toContain(cardDoorsLine?.timeText as string);
  });

  it("AC8: non-empty agenda with ONLY non-doors items -> starts_at alone, no doors/agenda time", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }
    const evaluationTime = new Date("2026-09-01T00:00:00Z");
    const chapterId = await seedChapter();
    const eventId = await seedPublishedEvent(chapterId, {
      startsAt: new Date("2026-09-01T02:00:00Z"),
      endsAt: new Date("2026-09-01T04:00:00Z"),
    });
    await updateEvent(
      db,
      await seedOrganizer(),
      eventId,
      chapterId,
      {
        agenda: [
          { kind: "networking", at: "2026-09-01T01:45:00Z", label: "Networking" },
          { kind: "close", at: "2026-09-01T03:45:00Z", label: "Closing" },
        ],
      },
      ["agenda"],
      new Date(),
    );
    await seedAdmittedRegistration(eventId);

    const { sender, sent } = makeFakeSender();
    await makeReminder3hJob(db, sender, BOT_USERNAME, 300000).run(evaluationTime);

    const message = sent[0];
    if (message?.kind !== "photo") throw new Error("expected photo message");

    const event = await getEventByIdWithChapterTimezone(db, eventId);
    if (event === null || event.startsAt === null) throw new Error("event not found");
    const { formatDateTimeInTimezone } = await import("../i18n/formatTimeInTimezone.js");
    const startsText = formatDateTimeInTimezone(event.startsAt, event.chapterTimezone, "ru");
    const networkingText = formatDateTimeInTimezone(new Date("2026-09-01T01:45:00Z"), event.chapterTimezone, "ru");
    const closingText = formatDateTimeInTimezone(new Date("2026-09-01T03:45:00Z"), event.chapterTimezone, "ru");

    const catalog = (await import("../i18n/catalog.js")).getCatalog("ru");
    expect(message.caption).not.toContain(catalog.reminder3h.doorsLabel);
    expect(message.caption).toContain(startsText);
    // Neither non-doors agenda item's own time ever leaks into the caption
    // (unless it happens to coincide with startsText, which these fixture
    // times do not).
    if (networkingText !== startsText) {
      expect(message.caption).not.toContain(networkingText);
    }
    if (closingText !== startsText) {
      expect(message.caption).not.toContain(closingText);
    }
  });
});
