# REQ-025 — Schema addendum: `notification_ledger` (send-once idempotency guard)

**Role:** DATA-DESIGNER (design only — no implementation code, no migration SQL/TS;
BACKEND-DEV writes both per this artefact, per `.claude/agents/data-designer.md`).

**Scope:** exactly one new table, `notification_ledger`. No other table, column, index,
or constraint is introduced or altered. Builds on `docs/agents/design/REQ-025.md`
(CODE-DESIGNER, `sendLedgeredNotification` §3, `NotificationKind` §2) — that document
designs the read/write sequence against this table; this artefact fixes only the table's
exact shape, which CODE-DESIGNER's own §1 explicitly flagged as out of its scope. Also
builds on `docs/agents/design/REQ-011.md` (`registrations` table, restrict-everywhere FK
convention, `decisions/0006` "evaluation time is an explicit parameter" discipline as
already applied there) and `docs/agents/decisions/0005-orm-drizzle.md` (Drizzle Kit
generates every migration; a migration touching an existing PII column needs
SECURITY-REVIEWER sign-off — inapplicable here, see §5).

---

## 1. What this table is for, restated precisely

`sendLedgeredNotification` (REQ-025.md §3.1 step 4) attempts a single `INSERT` into this
table **before** attempting the actual Telegram send. A duplicate insert on
`(registration_id, kind)` is caught and treated as `{ kind: "skipped-already-sent" }` —
this is the entire mechanism that makes a second run, after a crash or restart, a no-op
(AC1) and the entire mechanism AC2 tests directly by attempting a duplicate insert against
the table itself. The table has exactly one job: hold that constraint. It is **not** an
audit trail (that is `audit_log`'s job, S8) and carries no actor column.

---

## 2. `kind` representation: `text`, not a native `pgEnum` — decision and reasoning

**Decision: `kind` is a plain `text` column**, validated at the application level by the
`NotificationKind` TypeScript union already specified in REQ-025.md §2
(`apps/bot/src/domain/notification.ts`), the same way `chapters.code`, `users.role`, and
`users.lang` are already handled in this schema (REQ-010, `schema.ts` lines 9–14's own
header comment).

**Why not a native `pgEnum`, given `admission`/`event_status`/`event_format` already use
one for comparably closed sets (REQ-011 §2/§4):**

- REQ-011's own stated rationale for choosing `pgEnum` over `text` there is that those
  sets are **small, closed, and stated exhaustively by the PRD with no indication they
  will ever grow** ("the five values are exhaustive by design," REQ-011.md §4). `kind` is
  the opposite case on the one fact that matters: REQ-025.md §1 itself states the set is
  *not* expected to stay at six. `reminder_24h`/`reminder_3h` (REQ-026) and
  `event_cancelled` (REQ-027) are already named as landing "soon," and S10 names two more
  Release-3 marketing kinds after that. This is a set that grows roughly once per
  near-term requirement, not a stable five-value state machine.
- Every one of those additions, under `pgEnum`, is its own `ALTER TYPE ... ADD VALUE`
  migration — a real, recurring cost this project's own `decisions/0005` convention
  (Drizzle-generated migrations, one per schema change) does not reduce, since Drizzle Kit
  still emits a dedicated migration file per enum-value addition. Under `text`, adding
  `"reminder_24h"` as a legal value is a **one-line change to the `NotificationKind` union
  in `domain/notification.ts`** (already TypeScript-only, framework-free per
  decisions/0004) — no migration at all, because the column's type does not encode the
  value set.
- **What a `pgEnum` would actually buy here, weighed honestly:** a structural guarantee
  that no seventh, misspelled, or stale value can ever be written to the column, enforced
  by Postgres itself rather than by whatever TypeScript happens to run at the one call
  site. That guarantee is real, but this table has exactly one write path in the entire
  codebase for the foreseeable future — the single `INSERT` inside
  `sendLedgeredNotification` (REQ-025.md §3.1 step 4), which already receives
  `input.kind: NotificationKind` as a **compile-time-checked** parameter (§3's interface
  gives it no `string` escape hatch). There is no ad-hoc/admin/bulk write path to this
  table the way `audit_log.payload` or `registrations.source` have to guard against —
  every future kind this table will ever hold is added by extending the same union at the
  same call site, so the enum's marginal safety benefit over the union type it would
  duplicate is small, while its migration cost recurs on a cadence this requirement's own
  text says is imminent (twice more within the next two known requirements).
- No acceptance criterion in REQ-025.md's AC1–AC6 tests `kind`'s closedness at the DB
  level (AC2 tests the `UNIQUE` constraint, not a CHECK/enum rejection of an invalid
  kind) — so choosing `text` sacrifices no tested guarantee.
- This mirrors REQ-011 §7's own explicit precedent for `audit_log.action`/`entity`: "Free
  text (not an enum) because... new action strings will be added by future requirements
  as new status-change paths are built, and constraining this to a Postgres `ENUM` now
  would require an `ALTER TYPE` for every new audit-worthy action forever." `kind` is the
  same shape of problem — a value set that grows with new requirements, not a fixed state
  machine — and gets the same answer.

**No DB-level `CHECK (kind IN (...))` either**, for the same reason `chapters.code` and
`users.role` carry none: it would reintroduce the exact recurring-migration cost just
argued against, for a set whose only writer is one compile-time-checked call site.
Flagged as an open question (§7.1) in case SECURITY-REVIEWER/CODE-DESIGN-VALIDATOR wants
belt-and-suspenders DB enforcement anyway — not resolved here by invention either way.

---

## 3. Timestamp column: `created_at`, `DEFAULT now()` — not a caller-supplied parameter

CODE-DESIGNER's REQ-025.md §1 flagged the "moment sent" value as needing to be
caller-supplied, "never `defaultNow()`... matching this schema's `decisions/0006`
discipline already applied to `audit_log.at`." **Checked directly against the actual
schema** (`apps/bot/src/db/schema.ts` line 339) and against REQ-011.md §7's own stated
reasoning for that column: `audit_log.at` is in fact `timestamp(...).notNull().defaultNow()`
— it is **not** caller-supplied, and REQ-011.md §7 says so explicitly: *"`DEFAULT now()`
at write time is appropriate here (unlike a *predicate* evaluated later against a supplied
clock — decisions/0006's rule is about time-dependent *queries*, not about a row
recording *when it was written*, which is exactly what a database default timestamp is
for)."* CODE-DESIGNER's note cites the wrong shape of that precedent — filed as a MINOR
issue (§8) — and this artefact follows the precedent as it actually reads, not as
misdescribed.

**`decisions/0006`'s rule is about a predicate evaluated later against a supplied clock**
(e.g. `finished = ends_at < $evaluation_time`, `registration_open`, `no_show` — REQ-011
§5). A ledger row's own write-time timestamp is not such a predicate: nothing in
REQ-025.md's design ever reads `notification_ledger`'s timestamp back into a
time-window comparison — the table's *only* consumer is the `UNIQUE(registration_id,
kind)` constraint itself (§1). Recording "when this INSERT committed" is exactly the
"row recording when it was written" case REQ-011 §7 already carved out as fine for
`DEFAULT now()`.

**Decision: name it `created_at`, `timestamptz NOT NULL DEFAULT now()`**, matching this
schema's preamble convention on every other table (`chapters`, `users`, `profiles`,
`venues`, `events`, `registrations`, `event_staff`, `audit_log` all carry it identically).
No separate `sent_at`/`at`-style column distinct from `created_at` is needed the way
`audit_log` keeps `at` and `created_at` as two columns — REQ-011.md §7 kept those two
apart only because `audit_log.at` carries its own S8-mandated semantic ("when the audited
event happened") that could in principle diverge from "when this row was inserted" (a
future backfill/import scenario). No such distinct semantic exists here: this table's
`created_at` **is** "the moment the send was recorded," full stop, with no import/backfill
path in scope that could make the two diverge. One column, not two.

`updated_at` is still included, `timestamptz NOT NULL DEFAULT now()`, for the same
schema-wide-consistency reasoning REQ-011.md §7 gave `audit_log.updated_at` despite that
row also being write-once in practice — no requirement here describes ever updating a
ledger row after insert (the row's entire reason to exist is the one atomic `INSERT` in
§3.1 step 4), but the column is kept uniform with every other table rather than special-
cased.

**If a future requirement (most plausibly REQ-026/027, §7.2) ever needs the exact instant
a *reminder* fired for a time-window computation** (e.g. "don't re-send reminder_24h if
one already fired in the last N hours" — not what AC1–AC6 ask for today), that computation
would take `notification_ledger.created_at` as one of its inputs alongside an
explicitly-supplied `$evaluation_time`, per `decisions/0006` — the column itself stays a
plain write-time fact; the *predicate* built on top of it, if one is ever needed, is what
would take the explicit clock parameter. Today, no such predicate exists in this
requirement's scope.

---

## 4. Table specification

| Field | Type | Nullable | Why |
|---|---|---|---|
| `id` | UUID (PK, default gen) | No | Preamble rule, matching every other table. |
| `registration_id` | UUID FK → `registrations.id` | No | The row this notification is about (REQ-025.md §1's stated minimum). A ledger entry with no registration is meaningless — required by construction. Resolves to `registrations.id`, never `users.tg_id` or any Telegram-only identifier, consistent with this schema's binding "stable ids, never a Telegram-only identifier as a business key" rule. |
| `kind` | text | No | See §2. Every ledger row exists to record one specific notification kind having been attempted for one specific registration; a kind-less row cannot participate in the `UNIQUE(registration_id, kind)` constraint meaningfully. Validated at the application level against the `NotificationKind` union (REQ-025.md §2) at the single call site that writes this column. |
| `created_at` | timestamptz, `NOT NULL DEFAULT now()` | No | See §3. The moment this ledger row (and therefore the send attempt) was recorded — a write-time fact, not a time-dependent predicate input, so `DEFAULT now()` is appropriate per REQ-011.md §7's own precedent for `audit_log.at`. |
| `updated_at` | timestamptz, `NOT NULL DEFAULT now()` | No | Preamble rule, kept for schema-wide consistency though no requirement describes ever updating a ledger row after insert (mirrors `audit_log.updated_at`'s identical reasoning, REQ-011.md §7). |

No `actor`/`sent_by` column (REQ-025.md §1 explicitly rules this out — this table is not
an audit trail; `audit_log` already separately records status changes per S8). No
`event_id` column — see §6 on why it is not needed and how an event-scoped query is still
served without it.

**Keys / uniqueness:**

- `id` PK.
- **`UNIQUE (registration_id, kind)`** — the load-bearing constraint. A real database
  unique constraint (Postgres backs it with its own unique index automatically), not an
  application-checked rule. This is the literal mechanism AC1 and AC2 depend on: AC2 tests
  it directly by attempting a duplicate insert against the table, and `sendLedgeredNotification`
  §3.1 step 4 relies on Postgres error code `23505` (unique violation) on this exact
  constraint to detect "already sent" without any in-memory state anywhere (AC2's
  `git grep`-checkable negative — no Set/Map/module-level tracker appears anywhere in this
  design).

**Cascade:** `registration_id` → `ON DELETE RESTRICT` — matches REQ-025.md §1's explicit
instruction ("No `onDelete: 'cascade'`... match this schema's existing restrict-everywhere
convention") and this schema's uniform FK convention (every FK in `schema.ts` today is
`onDelete: "restrict"`). A registration is never hard-deleted under any stated flow in
this codebase (S13 anonymizes users in place, `cancelled`/`withdrawn` are states, not row
deletions, per the one-word-per-concept rule), so this restriction is never expected to
actually block anything in normal operation — it exists to fail loudly rather than
silently orphan or cascade-delete a ledger row if that assumption is ever violated.

---

## 5. Migration and reversibility

A single Drizzle Kit-generated `.sql` file (per `decisions/0005`), purely additive:

```sql
CREATE TABLE notification_ledger (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  registration_id uuid        NOT NULL REFERENCES registrations(id) ON DELETE RESTRICT,
  kind            text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_notification_ledger_registration_kind UNIQUE (registration_id, kind)
);
```

- **One new table, zero existing tables altered.** No column added to, dropped from, or
  retyped on `registrations` or any other existing table. Per `decisions/0005`'s
  consequence section (restated identically in REQ-011.md §9.6 and REQ-016-schema.md §4):
  this migration touches no personal-data column on any existing table, so it does **not**
  trigger the SECURITY-REVIEWER sign-off gate reserved for a migration dropping or
  rewriting PII.
- **Reversible cleanly:** `DROP TABLE notification_ledger;` — nothing else in the schema
  references this table (it is the referencing side of its only FK, not the referenced
  side), so dropping it undoes the migration with no data-loss ambiguity beyond the ledger
  rows themselves, which is the entire content of the table being removed.
- No enum type is created (§2), so there is nothing additional to drop on rollback beyond
  the table itself.

---

## 6. Query pattern check: does REQ-026/027's anticipated "per-event" access need an index or column now?

REQ-026 (T-24h/T-3h reminders) and REQ-027 (cancellation notice) will both need, for a
given event, something like "which admitted/waitlisted registrations for event X have
**not yet** had `kind = 'reminder_24h'` (or `'event_cancelled'`) sent." Checked whether
this table needs its own `event_id` column or a composite index to serve that.

**No `event_id` column is added.** `notification_ledger` has no independent existence
apart from a `registrations` row — `registration_id` already determines the event via
`registrations.event_id` (REQ-011 §4), one join away. Duplicating `event_id` onto this
table would be denormalization with no stated query this design can point to that the join
can't already serve, and would create a second place `event_id` could drift out of sync
with the source of truth on `registrations` — exactly the kind of invented redundancy this
role is bound not to add without a stated requirement forcing it.

**The natural shape of REQ-026/027's query is an anti-join scanning `registrations` for
the target event, not a lookup starting from `notification_ledger`:**

```sql
SELECT r.id
FROM registrations r
LEFT JOIN notification_ledger nl
  ON nl.registration_id = r.id AND nl.kind = 'reminder_24h'
