# 0006 — Vitest is the project's test runner

**Date:** 2026-09-06
**Status:** Decided
**Context:** `AGENT_SYSTEM.md` §7 has carried "no automated test framework" as a known gap
since the pipeline was adopted, with the trigger stated as the arrival of work that a
manual checklist cannot verify. The Events Bot is that work. REQ-009 requires this record
before the bot's first logic requirement (REQ-020, registration/admission).

**Decided by:** ORCH, on the project owner's explicit delegation of all open technical
decisions (2026-09-06).

**Scope:** the whole repo — `apps/bot` immediately, `apps/web` when it wants tests. One
runner, not one per workspace.

## Why this can no longer be deferred

Until now `TEST-DESIGNER` wrote manual checklists and `TEST-RUNNER` executed them by hand
(`npm run lint`, `npm run build`, click through the page). For a static site with four
locales that was adequate — the properties were visible on screen.

The bot's properties are not visible on screen, and several cannot be checked by hand at
all:

| Property | Source | Why a manual check fails |
|---|---|---|
| Admission state machine — every legal and illegal transition | PRD §6 | Illegal transitions are the point; you cannot click your way to "this transition was refused" for every pair |
| Capacity atomicity under concurrency | PRD §12.2, S7 | Two simultaneous registrations for the last seat cannot be produced by hand |
| Notification idempotency across restart | PRD §12.8, S9 | Requires killing and restarting a process mid-batch, repeatably |
| Auto-promotion halting at T-24h | PRD §6 | Requires controlling the clock |
| `no_show` / waitlist position computed correctly | PRD §5 | Requires fixture data at many timestamps |

`core-directives.md` requires re-deriving a verdict *under the conditions the property is
actually about*. For these, constructing those conditions **is** writing a test. Without a
runner, the gates degrade into assertions of good intent — which the same file identifies
as the exact failure a humanless pipeline cannot survive.

## Options considered

### Option A — Vitest

- The default recommendation for new TypeScript projects as of 2026.
- First-class TypeScript and ESM handling with no separate transform configuration —
  relevant because `apps/web` is a modern Next.js app and `apps/bot` is ESM TypeScript.
- Fake timers, mocking, watch mode, snapshots, coverage in one tool.
- Adds a dependency and a config file.

### Option B — `node:test` (built-in)

- Zero dependencies; ships with Node (v24 locally, v22 in CI).
- Ideal for libraries and CLI tools where forcing test dependencies on consumers is rude.
- Weaker ergonomics for TypeScript. **Corrected 2026-09-06:** this record as first
  written said clock control was "hand-rolled clock injection everywhere". That is
  inaccurate — `node:test` has shipped `mock.timers.enable({apis:['Date'], now})` with
  `setTime()`/`tick()` since Node 20, so the real gap is ergonomic, not a missing
  capability.

### Option C — Jest

- Long-established and widely known.
- ESM support remains the awkward part of its story, and it is the heaviest of the three.
- Considered and rejected without further analysis: it is chosen mainly for familiarity
  and existing suites, and this repo has neither.

## Decision

**Option A — Vitest**, at the repo root, covering both workspaces.

## Rationale

1. **Time control is the deciding capability — but read the boundary below before
   relying on it.** Auto-promotion stopping at T-24h, reminders at T-24h and T-3h,
   feedback at T+2h with one repeat at T+24h, `no_show` after `ends_at` — a large share of
   this bot's logic is a function of the clock. Vitest's `vi.useFakeTimers()`,
   `vi.setSystemTime()` and `vi.advanceTimersByTime()` fake `Date` and the
   `setTimeout`/`setInterval` families, which makes that logic testable directly.
   `node:test` can do this too (see the correction above); Vitest's version is
   substantially less ceremony, which under weak-model tolerance is worth real money.
2. **`node:test`'s advantage doesn't apply.** Its strength is avoiding dependencies for
   *consumers of a published package*. Nothing here is published; it is a self-hosted
   application. The benefit is unrealized while the ergonomic cost is paid in full.
3. **One runner for both workspaces.** Vitest handles the bot's ESM TypeScript and the
   site's React/Next code, so `apps/web` gains a test path when it wants one without a
   second decision. Two runners in one monorepo is a cost with no matching benefit here.
