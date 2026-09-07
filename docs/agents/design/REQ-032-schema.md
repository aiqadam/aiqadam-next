# REQ-032 — Schema confirmation: `registrations.no_show_reason` stays a single column

**Role:** DATA-DESIGNER (design only — no implementation code, no migration SQL/TS;
BACKEND-DEV runs `drizzle-kit generate` per `.claude/agents/data-designer.md` and
`decisions/0005-orm-drizzle.md`, IF a migration were needed here — it is not, see §2).

**Scope:** one confirmation question routed by `docs/agents/design/REQ-032.md` §0/§8
item 1: whether the existing `registrations.no_show_reason` column (added by REQ-011's
migration `apps/bot/drizzle/0001_tired_annihilus.sql`, currently unused by any code)
should stay a single free-text column, or be split into `reason_code` (closed enum) +
`reason_free_text` (nullable, populated only for "other"), for PRD FR-16's partner
factsheet "why people missed it" aggregation.

**Decision: keep the single column, exactly as CODE-DESIGNER's design proceeds
(REQ-032.md §1.1). No migration is needed for REQ-032.**

---

## 1. Current state, confirmed by inspection

`apps/bot/src/db/schema.ts` line 282:

```ts
noShowReason: text("no_show_reason"),
```

Nullable `text`, no default, no `CHECK`. Added by REQ-011's initial migration
(`apps/bot/drizzle/0001_tired_annihilus.sql` line 58: `"no_show_reason" text`), present
in the schema since Release 1's first migration.

**Confirmed by grep of `apps/bot/src`:** exactly one file references `no_show_reason` /
`noShowReason` today — `apps/bot/src/db/schema.ts` itself (the column declaration and
its comment). No handler, domain function, scheduled job, or test currently reads or
writes it. REQ-032 is genuinely the column's first consumer, matching CODE-DESIGNER's
own stated finding in REQ-032.md §0. This means changing the column's shape today would
touch schema only — no other file in the current codebase would need to change to
accommodate a split. That fact removes the "already-existing, in-use column, risky to
touch" argument from consideration; it does **not**, by itself, settle whether a split is
the right shape (§3 below).

---

## 2. Decision and reasoning

**Keep `no_show_reason` as the single column CODE-DESIGNER's design already assumes.
No schema change, no migration, for REQ-032.**

This is a real tradeoff, weighed on its merits rather than deferred:

### 2.1 The aggregation concern is real, but the single column does not actually block it

FR-16's factsheet needs a "why people missed it" breakdown by category. Against the
single mixed-content column, that breakdown is:

```sql
SELECT
  CASE WHEN no_show_reason = ANY(ARRAY['work_ran_over','illness','forgot','transport','lost_interest'])
       THEN no_show_reason
       ELSE 'other'
  END AS reason_bucket,
  count(*)
FROM registrations
WHERE no_show_reason IS NOT NULL
GROUP BY 1;
```

This is a standard, unremarkable `CASE`/`GROUP BY` — not a fragile parse of raw text. It
produces exactly the six buckets (five fixed reasons + "other") a factsheet line needs,
because `NoShowReasonCode` (REQ-032.md §1.1) is a closed, language-invariant literal set
already written verbatim into this column, distinguishable from free text by simple
set membership. A genuinely "fragile" aggregation would be one that had to group on raw,
uncontrolled free text as if it were categorical — that is not what this query does; the
five literals are canonical and exact-match, and everything else is correctly bucketed
as "other" (which is the semantically correct outcome: an "other" free-text answer is,
by definition, not one of the five named reasons, and a factsheet wanting to also show
*examples* of "other" text can select `no_show_reason` directly for rows outside the
five-literal set).

The two-column split would make this marginally more direct (`GROUP BY reason_code`
instead of a `CASE`), but "marginally more direct SQL for a report that does not yet
exist" is a smaller benefit than it first appears once the query above is written out.

### 2.2 No stated requirement calls for the split yet

FR-16's partner factsheet is not this requirement's scope — REQ-032 implements
USER-STORIES D3 (capturing the reason), not the factsheet that later reads it. No
acceptance criterion of REQ-032 exercises aggregation at all; AC2 only tests "selecting a
reason writes it to `registrations.no_show_reason`, verified by reading the row back"
(REQ-032.md §0), which the single-column shape already satisfies. Splitting the column
now would be shaping storage for a requirement that has not yet been drafted, let alone
specified — the factsheet requirement may end up needing more than a bare code (e.g.
per-partner filtering, a minimum-sample-size suppression rule, a specific bucket order)
that isn't knowable yet. This role's own mandate (`.claude/agents/data-designer.md`,
"Forbidden") is not to add a field a stated requirement does not call for; FR-16 is a
real future need, but "real future need" and "stated requirement in scope right now" are
different bars, and the second is the one that gates a schema change today.

### 2.3 Splitting now has a real, non-schema cost: it reopens CODE-DESIGNER's already-built design

This is the decisive practical reason, alongside §2.2. A two-column split is not
schema-isolated — CODE-DESIGNER's REQ-032.md design already built its entire domain/
handler layer around one nullable string column and one write function:

- `RegistrationNoShowContext.noShowReason: string | null` (§1.2) would need to become two
  fields.
- `writeNoShowReason(db, registrationId, reason: string, at: Date)` (§1.3) — the
  design's *single* write path for both the fixed-code answer and the free-text "other"
  answer — would need a second parameter (or two call shapes) to know which column to
  write.
- The "already answered" gate, checked identically at §3.4 step 3, §4.1 step 8, §4.2
  step 8, and §4.3 step 7 as `context.noShowReason !== null`, would need to check two
  columns' combined state instead of one.
