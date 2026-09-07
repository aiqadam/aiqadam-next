import { createLogger } from "../log.js";

// docs/agents/design/REQ-025.md §7 — the first scheduled-job runner in this
// codebase. Framework-free (decisions/0004) — no grammy import, plain
// in-process setInterval timers per PRD 1's "do not add infrastructure"
// constraint (no Redis, no external queue).
//
// Logging: this module constructs its own logger via log.ts's createLogger,
// matching §7's "caught and logged (via this codebase's existing log.ts
// logger)" — the design's own signature takes no logger parameter. The
// logLevel argument only gates debug/info/warn (log.ts's LEVEL_ORDER); a
// .error() call always writes regardless of which level is passed here,
// since "error" is LEVEL_ORDER's own maximum, so no config plumbing is
// needed for this module's one log call.
const log = createLogger("debug");

export interface ScheduledJobDefinition {
  name: string;
  intervalMs: number;
  run: (evaluationTime: Date) => Promise<void>;
}

export interface SchedulerHandle {
  stop(): void;
}

// §7 rule table:
// - Each job gets its own interval timer, firing every intervalMs.
// - Each job's run is also invoked once immediately (catch-up on restart).
// - Overlap guard: a running-flag per job skips (not queues) a tick that
//   fires while the previous run hasn't resolved.
// - Failure isolation: a rejected run is caught and logged, never escapes to
//   crash the process or stop other jobs' timers.
// - stop() clears every job's timer.
export function startScheduledJobs(
  jobs: readonly ScheduledJobDefinition[],
): SchedulerHandle {
  const timers: ReturnType<typeof setInterval>[] = [];

  for (const job of jobs) {
    let running = false;

    const tick = (): void => {
      if (running) {
        // Overlap guard: skip this tick entirely, do not queue it.
        return;
      }
      running = true;
      job
        .run(new Date())
        .catch((err: unknown) => {
          log.error("scheduled job failed", { job: job.name, error: err });
        })
        .finally(() => {
          running = false;
        });
    };

    // Immediate first run, then every intervalMs thereafter.
    tick();
    timers.push(setInterval(tick, job.intervalMs));
  }

  return {
    stop(): void {
      for (const timer of timers) {
        clearInterval(timer);
      }
    },
  };
}