4. **It suits an agent-run pipeline.** Machine-readable reporters and a `--run` mode that
   exits non-zero on failure give `TEST-RUNNER` real output to quote and
   `RELEASE-VALIDATOR` something to independently re-execute, rather than a checklist
   whose completion is self-reported.

## ⛔ The boundary: fake timers do not reach Postgres

**Raised by REQ-VALIDATOR at the step-03 gate, and load-bearing enough to be a rule rather
than a footnote.** `vi.setSystemTime()` moves JavaScript's clock. It has no effect on the
database's clock. A comparison written as SQL `now()` runs on Postgres time and is
untouched by any fake timer.

This interacts directly with `decisions/0005-orm-drizzle.md`, whose rationales 2 and 3
actively push computation toward SQL — and PRD §5's computed-never-stored values
(`no_show`, `registration_open`, waitlist position) are exactly the time-dependent ones.
The two decisions pull in opposite directions here, and neither said so when written.

**The rule, binding on DATA-DESIGNER and BACKEND-DEV from REQ-010 onward:** any predicate
whose truth depends on the current time takes **the evaluation time as an explicit
parameter** — passed in from the application, never read as SQL `now()` inside the query.
Queries stay in SQL, as 0005 intends; the *clock* is injected, so a test can control it.

Concretely: `WHERE ends_at < $1` with the application supplying `$1`, not
`WHERE ends_at < now()`. Same SQL shape, same Drizzle idiom, and the property becomes
testable. A query reading `now()`, `current_timestamp` or equivalent in a
time-dependent predicate is a REVIEWER finding, because it is untestable by construction —
and per `core-directives.md`, a property that cannot be checked under the conditions it is
about has not been verified.

This does not apply to audit/bookkeeping columns (`created_at`, `updated_at`, an
`AuditLog` row's `at`) where a database default is correct and no test asserts on it.

## Consequence for the agent system

This changes what two roles do, and their guides must follow:

- **`TEST-DESIGNER`** writes **runnable test code** for bot logic, not manual checklists.
  Its role file already anticipates this ("automated test code once a framework exists").
  A manual checklist remains correct for genuinely visual properties — the site's
  rendering, a Telegram message's appearance.
- **`TEST-RUNNER`** runs `npm test` and quotes real output. `core-directives.md`'s No
  Speculation and No Background Wait rules apply unchanged: the run is synchronous and the
  actual result is read.
- **`AGENT_SYSTEM.md` §7's "no automated test framework" entry is now closed**, and is
  marked as such rather than deleted, matching how the SECURITY-REVIEWER trigger was
  handled in the same section.
- **CI runs the tests.** `.github/workflows/ci-cd.yml` currently runs lint and build only;
  a `npm test` step is added so a failing test blocks a merge. A test suite that CI does
  not run is decoration — and per `core-directives.md`, a gate that cannot fail is not a
  gate.

**What this decision does not do:** it sets no coverage target and mandates no
test-first discipline. Which properties get tests is decided per requirement by
`TEST-DESIGNER` against that requirement's acceptance criteria, gated by
`TEST-DESIGN-VALIDATOR`. A coverage threshold picked in the abstract, before any test
exists, would be a number invented rather than reasoned — precisely what this project's
own directives forbid.

## Consequence for REQ-009

REQ-009's third acceptance criterion (`npm test` runs and reports at least one passing
assertion) is satisfied with Vitest configured at the repo root, plus one real assertion —
not a placeholder that asserts `true`. The first genuine test target is REQ-010's schema
work; the skeleton's own testable surface is its environment-variable validation, which
REQ-009 already requires to exit non-zero on a missing token.

## Correction history

**2026-09-06** — two amendments after REQ-VALIDATOR's independent check
(`handoffs/WF01-EVENTS-BOT-SPEC/step-03-req-validator-recheck.json`): the `node:test`
option was mischaracterized as lacking clock control and is corrected above, and the
fake-timers/Postgres boundary was missing entirely and is now a binding rule. The decision
itself is unchanged — Vitest still wins on ergonomics and on covering both workspaces.

## Sources consulted

- https://www.pkgpulse.com/guides/node-test-vs-vitest-vs-jest-native-test-runner-2026
- https://www.rijanneupane.com.np/2026/08/nodetest-vs-vitest-vs-jest-in-2026.html
- https://www.hirenodejs.com/blog/nodejs-testing-jest-vitest-2026
- https://vitest.dev/api/vi.html (fake-timer API, consulted at the 2026-09-06 correction)