- The five-button callback path (§4.1) writes a fixed code; the "other" path (§4.2/§4.3)
  writes free text — under a split, these two paths would finally target *different*
  columns instead of the same one, which is arguably cleaner, but it is a real reshape
  of every write site this design specifies, not a schema-only edit.

None of that is this artefact's call to make unilaterally (`.claude/agents/
data-designer.md`, "Forbidden: inventing a business rule to resolve an ambiguity" — and
reshaping an already-specified write contract crosses into CODE-DESIGNER's domain, not
mine). Since the single-column shape satisfies every acceptance criterion REQ-032
actually states, and the aggregation concern is addressable later without touching this
requirement's implementation, there is no forcing reason to impose that rework now.

### 2.4 The door stays open, cheaply, for later

If/when a factsheet requirement is drafted and its own DATA-DESIGNER pass determines a
`reason_code`/`reason_free_text` split is genuinely needed, that is a small additive
migration at that time: `ALTER TABLE registrations ADD COLUMN no_show_reason_code
no_show_reason_code_enum` (or `text`), backfill via the same `CASE` expression in §2.1
run once as an `UPDATE`, then decide then whether `no_show_reason` (holding the "other"
free text going forward, or retained as a legacy mirror) needs any further change. That
future migration is strictly additive and non-destructive to any row written under this
design in the meantime — nothing decided here forecloses it. Waiting costs nothing;
splitting now buys a marginally simpler future query at the cost of reopening an
already-complete design today.

---

## 3. Resolved column definition (unchanged from today)

| Column | Type | Nullable | Default | Constraint |
|---|---|---|---|---|
| `no_show_reason` | `text` | Yes | `NULL` (none) | none (no `CHECK`) |

Exact Drizzle declaration (already present, `apps/bot/src/db/schema.ts` line 282, no
edit needed):

```ts
noShowReason: text("no_show_reason"),
```

**Why nullable, no default:** `NULL` means "not asked, or asked and not (yet)
answered" — REQ-032.md §2's design question 2 already establishes these two states are
deliberately not distinguished (STORY-DETAILS D3 treats silence as an acceptable
answer), so no default value and no companion "asked" marker is needed for this column
itself; the once-only send guarantee lives entirely in `notification_ledger`'s existing
`UNIQUE(registration_id, kind)` constraint (REQ-025, reused unchanged), not in anything
on this column.

**Why no `CHECK`:** restated from REQ-032.md §0 and confirmed correct here — the same
column receives both a canonical literal (one of the five `NoShowReasonCode` values,
§1.1) and arbitrary free text (the "other" answer), so no `CHECK ... IN (...)` can
constrain it without rejecting legitimate free-text answers. The closed five-value set is
enforced entirely at the application layer (the fixed five-button keyboard is the only
path that ever emits a code value into this column) — a schema-level constraint would add
no protection a data-integrity attacker/bug couldn't already route around by using the
free-text path, and would actively break the free-text path's legitimate use.

**Why `text`, not a `pgEnum`:** unlike `admission`/`event_format`/`event_status`/
`check_in_method` — this schema's genuinely closed sets, each holding *only* their
enumerated values (REQ-011.md's own stated ENUM rationale) — this column must hold values
outside any fixed set (free text). A Postgres ENUM type cannot represent that; `text`
already is, and remains, the only correct type for a column serving both roles.

---

## 4. What BACKEND-DEV needs to do

**Nothing, for the schema.** No migration, no `schema.ts` edit, no `drizzle-kit
generate` run for this decision. `registrations.no_show_reason` is used exactly as it
already exists in `apps/bot/src/db/schema.ts` and in the latest applied migration state.
BACKEND-DEV's Step 2 work is confined to the domain/handler/job/i18n files REQ-032.md
already lists (§1–§5 of that document) — none of them require a schema change to be
buildable, confirming REQ-032.md §0's own framing that this question was "non-blocking."

---

## 5. Keys, relationships, cascade — unaffected

No key, uniqueness constraint, or relationship changes. `no_show_reason` is a plain
column on the existing `registrations` row; it carries no FK, is not part of any unique
index, and requires no new cascade/anonymize rule beyond what `registrations` rows
already receive under S13 (attendance-history rows survive a person's anonymization,
per `REQ-031-schema.md` §4's identical reasoning for `feedback` — `no_show_reason` is
free text a respondent could voluntarily type identifying content into via the "other"
path, exactly the same class of concern already flagged, unresolved, for `feedback.
liked`/`improve`/`topic_votes`). This artefact **extends that same open question** to
`no_show_reason` rather than resolving it independently: whether free-text no-show
reasons should be included in a future S13 anonymization routine's blanked-field list is
left open, for the same reason (no such routine exists yet in this codebase to specify
against).

---

## 6. What is computed and has no column — restated, unchanged

The boolean `no_show` itself remains fully columnless (REQ-011.md §5, REQ-032.md §1's
`isNoShow`) — this artefact adds nothing to that boundary. `no_show_reason` is the one
piece of this feature that *is* a real stored fact (an answer a person gave), sharply
distinguished from the derived boolean exactly as REQ-011.md §5 already states.

---

## 7. Open questions (not resolved by invention)

1. **Whether a future partner-factsheet requirement should split this column into
   `reason_code`/`reason_free_text`** — deliberately left open here, not resolved either
   way for that future requirement; §2.4 states the split remains cheap and
   non-destructive to add later, additively, once that requirement exists to specify its
   exact needs.
2. **Whether free-text `no_show_reason` values (the "other" answer) should be included
   in a future S13 anonymization routine's blanked-field list** — extends
   `REQ-031-schema.md` §8 item 1's identical open question (there, for `feedback.liked`/
   `improve`/`topic_votes`) to this column; no anonymization routine exists yet in this
   codebase to decide it against.
