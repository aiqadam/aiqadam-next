import { Bot } from "grammy";
import { Pool } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { afterAll, beforeAll, beforeEach, describe, it, expect } from "vitest";
import * as schema from "../db/schema.js";
import { getFlowUserByTgId, resolveOrCreateUser } from "../domain/user.js";
import { recordConsent } from "../domain/consent.js";
import { getCatalog } from "../i18n/catalog.js";
import {
  makeChapterCallbackHandler,
  makeConsentCallbackHandler,
  makeStartHandler,
} from "./start.js";

// WF02-REQ-019 REWORK (Step 2b regate FAIL,
// handoffs/WF02-REQ-019/step-02b-reviewer.json, BLOCKER) — locks down the
// exact live-reproduced regression REVIEWER found: with zero active
// chapters seeded, `assignChapterOrPrompt` sends `start.noActiveChapters`
// and returns "continue", but `users.chapter_id` stays permanently NULL.
// Before this rework, both `makeStartHandler` and `makeConsentCallbackHandler`
// then called `advanceOnboarding` with `hasChapter` re-derived as `false`,
// got back the unhandled "chapter-needed" outcome, and silently stopped
// replying forever. This suite dispatches real Telegram-shaped updates
// through `bot.handleUpdate()` (no network — an `api.config.use` transformer
// captures every outgoing call and fabricates the response) against a real,
// migrated scratch Postgres (apps/bot/docker-compose.yml), asserting the
// flow keeps progressing (to the first profile prompt, since a brand-new
// user's profile is always empty) instead of dead-ending after
// `noActiveChapters`.
//
// INFRASTRUCTURE NOTE (flagged, not silently worked around): this is the
// first DB-backed automated test in this codebase — every prior *.test.ts
// file is pure-function only. `.github/workflows/ci-cd.yml`'s `Test` step
// runs `npm test` with no Postgres service, so this suite skips itself
// (via `ctx.skip()`, not a hard failure) whenever it cannot reach
// `TEST_DATABASE_URL` (defaults to this package's own
// `docker-compose.yml` dev DB, postgres://bot:bot@localhost:55432/bot) or
// that database has not yet had `drizzle-kit migrate` run against it.
// Recommended follow-up for ORCH: add a `postgres:16-alpine` service to the
// `build` job in `.github/workflows/ci-cd.yml` so this suite (and any future
// DB-backed test) actually runs in CI instead of only locally.

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://bot:bot@localhost:55432/bot";

let pool: Pool;
let db: NodePgDatabase<typeof schema>;
let dbAvailable = true;
let skipReason = "";

beforeAll(async () => {
  pool = new Pool({ connectionString: TEST_DATABASE_URL, connectionTimeoutMillis: 3000 });
  db = drizzle(pool, { schema });
  try {
    await pool.query("SELECT phone_skipped FROM profiles LIMIT 0");
  } catch (err) {
    dbAvailable = false;
    skipReason = `scratch Postgres at ${TEST_DATABASE_URL} unreachable or not migrated (run: cd apps/bot && docker compose up -d && DATABASE_URL=${TEST_DATABASE_URL} npx drizzle-kit migrate) -- ${(err as Error).message}`;
    console.warn(`[start.test.ts] skipping DB-backed suite: ${skipReason}`);
  }
}, 15000);

afterAll(async () => {
  await pool?.end();
});

beforeEach(async () => {
  if (!dbAvailable) {
    return;
  }
  // Isolate each test on a clean slate — no active chapters, no users, no
  // profiles. `chapters` is truncated too so a leftover row from another
  // test file's own fixture never accidentally satisfies "an active chapter
  // exists" for this suite's zero-active-chapters premise.
  await pool.query("TRUNCATE profiles, users, chapters CASCADE");
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

// Builds a real grammY Bot wired with exactly the REQ-014/REQ-019 /start
// handlers under test (index.ts's own registrations for this segment), with
// network replaced by a capturing transformer — no real Telegram API call is
// ever made, and no `getMe()` call happens either (`botInfo` pre-supplied).
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

  bot.command("start", makeStartHandler(db));
  bot.callbackQuery(/^chapter:(.+)$/, makeChapterCallbackHandler(db));
  bot.callbackQuery(/^consent:agree(?::.+)?$/, makeConsentCallbackHandler(db));

  return { bot, captured };
}

let nextUpdateId = 1;
let nextTgId = 900_000_000;

function startCommandUpdate(tgId: number) {
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: tgId, type: "private" as const },
      from: { id: tgId, is_bot: false, first_name: "Test" },
      text: "/start",
      entities: [{ offset: 0, length: 6, type: "bot_command" as const }],
    },
  };
}

