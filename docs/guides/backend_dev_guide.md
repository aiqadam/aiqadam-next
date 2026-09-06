# Backend Developer Guide

Audience: BACKEND-DEV, REVIEWER, SECURITY-REVIEWER.

## 1. What you're working on

The AI Qadam Events Bot — a long-running Node/TypeScript process, not a serverless
function or an HTTP service. It talks to Telegram over long polling (grammY) and to a
single Postgres instance (Drizzle ORM). PRD §1: ~1,000 users, ~10 events/year, peak 0.06
rps, DB under 50MB. "One Postgres and one bot process are sufficient" — do not add
infrastructure this load doesn't need.

```
apps/bot/
  package.json        workspace member, exact-pinned runtime deps (see §3)
  tsconfig.json
  eslint.config.mjs    mirrors apps/web's flat-config pattern
  src/
    config.ts          pure loadConfig(env) — no I/O, no process.exit, throws naming
                        only missing variable NAMES, never values (S11)
    config.test.ts      the workspace's real Vitest coverage of config.ts
    index.ts            entry point: loadConfig -> catch -> log message only -> exit(1),
                        or start the grammY Bot and register handlers
```

Binding decisions, read before writing any code:

- `docs/agents/decisions/0004-telegram-framework-grammy.md` — grammY. **Domain logic
  (admission state machine, capacity, promotion, idempotency) lives in framework-free
  modules that handlers call, never inside a grammY handler body.** REVIEWER treats a
  domain rule embedded in a handler as a finding, full stop — this is the single most
  load-bearing convention in this codebase, because it's what keeps the Telegram
  framework choice reversible.
- `docs/agents/decisions/0005-orm-drizzle.md` — Drizzle ORM + Drizzle Kit. Migrations are
  committed as generated `.sql` files and reviewed as SQL, never waved through because a
  tool produced them. A migration dropping or rewriting a column holding personal data or
  attendance history needs SECURITY-REVIEWER sign-off under `security-invariants.md` S13.
- `docs/agents/decisions/0006-test-framework-vitest.md` — Vitest, at the repo root,
  covering both workspaces. Read its "fake timers do not reach Postgres" boundary in
  full: **any predicate whose truth depends on the current time takes the evaluation time
  as an explicit parameter from the application — never SQL `now()`/`current_timestamp`
  inside the query.** `WHERE ends_at < $1` with the app supplying `$1`, not
  `WHERE ends_at < now()`. This does not apply to audit/bookkeeping defaults
  (`created_at`, `updated_at`, `AuditLog.at`).
- `docs/agents/instructions/security-invariants.md` (S1-S14) — you are the role that must
  *satisfy* these; SECURITY-REVIEWER is the role that independently checks you did, on
  every bot requirement, unconditionally (WF-02 Step 2c is a hard gate for `apps/bot/**`
  even when a requirement's own scope looks security-irrelevant, like REQ-009's skeleton).

## 2. Running and checking it

| Command | Purpose |
|---|---|
| `npm run build -w apps/bot` (or root `npm run build`, covers both workspaces) | `tsc` — catches type errors |
| `npm run lint -w apps/bot` (or root `npm run lint`) | ESLint, flat config |
| `npm test` (root) | Vitest, covers both workspaces |
| `npm ci` (root, from a clean `node_modules`) | **The exact command CI runs.** `npm install` can succeed locally on a stale lockfile that `npm ci` then rejects in a clean environment — always verify with `npm ci`, not just `npm install`, before calling a dependency change done. See §5. |

There is no `npm run dev` / hot-reload script yet for the bot (deliberately deferred at
REQ-009 — see `docs/agents/design/REQ-009.md` §9.3, an explicit open question, not an
oversight). Add one only when a requirement's own iteration loop actually needs it.

## 3. Dependency pins

Every dependency named in a requirement's acceptance criteria is pinned to an EXACT
version — no `^`/`~`. Check the relevant decision record for what's already decided
(grammY, Drizzle, the Postgres driver, Vitest); don't add a plugin or a new dependency
class preemptively. Before pinning a new version, verify it actually exists in the
registry right now — don't copy a version number from memory.

**A pinned dependency can still break `npm ci` even when every individual pin is
correct**, if the lockfile's resolved tree contains a transitive version that doesn't
satisfy some other package's declared range (e.g. two packages needing different major
versions of a shared transitive dependency, one pinned via `overrides`, one not). This
happened for real at REQ-009: adding `vitest@5.0.0` pulled in a `vite`/`esbuild` chain
that conflicted with `drizzle-kit`'s own `esbuild` range, and the stale lockfile passed
`npm install` locally while failing `npm ci` in CI. The fix was a root `package.json`
`"overrides"` entry pinning the shared transitive dependency to one version. **`npm
install` succeeding is not evidence `npm ci` will — always verify the latter from a
genuinely clean `node_modules` before reporting a dependency change done.**

## 4. Docker/deploy awareness

`Dockerfile`'s builder stage `COPY`s each workspace's `package.json` **by name**, one
line per workspace, before `npm ci`. **Adding a new workspace member, or a workspace that
didn't exist yet when `Dockerfile` was last touched, means `Dockerfile` needs a matching
`COPY apps/<name>/package.json ./apps/<name>/package.json` line or `npm ci` fails there
too** — even if the workspace is never actually run inside that image. This has recurred
twice (`docs/issues/ISS-0005.yaml`: REQ-007's monorepo move, then REQ-009's apps/bot
addition) and is now a standing REVIEWER checklist item (`.claude/agents/reviewer.md`
item 7) — but check it yourself before handing off rather than relying on REVIEWER to
catch it.

## 5. Self-review checklist

Before handing off to REVIEWER, confirm:

- [ ] `npm run lint` passes
- [ ] `npm run build` succeeds
- [ ] `npm test` passes with real assertions against real behavior — never
      `expect(true).toBe(true)`
- [ ] A clean `npm ci` (not just `npm install`) succeeds, if `package.json`/
      `package-lock.json` changed at all
- [ ] No domain logic inside a grammY handler body — it calls a framework-free module
- [ ] No time-dependent predicate reads `now()`/`current_timestamp` in SQL — the
      evaluation time is an explicit parameter
- [ ] No secret value (bot token, database URL/password, any PII) appears in a log line,
      an error message, or a thrown exception's text — only variable/field *names*
- [ ] Every new/changed dependency is exact-pinned and actually needed by this
      requirement's stated scope, not added preemptively
- [ ] If a workspace was added/renamed, or build output moved: `docker build -t
      <scratch-tag> .` succeeds locally
- [ ] No unrelated changes bundled in (scope matches what was asked)

## 6. Testing shape

Per decision 0006, write real Vitest test code for anything that's a function of code
behavior (state transitions, capacity math, idempotency, date-window logic under fake
timers). A manual/scripted checklist (see `docs/guides/qa_testing_guide.md`) remains
correct for genuinely process-level or visual properties: does `npm ci` succeed, does a
Telegram message render/format correctly, does the CI job actually gate on a failure.
TEST-DESIGNER decides which shape fits each acceptance criterion — don't guess ahead of
that gate, but do write the test code yourself when the design doc's target is a pure
function you're already implementing (e.g. `config.ts`'s `loadConfig`).
