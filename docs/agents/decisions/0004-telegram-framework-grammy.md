# 0004 — grammY is the Events Bot's Telegram framework

**Date:** 2026-09-06
**Status:** Decided
**Context:** `decisions/0003-events-bot-subproject.md` fixed the bot as TypeScript/Node but
explicitly left the Telegram framework open ("What this record does not decide"). REQ-009
requires this record to exist, with at least two options named, before the bot skeleton is
written. Deciding it here rather than inside REQ-009's implementation turn means the
choice is made deliberately and reviewably, not by whichever agent writes the first
`import`.

**Decided by:** ORCH, on the project owner's explicit delegation of all open technical
decisions (2026-09-06). The owner is not a software developer and asked that these be
settled professionally rather than referred back.

## Options considered

Both are mature, actively maintained, open-source TypeScript libraries for the Telegram
Bot API, and both satisfy PRD §11's zero-licence-cost / self-hosted constraint. Neither
choice would be negligent.

### Option A — grammY

- TypeScript-first: written in TypeScript from the start, with types that are usable
  rather than merely present.
- First-party plugin ecosystem maintained under the same `grammyjs` organization —
  notably **sessions**, **conversations**, **rate limiting**, and **runner** (concurrency
  for long polling).
- Steady release cadence and active maintenance as of this decision.
- Larger dependency surface than Telegraf.

### Option B — Telegraf

- The long-established Node option, widely deployed, with a large body of existing
  examples and StackOverflow answers.
- Fewer dependencies, which is an advantage in serverless deployments.
- Its TypeScript story is weaker by history: v4 migrated the codebase to TypeScript, but
  the resulting types are widely reported as complex and hard to work with. This is a
  documented, specific criticism, not a general impression.

## Decision

**Option A — grammY.**

## Rationale

Against PRD §11's stated constraints and this project's actual shape:

1. **The conversations plugin covers the dialogue half of FR-3's multi-step form.** PRD
   FR-3 requires a multi-step profile form, and PRD §11 makes **restart-safe** an explicit
   product constraint. grammY's conversations plugin manages that dialogue state — which
   step the person is on, and the updates received so far — through a pluggable storage
   adapter. With Telegraf this is hand-rolled scene management.

   **Corrected 2026-09-06, after REQ-VALIDATOR's gate (step-03) found this rationale
   overstated as first written.** Two limits an implementer must know, because the earlier
   wording ("exactly what the plugin exists for", "the single strongest reason") implied
   more than the plugin delivers:

   - **The default storage backend is an in-memory `Map`.** Restart-survival requires
     explicitly configuring a persistent adapter. It is not free, and REQ-014 (the profile
     form) must configure one.
   - **The plugin does not satisfy FR-3's actual partial-write sentence.** FR-3 says
     *"partial answers are written to the Profile row as they arrive — a restart mid-form
     loses nothing."* Writing each answer to the Profile row is **application code**, in
     `conversation.external()` or equivalent, and it is the same work under either
     framework. The plugin gives restart-safe *dialogue position*, not restart-safe
     *domain data*.

   What survives is narrower but still real: grammY supplies the dialogue-state machinery
   Telegraf makes you build. This is no longer claimed as the single deciding reason —
   reasons 2 through 4 carry at least as much weight.
2. **Typed correctness matters more than usual here** because of this project's humanless
   pipeline. `core-directives.md` states weak-model tolerance as a design constraint: the
   pipeline must produce correct work even when the executing agent has limited judgment.
   A framework whose types are reported as hard to reason about pushes error detection
   from compile time to runtime — that is, to real attendees at a real door. A
   TypeScript-first library is worth more to an agent-written codebase than to a
   human-written one.
3. **The rate-limiting and runner plugins serve FR-15.** Broadcast must respect Telegram's
   limits (≤ 25 msg/s, exponential backoff on 429) and report delivered/failed.
   First-party plugins for this are less code for BACKEND-DEV to write and less surface
   for SECURITY-REVIEWER's S10 gate to audit.
4. **Telegraf's main advantage does not apply here.** Its smaller dependency tree is worth
   most in serverless/edge deployments. Decision 0003 fixed this bot as a single
   long-running process on one small server (PRD §1: ~1 000 users, 0.06 rps). Cold-start
   and bundle size are not constraints this deployment has.

## What this costs

grammY has a somewhat larger dependency surface, and a smaller corpus of pre-existing
third-party tutorials than Telegraf. Neither is load-bearing here: dependency count is not
a constraint PRD §11 states, and its own documentation is strong.

## Consequence

- REQ-009 adds `grammy` to `apps/bot/package.json` and pins an exact version.
- Plugins are added **when a requirement needs them**, not preemptively at skeleton time.
  REQ-009's scope is explicitly "NO domain logic, NO handlers beyond a health/liveness
  path" and that boundary still holds.
- Reversing this later is a real but bounded cost: handler signatures and middleware
  wiring would change; the domain logic underneath, which is where this project's actual
  value sits, is framework-agnostic by design and would not. **BACKEND-DEV must keep it
  that way** — domain logic (admission state machine, capacity, promotion, idempotency)
  goes in framework-free modules that handlers call, never inside handler bodies. That
  separation is a reviewable property, and REVIEWER should treat a domain rule embedded
  in a grammY handler as a finding.

## Correction history

**2026-09-06** — rationale 1 was overstated in the record as originally written; corrected
above following REQ-VALIDATOR's independent check
(`handoffs/WF01-EVENTS-BOT-SPEC/step-03-req-validator-recheck.json`, MINOR finding). The
decision itself did not change: the remaining rationale, particularly reasons 2-4, still
selects grammY. This history is kept rather than the text being silently amended, because
a record whose reasoning changed without trace is not auditable.

## Sources consulted

- grammY's own framework comparison — https://grammy.dev/resources/comparison
- grammY repository — https://github.com/grammyjs/grammy
- Telegraf's library comparison discussion — https://github.com/telegraf/telegraf/discussions/386
- grammY conversations plugin documentation — https://grammy.dev/plugins/conversations
  (consulted at the 2026-09-06 correction; source of the storage-adapter and
  in-memory-default facts above)

grammY's comparison page is written by grammY's own authors and was read as an
interested source; the specific claim relied upon (Telegraf v4's TypeScript migration
produced hard-to-use types) is corroborated by independent migration write-ups and is
consistent across sources.
