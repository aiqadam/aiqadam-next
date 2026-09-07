import type { Bot } from "grammy";
import { GrammyError } from "grammy";
import type { NotificationSender } from "../domain/notification.js";

// docs/agents/design/REQ-025.md §5 — the one file where NotificationSender's
// interface (declared framework-free in domain/notification.ts) is actually
// implemented. This file DOES import grammy, deliberately — it wraps
// `Bot["api"]`.

export interface RateLimiterConfig {
  maxMessagesPerSecond: number;
  maxRetries: number;
  initialBackoffMs: number;
  maxBackoffMs: number;
}

// §5's fixed defaults, kept here as the values `index.ts` passes through
// unless a future requirement needs to override them. Not exported as the
// only way to configure the sender (createRateLimitedSender takes config
// explicitly, per this design's own no-hidden-default discipline) — kept as
// a named constant so index.ts's wiring can cite the design section its
// numbers come from.
export const DEFAULT_RATE_LIMITER_CONFIG: RateLimiterConfig = {
  maxMessagesPerSecond: 25,
  maxRetries: 5,
  initialBackoffMs: 1000,
  maxBackoffMs: 30000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// §5 rule table, "Pacing (proactive)": a rolling one-second window tracker.
// A call arriving while the window's quota is exhausted waits until quota
// frees up rather than being dropped or erroring.
class RollingWindowPacer {
  private readonly sentAtMs: number[] = [];

  constructor(private readonly maxPerSecond: number) {}

  async waitForSlot(): Promise<void> {
    for (;;) {
      const now = Date.now();
      while (this.sentAtMs.length > 0 && now - this.sentAtMs[0]! >= 1000) {
        this.sentAtMs.shift();
      }
      if (this.sentAtMs.length < this.maxPerSecond) {
        this.sentAtMs.push(now);
        return;
      }
      const oldest = this.sentAtMs[0]!;
      const waitMs = 1000 - (now - oldest);
      await sleep(Math.max(waitMs, 0));
    }
  }
}

// §5's exact 429/backoff rule table: on a GrammyError with error_code 429,
// wait retry_after seconds (or initialBackoffMs if absent), retry the SAME
// logical send; each successive 429 doubles the previous wait, capped at
// maxBackoffMs, up to maxRetries total attempts. Any non-429 error is not
// retried — it propagates immediately. Exhaustion after maxRetries attempts
// rejects (never an uncaught throw past this function — the caller,
// sendLedgeredNotification's step 5, converts a rejection to
// `{ kind: "failed", error }`).
async function sendWithRetry(
  bot: Bot,
  config: RateLimiterConfig,
  pacer: RollingWindowPacer,
  chatId: string,
  text: string,
): Promise<void> {
  let backoffMs = config.initialBackoffMs;
  for (let attempt = 1; attempt <= config.maxRetries; attempt++) {
    await pacer.waitForSlot();
    try {
      await bot.api.sendMessage(chatId, text);
      return;
    } catch (err) {
      const is429 = err instanceof GrammyError && err.error_code === 429;
      if (!is429) {
        // Non-429 errors (e.g. Forbidden — the recipient blocked the bot)
        // are not retried; propagate the single attempt's failure.
        throw err;
      }
      if (attempt >= config.maxRetries) {
        throw err;
      }
      const retryAfterSeconds = err.parameters.retry_after;
      const waitMs =
        typeof retryAfterSeconds === "number" ? retryAfterSeconds * 1000 : backoffMs;
      await sleep(waitMs);
      backoffMs = Math.min(backoffMs * 2, config.maxBackoffMs);
    }
  }
  // Unreachable: the loop above always either returns or throws before
  // falling off the end (the final iteration's `attempt >= maxRetries`
  // branch throws). Kept as a defensive guard per this codebase's
  // no-speculation discipline rather than a non-null assertion.
  throw new Error("sendWithRetry: retry loop exhausted without resolving");
}

export function createRateLimitedSender(
  bot: Bot,
  config: RateLimiterConfig,
): NotificationSender {
  const pacer = new RollingWindowPacer(config.maxMessagesPerSecond);
  return {
    async send(tgId: bigint, text: string): Promise<void> {
      await sendWithRetry(bot, config, pacer, tgId.toString(), text);
    },
  };
}
