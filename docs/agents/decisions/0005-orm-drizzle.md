# 0005 — Drizzle ORM + Drizzle Kit for the Events Bot's persistence

**Date:** 2026-09-06
**Status:** Decided
**Context:** `decisions/0003-events-bot-subproject.md` fixed Postgres as the store but left
the ORM and migration tool open. REQ-009 requires this record before the bot skeleton is
written. `DATA-DESIGNER` (added in the same run) designs the schema; this record fixes the
tool that schema is expressed and migrated in.

**Decided by:** ORCH, on the project owner's explicit delegation of all open technical
decisions (2026-09-06).

## Constraints this must satisfy

Not preferences — these are stated product constraints, and they do most of the deciding:

| Constraint | Source |
|---|---|
| UUID primary keys; **no Telegram-only identifier as a business key** | PRD §1, §5 |
| Versioned, reviewable migrations | PRD §11 "restart-safe", §14 build order step 1 |
| **Exportable and absorbable** — the AI Qadam platform takes this over later | PRD §1, §11 |
| Zero licence cost, open-source, self-hosted | PRD §11 |
| Enforce invariants *in the database*, not only in application code | PRD §12, security-invariants S6/S7/S8 |
| One small server, ~1 000 users, 0.06 rps | PRD §1 |

## Options considered

### Option A — Drizzle ORM + Drizzle Kit

- Schema declared in TypeScript; queries read like SQL with full type inference.
- `drizzle-kit` generates plain **`.sql` migration files** from schema changes.
- Very small runtime footprint (~7.4 kB); no code generation step, no separate engine.
- Less abstraction: closer to SQL, so more SQL knowledge is assumed of whoever writes
  queries.

### Option B — Prisma

- Schema in its own `.prisma` DSL; a generated, fully typed client with a fluent API.
- `prisma migrate` maintains migration history with shadow-database safety checks — the
  more guarded migration workflow of the two.
- Prisma 7 (Nov 2025) replaced the Rust query engine with TypeScript/WASM, cutting bundle
  size from ~14 MB to ~1.6 MB and removing the long-standing native-binary complaint.
- More abstraction: productive, but the DSL and generated client sit between the developer
  and the database.

Both are open-source, self-hostable, and free. Both handle this load trivially — at 0.06
rps, performance benchmarks between them are irrelevant to this decision and were not
weighed.

## Decision

**Option A — Drizzle ORM with Drizzle Kit for migrations.**

## Rationale

1. **Exportability is a stated product constraint, and plain SQL migrations serve it
   best.** PRD §1 and §11 both say the AI Qadam platform will absorb this system later.
   Drizzle Kit emits ordinary `.sql` files. A future team — on any stack, in any language
   — can read them, replay them, and understand the schema without adopting this project's
   tooling. Prisma's history lives in its own DSL and workflow; migrating away means
   translating it out. This is the deciding factor, and it is drawn from the spec rather
   than from preference.
2. **The invariants are database-level, and Drizzle expresses them without fighting.**
   PRD §12 requires `UNIQUE(event_id, user_id)`, partial and conditional constraints, and
   — for S7 — capacity checks that are atomic against concurrent registration for the last
   seat. That last one wants explicit control over transactions and locking. Drizzle's
   SQL-shaped API makes such a constraint plain to read and plain for SECURITY-REVIEWER to
   audit at the Step 2c gate. An ORM that abstracts the query away makes the audit harder,
   and S7 is precisely a property that must be *verified*, not assumed.
3. **The computed-never-stored rule is easier to hold.** PRD §5 forbids storing `no_show`,
   waitlist position, seats taken, `registration_open`, `finished`, and the lineup. These
   become queries — ranking, counting, comparing timestamps. Writing them close to SQL
   keeps them visibly *computed*. A fluent ORM API tends to make an awkward query feel
   like a reason to add a column, which is exactly the failure `DATA-DESIGNER`'s role file
   exists to prevent.
4. **No code-generation step keeps the pipeline simpler.** Prisma requires `prisma
   generate` to stay in sync with the schema; a stale client is a class of failure that
   confuses an automated pipeline (the build passes, the types lie). Drizzle's types come
   from the TypeScript schema directly. Given this project's humanless operation and its
   weak-model-tolerance constraint, removing a whole category of "did you re-run the
   generator?" failure is worth real money.

## What this costs — stated honestly

**Prisma is the friendlier tool for a team that wants to move fast without thinking about
SQL, and its migration workflow has better guardrails** (shadow-database verification
catches a destructive migration that Drizzle Kit will happily generate). That is a genuine
loss and it is accepted deliberately, on the grounds that this database holds ~1 000
people and ~10 events a year — a scale where a careful review of a plain `.sql` file is
entirely practical, and where exportability outlives convenience.

**The mitigation is a requirement, not a hope:** every migration Drizzle Kit generates is
reviewed as SQL before it is applied, and a migration that drops or rewrites a column
carrying personal data or attendance history requires SECURITY-REVIEWER sign-off under
S13 (deletion must anonymize while preserving aggregates). REVIEWER treats an unreviewed
generated migration as a finding.

## Consequence

- REQ-009 adds `drizzle-orm` and `drizzle-kit` to `apps/bot/package.json`, pinned exactly,
  plus a Postgres driver (`postgres` or `pg` — an implementation detail, not a decision
  needing its own record).
- REQ-010/REQ-011 (`DATA-DESIGNER`) express the schema as Drizzle table definitions with
  UUID primary keys, and `tg_id` nullable and **not** a business key, per PRD §1.
- Migrations are committed as generated `.sql` under `apps/bot/`, reviewed as SQL.
- If this is ever reversed, the `.sql` migration history is exactly what carries forward —
  which is the property that motivated the choice.

## Sources consulted

- https://www.bytebase.com/blog/drizzle-vs-prisma/
- https://encore.dev/articles/drizzle-vs-prisma
- https://www.prisma.io/docs/orm/v7/more/comparisons/prisma-and-drizzle (Prisma's own
  comparison, read as an interested source)
- https://makerkit.dev/blog/tutorials/drizzle-vs-prisma
