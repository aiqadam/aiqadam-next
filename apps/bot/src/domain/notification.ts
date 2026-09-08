import type { DbClient } from "../db/client.js";
import { notificationLedger } from "../db/schema.js";
import { getUserForNotificationById } from "./user.js";
import { resolveLang } from "../i18n/resolveLang.js";
import type { BotLang } from "../i18n/catalog.js";

// docs/agents/design/REQ-025.md §2/§3 — the shared, framework-free
// (decisions/0004) send-once notification API. No `grammy` import in this
// file: the concrete Telegram call is injected via `NotificationSender`,
// whose implementation (scheduler/rateLimiter.ts) does import grammy.

// Release 1's closed set (§2). Release-3 will extend this union with two
// marketing kinds (S10) — a one-line TypeScript change, not a migration,
// since `notification_ledger.kind` is `text` (REQ-025-schema.md §2).
export type NotificationKind =
  | "admission_result"
  | "waitlist_promotion"
  | "reminder_24h"
  | "reminder_3h"
  | "feedback_request"
  | "feedback_reminder"
  | "event_cancelled"
  // docs/agents/design/REQ-032.md §3.1 — the single no-show reason-request
  // send. One-line addition, not a migration: notification_ledger.kind is
  // already `text`.
  | "no_show_reason_request"
  // docs/agents/design/REQ-036.md §1 — sent to ONE organizer of the event's
  // chapter (§2.2), never to the registrant.
  | "pending_request_urgent"
  // docs/agents/design/REQ-036.md §1 — sent to the registrant whose request
  // was auto-declined.
  | "registration_auto_declined"
  // docs/agents/design/REQ-039.md §6 — sent to the HOST (grants_companion_of)
  // once their companion's registration is created. One-line addition, not a
  // migration: notification_ledger.kind is already `text`.
  | "companion_registered";

// AC5: exactly two members, and every call site must choose one explicitly —
// enforced structurally by `SendNotificationInput.classification` below
// having no `?` and no default value anywhere.
export type SendClassification = "transactional" | "marketing";

// docs/agents/design/REQ-026.md §1.1 — a single button, a single-row
// inline keyboard built from an ordered array of these (rateLimiter.ts §1.3).
export interface NotificationButton {
  label: string;
  callbackData: string;
}

// docs/agents/design/REQ-026.md §1.1 — composeMessage's new return shape.
// "text" carries REQ-025's original plain-text send, now with optional
// buttons; "photo" is REQ-026's new QR-with-caption send; "skip" is the
// at-send-time recheck's "don't send, but the ledger row stays consumed"
// outcome (§1.2 step 5).
export type ComposedMessage =
  | { kind: "text"; text: string; buttons?: NotificationButton[] }
  | { kind: "photo"; photo: Buffer; caption: string }
  | { kind: "skip" };

export interface NotificationSender {
  send(tgId: bigint, text: string, buttons?: NotificationButton[]): Promise<void>;
  sendPhoto(tgId: bigint, photo: Buffer, caption: string): Promise<void>;
}

export interface SendNotificationInput {
  db: DbClient["db"];
  sender: NotificationSender;
  registrationId: string;
  kind: NotificationKind;
  classification: SendClassification;
  userId: string;
  composeMessage: (resolvedLang: BotLang) => Promise<ComposedMessage> | ComposedMessage;
}

export type SendOutcome =
  | { kind: "sent" }
  | { kind: "skipped-already-sent" }
  | { kind: "skipped-blocked" }
  | { kind: "skipped-no-broadcast-opt-in" }
  | { kind: "skipped-no-telegram-id" }
  | { kind: "skipped-stale" }
  | { kind: "failed"; error: unknown };

// Postgres unique-violation error code (23505) — the exact mechanism §3.1
// step 4 relies on to detect "already sent" with no in-memory state of any
// kind (AC2). `pg`/`node-postgres` surfaces this as an object carrying a
// `code` string property, never a typed exception class.
const POSTGRES_UNIQUE_VIOLATION = "23505";

function pgErrorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null) {
    return undefined;
  }
  const direct = (err as { code?: unknown }).code;
  if (typeof direct === "string") {
    return direct;
  }
  // drizzle-orm/node-postgres wraps the underlying `pg` driver error inside
  // a DrizzleQueryError, with the original pg error (carrying `.code`) on
  // `.cause` -- unwrap one level rather than assuming the top-level object
  // is itself the pg error.
  const cause = (err as { cause?: unknown }).cause;
  if (typeof cause === "object" && cause !== null && typeof (cause as { code?: unknown }).code === "string") {
    return (cause as { code: string }).code;
  }
  return undefined;
}

function isUniqueViolation(err: unknown): boolean {
  return pgErrorCode(err) === POSTGRES_UNIQUE_VIOLATION;
}

// docs/agents/design/REQ-025.md §3.1 — the ordered rule table, implemented
// literally step by step. Never throws: every branch returns a SendOutcome.
export async function sendLedgeredNotification(
  input: SendNotificationInput,
): Promise<SendOutcome> {
  // Step 1 — resolve the user; no ledger row written if this fails.
  const user = await getUserForNotificationById(input.db, input.userId);
  if (user === null || user.tgId === null) {
    return { kind: "skipped-no-telegram-id" };
  }

  // Step 2 — blocked check, unconditional, before the classification branch
  // (S10: "blocked users are skipped in both cases", AC4).
  if (user.blocked) {
    return { kind: "skipped-blocked" };
  }

  // Step 3 — marketing-only broadcast_opt_in check. A transactional send
  // never reads broadcastOptIn at all (AC3).
  if (input.classification === "marketing" && !user.broadcastOptIn) {
    return { kind: "skipped-no-broadcast-opt-in" };
  }

  // Step 4 — the single atomic INSERT that is the entire idempotency
  // mechanism (AC1, AC2). A duplicate-key violation is the expected,
  // non-error "already sent" outcome; any other insert error is `failed`.
  try {
    await input.db.insert(notificationLedger).values({
      registrationId: input.registrationId,
      kind: input.kind,
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      return { kind: "skipped-already-sent" };
    }
    return { kind: "failed", error: err };
  }

  // Step 5 — only reached once step 4's insert has committed. The
  // already-committed ledger row is never rolled back or deleted here, even
  // if the send below fails (§3.2 — an accepted, named under-sending risk).
  // docs/agents/design/REQ-026.md §1.2's extended rule table: "skip" ->
  // skipped-stale with no sender call; "text"/"photo" -> the matching
  // sender method.
  try {
    const resolvedLang = resolveLang(user.lang, user.chapterDefaultLang);
    const composed = await input.composeMessage(resolvedLang);
    if (composed.kind === "skip") {
      return { kind: "skipped-stale" };
    }
    if (composed.kind === "text") {
      await input.sender.send(user.tgId, composed.text, composed.buttons);
    } else {
      await input.sender.sendPhoto(user.tgId, composed.photo, composed.caption);
    }
    return { kind: "sent" };
  } catch (err) {
    return { kind: "failed", error: err };
  }
}