function consentAgreeCallbackUpdate(tgId: number) {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: `cbq_${nextUpdateId}`,
      from: { id: tgId, is_bot: false, first_name: "Test" },
      chat_instance: "test-chat-instance",
      data: "consent:agree",
      message: {
        message_id: 2,
        date: Math.floor(Date.now() / 1000),
        chat: { id: tgId, type: "private" as const },
      },
    },
  };
}

function textOf(entry: Captured | undefined): string | undefined {
  return entry?.payload["text"] as string | undefined;
}

describe("makeStartHandler / makeConsentCallbackHandler -- zero active chapters (REQ-019 rework)", () => {
  it("consent-callback path: /start then consent:agree still reaches the first profile prompt, not a dead end after noActiveChapters", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const { bot, captured } = makeTestBot();
    const tgId = nextTgId++;

    await bot.handleUpdate(startCommandUpdate(tgId) as never);
    // Brand-new user, zero active chapters: /start stops at the consent gate
    // exactly like it always has (unaffected by this rework).
    expect(captured).toHaveLength(1);
    expect(captured[0]?.method).toBe("sendMessage");
    expect(textOf(captured[0])).toBe(getCatalog("ru").consent.prompt);

    captured.length = 0;
    await bot.handleUpdate(consentAgreeCallbackUpdate(tgId) as never);

    const methods = captured.map((c) => c.method);
    expect(methods).toEqual(["answerCallbackQuery", "sendMessage", "sendMessage"]);

    // First reply after the consent tap: the pre-existing REQ-014
    // noActiveChapters message (unchanged).
    expect(textOf(captured[1])).toBe(getCatalog("ru").start.noActiveChapters);

    // THE REGRESSION: before this rework, nothing further was ever sent.
    // A brand-new user's profile is empty, so the correct next step is the
    // first profile question (firstName) -- proof the flow did not dead-end.
    expect(textOf(captured[2])).toBe(getCatalog("ru").profile.promptFirstName);

    const finalUser = await getFlowUserByTgId(db, BigInt(tgId));
    expect(finalUser?.chapterId).toBeNull(); // still correctly never assigned
    expect(finalUser?.consentPdAt).not.toBeNull();
  });

  it("makeStartHandler's own chapter-needed branch: a returning, already-consented user with no chapter still reaches the first profile prompt", async (t) => {
    if (!dbAvailable) {
      t.skip();
      return;
    }

    const { bot, captured } = makeTestBot();
    const tgId = nextTgId++;

    // Seed a returning user who already consented (e.g. via an earlier
    // session) but has no chapter -- exactly the state
    // makeStartHandler's own `if (flowUser.chapterId === null)` branch
    // handles directly, independent of the consent callback.
    const created = await resolveOrCreateUser(db, { tgId: BigInt(tgId), tgUsername: null, lang: "ru" });
    await recordConsent(db, created.id, new Date());

    await bot.handleUpdate(startCommandUpdate(tgId) as never);

    const methods = captured.map((c) => c.method);
    expect(methods).toEqual(["sendMessage", "sendMessage"]);
    expect(textOf(captured[0])).toBe(getCatalog("ru").start.noActiveChapters);
    // THE REGRESSION, makeStartHandler's own call site: before this rework
    // this second reply was never sent.
    expect(textOf(captured[1])).toBe(getCatalog("ru").profile.promptFirstName);
  });
});