WHERE r.event_id = $1
  AND r.admission IN ('admitted', 'waitlisted')  -- exact set is REQ-026's call
  AND nl.id IS NULL;
```

This query's driving table is `registrations`, already indexed by `event_id` via its
existing FK and the `uq_registrations_event_user`/waitlist-order indexes (REQ-011 §4); the
`LEFT JOIN`'s lookup into `notification_ledger` is keyed on `(registration_id, kind)` —
**exactly the columns the `UNIQUE(registration_id, kind)` constraint's own backing index
already covers**, with `registration_id` as its leading column. No additional index is
needed to serve this join efficiently; the unique constraint's index does double duty as
the lookup index for this exact access pattern.

**No index on `kind` alone is added.** A hypothetical "all `reminder_24h` rows sent in the
last N hours, across all events" query would need one, but no acceptance criterion or
named future requirement asks for that cross-event shape — REQ-026/027's own per-event
anti-join above is what the requirement text actually describes. Flagged as an open
question (§7.3) rather than pre-built.

**Conclusion: this design paints REQ-026/027 into no corner.** Both can be built entirely
on top of `registrations`'s existing indexes plus this table's own `UNIQUE(registration_id,
kind)` index, with no schema change to `notification_ledger` anticipated.

---

## 7. Open questions (not resolved by invention)

1. **No `CHECK (kind IN (...))` constraint.** §2 explains why `text` is chosen over
   `pgEnum`, but a `CHECK` constraint would give some of a `pgEnum`'s DB-level guarantee
   without its `ALTER TYPE` migration cost for *adding* a value (though it would still
   require a migration to *update the CHECK's own value list* each time — a smaller but
   non-zero recurring cost). Declined here for the same reason `chapters.code`/`users.role`
   carry no CHECK: no acceptance criterion asks for it, and the sole writer is already
   compile-time-checked. Flagged for SECURITY-REVIEWER/CODE-DESIGN-VALIDATOR to confirm or
   override.
2. **Whether a future time-window predicate over `created_at` will need to exist** (§3's
   closing paragraph) — not asked for by any AC1–AC6 today; if REQ-026/027 introduce one,
   it must take `$evaluation_time` as an explicit parameter per `decisions/0006`, with
   `created_at` supplying the "when it happened" side of the comparison, never a `now()`
   call inside that future query.
3. **No index on `kind` alone, or on `(kind, created_at)`.** §6 explains the anticipated
   REQ-026/027 access pattern is already served by the `UNIQUE(registration_id, kind)`
   index via a `registrations`-driven anti-join. If a future requirement's actual query
   shape turns out to need a cross-event, kind-first lookup instead, that requirement
   should add the composite index it needs via its own additive migration — not invented
   here speculatively.

---

## 8. Issue found: CODE-DESIGNER's REQ-025.md §1 misdescribes the `audit_log.at` precedent

**Severity: MINOR.** REQ-025.md §1 states the ledger's timestamp "must be a caller-supplied
`Date`, never `defaultNow()`... matching this schema's `decisions/0006`... discipline
already applied to `audit_log.at`." Checked directly: `apps/bot/src/db/schema.ts` line 339
shows `audit_log.at` **is** `timestamp(...).notNull().defaultNow()` — the opposite of
caller-supplied — and REQ-011.md §7 states explicitly why that is correct (`DEFAULT now()`
is for "a row recording when it was written," not a `decisions/0006` predicate). This
artefact follows the precedent as it actually is (§3), not as CODE-DESIGNER's note
described it, per this role's own reasoning (§3) and per core-directives' "verify a
handoff's checkable factual claims before building on them" rule. Recorded here so it is
fixed at the source rather than silently propagated; no rework of REQ-025.md itself is
requested — CODE-DESIGNER's actual design (§3.1's rule table) never depends on which
timestamp discipline is used, only this table's own doc needed correcting.

---

## 9. Acceptance criteria → design element map

| AC | Design element |
|---|---|
| AC1 — restart-safety no-op on second run | §1, §4 `UNIQUE(registration_id, kind)` — the sole mechanism `sendLedgeredNotification` §3.1 step 4 depends on to detect "already sent" after a crash/restart. |
| AC2 — `git grep` finds no in-memory idempotency tracker; the key is a DB `UNIQUE` constraint, verified by direct duplicate insert | §4 "Keys / uniqueness" — a real Postgres `UNIQUE` constraint, not an application-level check; no in-memory state appears anywhere in this table's design. |
| AC3/AC4/AC5/AC6 | Not schema-dependent — these test `sendLedgeredNotification`'s branching logic and the rate limiter (REQ-025.md §3.1/§5), which read/write this table but do not require any additional column, index, or constraint beyond what §4 already specifies. |

---

## 10. Summary for the handoff

One new table, `notification_ledger`: `id` (UUID PK), `registration_id` (UUID, NOT NULL,
FK → `registrations.id` ON DELETE RESTRICT), `kind` (`text`, NOT NULL, app-validated
against the `NotificationKind` union — chosen over `pgEnum` because this value set grows
roughly once per near-term requirement, unlike `admission`/`event_status`'s genuinely
fixed sets, mirroring `audit_log.action`/`entity`'s identical precedent), `created_at`
(`timestamptz NOT NULL DEFAULT now()` — a write-time fact, not a `decisions/0006`
predicate, correcting a MINOR misdescription in REQ-025.md §1's citation of the
`audit_log.at` precedent), `updated_at` (`timestamptz NOT NULL DEFAULT now()`, kept for
schema-wide consistency). The load-bearing `UNIQUE(registration_id, kind)` constraint is
the entire idempotency mechanism AC1/AC2 depend on. Migration is a single additive
`CREATE TABLE`, cleanly reversible via `DROP TABLE`, triggering no SECURITY-REVIEWER PII
sign-off. No `event_id` column or extra index is added — REQ-026/027's anticipated
per-event query is already served by the unique constraint's own backing index via a
`registrations`-driven anti-join (§6), so this design paints no future requirement into a
corner. Three open questions are flagged (§7) rather than resolved by invention.
