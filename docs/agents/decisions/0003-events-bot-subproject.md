# 0003 — The AI Qadam Events Bot becomes a subproject of this repo

**Date:** 2026-09-06
**Status:** Decided
**Context:** The AI Qadam Events Bot specification (`AI-Qadam-Events-Bot-Spec/`, v3,
2026-08-04, owner Viktor Drukker — PRD, USER-STORIES, STORY-DETAILS, RE-EVALUATION,
DESIGN-REVIEW, JOURNEY-AUDIT) was handed to this project to be adapted into registered
requirements.

## The problem

The spec describes a **Telegram bot**: a Postgres-backed system with 13 entities, three
roles plus per-event door staff, five admission states, three scheduled jobs, QR
check-in, segmented broadcast, and personal-data handling under an explicit consent
model (PRD §10).

This repository is a **static Next.js marketing site**. Before this record it had:

- no backend, no database, no migrations;
- no authentication, no authorization, no user-supplied data;
- no test framework (`package.json` has no test runner);
- `src/` = 13 landing components + i18n routing, four locales, no server logic beyond
  `src/app/health/route.ts`.

`AGENT_SYSTEM.md` §4 says explicitly that there is no backend, mobile, or DevOps role
"because none of that exists in the project", and names **"the first backend/user-data
feature"** as the trigger to add a `SECURITY-REVIEWER`. That trigger has now fired.

Three options were considered:

1. **Separate repository.** The bot is its own repo with its own agent pipeline.
2. **Subproject of this repo.** The bot lives beside the site in a monorepo, sharing one
   agent pipeline, one requirements registry, and one set of decision records.
3. **Landing-site slice only.** Register only the parts of the spec that a static site
   can satisfy (a public event card, deep links into a bot built elsewhere), and leave
   the bot unregistered.

## Decision

**Option 2 — the bot is a subproject of this repo**, in a monorepo laid out as:

```
apps/web/     the existing Next.js site (moved from the repo root)
apps/bot/     the Events Bot (new)
packages/     code genuinely shared by both, created only when a second consumer exists
```

Two sub-decisions, both settled here rather than left to the first implementing agent,
because PRD §11 deliberately leaves them to "the architect's call" and PRD's closing rule
forbids an implementing agent from inventing them:

### Stack: TypeScript/Node

`apps/bot` is TypeScript on Node, using a maintained Telegram framework (grammY or
Telegraf — the specific choice is an implementation requirement of its own, not settled
here) against Postgres.

Rationale against PRD §11's stated constraints:

- **Zero licence cost, open-source, self-hosted** — satisfied; so would Python have been.
- **Runs on one small server** (~1 000 users, ~10 events/year, peak 0.06 rps) — satisfied
  by either; at this load the language is not the deciding factor.
- **The deciding factor is the repo, not the runtime.** One language across site and bot
  means one `tsconfig`/`eslint` toolchain, one `node_modules` discipline, one set of
  skills in FRONTEND-DEV's existing competence, and — most concretely — the possibility
  of sharing the i18n message catalogs (`messages/*.json`, four locales already written
  and validated across REQ-001a…REQ-006) between the site and the bot's RU/EN
  requirement (PRD §11, FR "two languages at launch"). A Python bot would duplicate that
  catalog or invent a sync mechanism.
- The spec's own Python idiom (PRD §14 FR-14 cites `secrets` for `qr_token`) is a
  suggestion of *entropy strength*, not of language; Node's `crypto.randomBytes` meets
  the same "≥128 bits" bar.

**This is not a claim that Python's Telegram ecosystem is weaker.** `aiogram` is
excellent and would be a defensible choice in a standalone repo. It loses here only on
the monorepo-cohesion criterion, which is decisive precisely *because* option 2 was
chosen over option 1.

### Layout: the site moves to `apps/web`

The existing site relocates from the repo root into `apps/web/`, rather than staying at
the root with the bot added alongside as `bot/`.

Rationale:

- A root-level app plus a subdirectory app is asymmetric: it silently privileges the
  site, and every future "which app does this config belong to?" question resolves
  ambiguously. Two peers under `apps/` resolve it structurally.
- The migration cost is real but **bounded and one-time**: it is a path move
  (`src/`, `messages/`, `public/`, `next.config.ts`, `tsconfig.json`,
  `eslint.config.mjs`, `Dockerfile`, `deploy/`), and it invalidates cited paths in six
  `done` requirements' descriptions. Paying it now, while the repo holds one app and
  ~20 source files, is far cheaper than paying it after the bot exists.

**Consequence for the `done` requirements REQ-001a…REQ-006:** their descriptions and
acceptance criteria cite root-relative paths (`src/i18n/routing.ts`,
`messages/kk.json`, …). Those entries are historical records of completed work and are
**not rewritten** — `requirements.yaml`'s own header forbids rewriting an existing
entry. The migration requirement itself carries the mapping note, and any future reader
resolving an old path reads it as `apps/web/<old path>`.

## Why not the alternatives

**Option 1 (separate repo)** was rejected because the two surfaces are one product: the
site advertises the events the bot registers people for, they share brand voice, design
system, locales, and the same small operator team. Two repos means two agent pipelines,
two requirement registries, and a cross-repo dependency every time the site links to a
bot deep link (PRD FR-1's `?start=e_<event_id>`).

**Option 3 (landing slice only)** was rejected because it answers a question nobody
asked: the spec is a bot spec, and registering only the parts a static site can satisfy
would leave the actual product unregistered while implying it had been adapted.

## Consequences for the agent system

Per `AGENT_SYSTEM.md` §3 and `ORCHESTRATOR.md` §7, this record's adoption requires the
roster to be extended **before** the bot's requirements are drafted:

| New role | Covers | Validated by |
|---|---|---|
| `BACKEND-DEV` | `apps/bot/**` — bot handlers, domain logic, jobs, migrations | `REVIEWER` (code quality/scope) + `SECURITY-REVIEWER` (invariants) |
| `SECURITY-REVIEWER` | PRD §10 privacy, §12 invariants, role-gating, consent, PII in logs/exports | hard gate; reviews, does not write |
| `DATA-DESIGNER` | the persistent data model — entities, keys, migrations, computed-not-stored rules | `CODE-DESIGN-VALIDATOR` (existing role, scope extended) |

`docs/agents/instructions/security-invariants.md` is added as the checklist
`SECURITY-REVIEWER` gates against, derived from PRD §10 and §12.

**Deliberately still absent:** a DevOps role (deployment stays FRONTEND-DEV's per
`AGENT_SYSTEM.md` §6 until the bot's own deployment proves that insufficient) and an
automated-test-framework decision (the bot is the first code in this repo that genuinely
cannot be verified by a manual checklist — a test framework decision record is a
prerequisite of the bot's first logic requirement, and is recorded separately when that
requirement is drafted, not pre-empted here).

## What this record does not decide

- The specific Telegram framework (grammY vs Telegraf) — an implementation requirement.
- The ORM/migration tool — likewise.
- Anything in PRD §4's "Later" or "Non-goals" lists. Payments, gamification, a web
  front-end for the bot, hackathon teams/judging, and a Mini App scanner remain out of
  scope, and a requirement proposing one contradicts this record.
