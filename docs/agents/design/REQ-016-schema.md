# REQ-016 — Schema addendum: pending deep-link source held against the user

**Role:** DATA-DESIGNER (design only — no implementation code, no migration SQL/TS;
BACKEND-DEV writes both per this artefact, per `.claude/agents/data-designer.md`).

**Scope:** exactly one additive column, on the existing `users` table. REQ-016's own
scope is event CRUD, publish/cancel transitions, and `?start=e_<event_id>` deep-link
resolution (`docs/agents/requirements.yaml` REQ-016) — CODE-DESIGNER's design covers the
handler/conversation-flow side of that; this artefact covers only the storage gap AC5
exposes: there is currently no column or table anywhere in `apps/bot/src/db/schema.ts`
that can hold "the channel suffix held against the user until they register." No other
table, column, index, or constraint is introduced. `events.agenda`'s existing JSONB shape
(REQ-011) is reviewed for AC6/AC7 and found to need no schema change — see §4.

Builds on `docs/agents/design/REQ-010.md` (`users` table, `tg_id` never a business key)
and `docs/agents/design/REQ-011.md` (`registrations.source`, `events.agenda`).

---

## 1. The gap AC5 exposes

REQ-016's description: `?start=e_<event_id>` resolves with "the channel suffix
(`e_<id>__linkedin`) held against the user until they register, at which point REQ-020
writes it to `Registration.source`." AC5: opening the deep link "records the channel
against the user such that a subsequent registration would carry it as
`Registration.source`; verified by reading whatever store holds the pending source after
the deep link and before registration."

`registrations.source` (REQ-011 §4) is `text NOT NULL` and only exists once a
`registrations` row is created — that row cannot exist yet at deep-link-open time (no
registration has happened). So "held against the user" cannot mean a `registrations`
row; it names a piece of state that lives on the person, independent of any event they
haven't yet registered for. The only existing table shaped like "state about a person,
independent of any one event" is `users`. This artefact adds a nullable column there.

---

## 2. Decision: one column, not two, and not a combined field

**Question posed by the task:** does the pending state need to track *which event* it is
for, or just the channel string, given a user can plausibly have at most one in-flight
deep-link-to-registration intent at a time?

**Decision: the channel/source string alone — `users.pending_source` — no
`pending_event_id` column.**

Reasoning:

- AC5's own wording is "held **against the user**" (not "against the user for that
  event"), and the description says the suffix is "held against the user until they
  register" — singular, general, not scoped to one specific event id. This reads as: the
  bot remembers *how* the person arrived, and applies that provenance to whichever
  registration they next complete — not "remembers they specifically intend to register
  for event X via LinkedIn."
- REQ-020 (Registration creation) is what actually knows the target event — the person
  is registering for a specific event at that moment, supplied by the handler's own
  input, not recovered from stored state. Storing `pending_event_id` would duplicate
  information REQ-020's own call already carries, for no stated use: nothing in REQ-016
  or REQ-020's acceptance criteria asks the bot to auto-resume "you were about to
  register for event X" days later, or to cross-check that the registration actually
  matches the pending event before applying the source. Adding that column and its
  matching logic would be inventing a business rule this requirement does not ask for
  (the "don't invent" boundary this role is bound by).
- A single free-text column also matches `registrations.source`'s own treatment in
  REQ-011 §4/§11 open question 4: `source` is free text because PRD 5/12 do not enumerate
  its closed value set. `pending_source` carries exactly the same string that will later
  become that `source` value, so it is typed identically (`text`), for the identical
  reason.
- "One in-flight intent at a time" falls out naturally from a single nullable column
  rather than needing to be separately declared as a rule: opening a second deep link
  before registering simply overwrites the previous value (last-touch wins), which is the
  ordinary, unsurprising behavior of a single mutable field and requires no extra
  constraint to express.

If a later, explicitly-decided requirement needs to also remember *which* event the
pending source belonged to (e.g. to expire it if the person registers for a different
event, or to resume the exact deep link later), that is new scope requiring its own
requirement text and design — flagged as an open question below, not resolved here by
invention.

---

## 3. Column specification

Added to the existing `users` table (`apps/bot/src/db/schema.ts`):

| Field | Type | Nullable | Why |
|---|---|---|---|
| `pending_source` | text | **Yes** | Holds the channel-suffix/source string from the most recently opened `?start=e_<id>__<channel>` deep link (e.g. `"linkedin"`, or whatever exact string REQ-020 is to copy verbatim into `Registration.source` — CODE-DESIGNER's handler design states the precise value written here, e.g. bare `"linkedin"` vs. a composed value; this artefact only fixes the column's existence and type). **Yes**, nullable — the overwhelming majority of users never open a suffixed deep link at all, and even those who do have this column cleared (see below) the moment they register; a `NOT NULL` column would force every row, including every pre-existing and every organizer-pre-created `User` (REQ-010 — `tg_id` nullable, created before first `/start`), to carry a meaningless default value. Required-vs-optional test from the preamble rule: this field is optional because nothing about finishing registration, or any other flow, depends on it being present — a deep link with no suffix (`e_<id>` alone) or no deep link at all leaves it `NULL` forever, and the person registers normally with whatever `source` REQ-020 falls back to in that case (CODE-DESIGNER's scope, not this artefact's). |

No `pending_event_id`, no `pending_source_at`/expiry timestamp column is added — see §2
and §6 open questions.

**Not a candidate for a `NOT NULL` + `DEFAULT ''` pattern:** `NULL` here is meaningfully
distinct from "opened a deep link with an empty channel," which cannot occur (the
`__<channel>` suffix, when present, is never empty by construction of the deep-link
payload) — so `NULL` unambiguously means "no pending source is held," with no collision
risk against a legitimate stored value.

**Lifecycle (stated for REQ-020's benefit, not itself a schema element):** REQ-016's own
handler sets `pending_source` when a suffixed deep link is opened. REQ-020, at the moment
it creates the `registrations` row, reads `users.pending_source`, copies it into that
row's `source`, and clears the column back to `NULL` on the same user row — "held...
until they register" implies the holding ends at registration, not that it persists
alongside the now-fulfilled intent. This clear-on-consume step is REQ-020's
responsibility to implement; it is stated here because a design that adds a column
without saying when it is read and released would leave a stale value sitting on `users`
indefinitely, which is a data-hygiene gap worth naming even though implementing the read/
clear is out of this artefact's role.

---

## 4. Migration

A single additive, reversible `ALTER TABLE` — no existing column touched, no existing
row's data altered (every existing `users` row simply gains a `NULL` in the new column):

```sql
ALTER TABLE users ADD COLUMN pending_source text;
```

Reversible cleanly: `ALTER TABLE users DROP COLUMN pending_source;` — since no other
table or constraint ever references this column (it is a plain scalar, no FK, no
uniqueness, no index requested by any acceptance criterion), dropping it loses nothing
but the in-flight pending state itself, which by definition is transient, non-critical
data (a lost pending source degrades gracefully to "no attribution recorded," not a
correctness failure — REQ-020's fallback source, if any, is CODE-DESIGNER/BACKEND-DEV's
concern).

Per `decisions/0005`'s consequence section (restated from REQ-011 §9.6): this migration
adds one nullable column to an existing table and alters no existing column's type,
constraint, or content — it is purely additive and touches no personal-data column. It
does **not** trigger the SECURITY-REVIEWER sign-off gate that decision reserves for a
migration dropping or rewriting PII.

No index is specified: nothing in REQ-016's acceptance criteria queries `users` by
`pending_source` (it is always read by the already-known `user_id`, e.g. inside REQ-020's
registration-creation transaction), so an index would have no stated query to serve —
consistent with PRD 1's stated load (peak 0.06 rps, DB < 50MB) making point-lookups by
primary key already fast without one.

---

## 5. S11/S13 relevance — not sensitive PII

**S11 (PII never appears in plaintext logs):** `pending_source` holds an attribution tag
— a channel label like `"linkedin"` describing *how* a person arrived, not information
*about* the person (not a phone, email, name, or other PRD-listed personal-data field).
It is not phone or email and S11's plaintext-logging prohibition, which is scoped to
those two fields (and by extension to fields recognizable as personal data), does not
apply to it. It may appear in logs or audit payloads without violating S11 — though as a
matter of least-surprise hygiene, whoever implements the read/clear step should still
avoid gratuitously logging it where not needed, simply as general log-noise discipline,
not because S11 specifically forbids it.

**S13 (deletion anonymizes and preserves aggregates):** `/profile → delete my data`
anonymizes the person in place. `pending_source` carries no identity-linking or
attendance-history content — clearing it to `NULL` on anonymization (alongside whatever
else S13's anonymization routine blanks) loses nothing S13 requires to be preserved (it
is not an aggregate, not attendance history, not a count). It should simply be included
in whatever field list the anonymization routine already blanks, for consistency, but its
presence or absence there has no bearing on S13's actual guarantee.

**No S13 sign-off / no `decisions/0005` PII-migration gate applies to *this* migration**
(§4) — it is additive, touches no existing personal-data column, and the column itself
carries no personal data.

---

## 6. `events.agenda[]` (REQ-011) — confirmed sufficient for AC6/AC7, no schema change

REQ-016 AC6 ("a doors item whose time is later than `starts_at` is refused... any agenda
item later than `ends_at` is likewise refused") and AC7 ("at most one doors item may
exist... adding a second is refused") are both **write-time validation rules against
already-existing data**, not new facts that need a place to live:

- `starts_at` and `ends_at` already exist as columns on `events` (REQ-011 §2). Validating
  a candidate agenda item's `at` value against them requires only reading two columns
  already present on the same row being edited — no new column, no new relationship.
- REQ-011 §3 already defines `agenda`'s shape (`{kind, at, label}` JSON array) and
  already flags, as open question 2, that "at most one `kind: 'doors'` item" is
  explicitly an **application-level invariant enforced where the agenda is written**, not
  a DB constraint — REQ-011 considered and declined a `CHECK` using
  `jsonb_path_query_array(...)` length assertion for this exact rule, calling it
  "possible but adds complexity current acceptance criteria do not demand." REQ-016 AC7 is
  that same rule now made load-bearing (an actual acceptance criterion requiring the
  refusal to fire), but it does not change which layer is asked to enforce it — REQ-011's
  own reasoning for leaving it at the application level (the agenda array is written
  atomically as a whole on every edit, so the write path is the natural single place to
  validate "does this replacement array contain more than one doors item," and a JSONB
  `CHECK` doing the equivalent scan is markedly more complex than the same scan already
  running in the handler that assembles the array) still holds and is not overridden here.

**Confirmed reading: no new column, index, or DB-level constraint is required for AC6 or
AC7.** Both are validation logic that belongs in the handler/domain code that
constructs or replaces `events.agenda` before the write (CODE-DESIGNER's/BACKEND-DEV's
scope) — the handler already has `starts_at`, `ends_at`, and the full candidate array in
hand at that point, which is everything both rules need.

**Do I think a DB constraint is warranted instead?** No. A `CHECK` constraint expressing
"every element's `at` lies between some floor and `ends_at`" cannot reference sibling
*columns* (`starts_at`/`ends_at`) from inside a `CHECK` on `agenda` without a
cross-column `CHECK` referencing all three columns at once (Postgres does support
multi-column `CHECK`s, so this is technically feasible), but doing so via a
`jsonb_path_query`-based expression for a per-item time-bound comparison is exactly the
"adds complexity current acceptance criteria do not demand" territory REQ-011 §11 open
question 2 already named for the doors-cardinality rule — the acceptance criteria here
test observable refusal behavior via the application, not a specific enforcement
mechanism, and the existing values (`starts_at`, `ends_at`, the candidate array) are
already fully available to whichever handler performs the edit. Recommending a DB
`CHECK` here would be adding enforcement machinery the requirement does not ask for,
which is the exact overreach this role is bound not to introduce. No schema change is
proposed for AC6/AC7.

---

## 7. Drizzle schema shape (pseudocode — not implementation)

```
table users:  -- (existing REQ-010 table, additive column only)
  ...(all existing columns unchanged)...
  pending_source   text   NULL   -- REQ-016 AC5: channel/source held against the user
                                 -- from an opened e_<id>__<channel> deep link, until
                                 -- REQ-020 copies it into registrations.source and
                                 -- clears it back to NULL on this same row.
```

---

## 8. Acceptance criteria → design element map

| AC | Design element satisfying it |
|---|---|
| AC5 (opening `?start=e_<published id>__linkedin` records the channel against the user such that a subsequent registration would carry it as `Registration.source`; verified by reading whatever store holds the pending source after the deep link and before registration) | §1–§3: `users.pending_source`, nullable `text`, set by REQ-016's deep-link handler and readable directly off the `users` row before any `registrations` row exists — this is the "whatever store" the AC asks the verifier to read. §3's lifecycle note states REQ-020 is the consumer that copies it into `Registration.source` and clears it. |
| AC6 (doors item later than `starts_at` refused, naming the item; any agenda item later than `ends_at` refused; no invented lower bound) | §6 — confirmed no schema change needed; validation reads existing `events.starts_at`/`ends_at`/`agenda` columns (REQ-011 §2/§3) at write time, application-level per REQ-011's own established pattern. |
| AC7 (at most one doors item in `agenda[]`; adding a second refused) | §6 — confirmed no schema change needed; REQ-011 §11 open question 2 already named this as an application-level, atomic-array-replacement invariant, and that reasoning is restated as still correct rather than overridden. |

(AC1–AC4 and AC8 of REQ-016 concern `events`/`registrations` state-transition and
audit-row behavior already fully covered by REQ-011's existing schema — `events.status`
enum, `audit_log` table — and require no additional schema element from this artefact.)

---

## 9. Migration and reversibility summary

One `.sql` file (per `decisions/0005`, Drizzle Kit-generated, committed under
`apps/bot/`), containing exactly:

```sql
ALTER TABLE users ADD COLUMN pending_source text;
```

- Purely additive: one nullable column on one existing table, no other table/column
  altered, no data migration/backfill needed (existing rows simply read `NULL`).
- Reversible: `ALTER TABLE users DROP COLUMN pending_source;` — no dependent FK, index,
  or constraint references it, so the drop is unconditional and safe.
- No `decisions/0005` PII-migration / S13 sign-off gate applies (§5) — additive, no
  existing personal-data column touched, and the column's own content is an attribution
  tag, not personal data.
- No schema change is proposed for AC6/AC7 (§6) — those are application-level validation
  against columns REQ-011 already created.

---

## 10. Open questions (not resolved by invention)

1. **Exact string written into `pending_source`.** This artefact fixes the column as a
   free-text field holding whatever value REQ-020 is meant to copy verbatim into
   `Registration.source`, but does not fix whether that value is the bare channel token
   (`"linkedin"`), the full `e_<id>__linkedin` payload, or some other normalized form —
   that is a handler/parsing decision for CODE-DESIGNER's REQ-016 design and/or REQ-020's
   own design to state explicitly, consistent with REQ-011 §11 open question 4 leaving
   `registrations.source`'s value set itself unenumerated.
2. **No expiry policy.** The requirement text does not say whether a very old pending
   source (opened, then never followed by a registration for days or weeks) should ever
   be treated as stale/expired rather than still applying to a future registration. No
   `pending_source_at` timestamp column is added on the assumption that no expiry is
   needed — that assumption is stated here explicitly rather than silently baked in, so a
   future requirement can add a timestamp column and expiry check by explicit decision if
   this behavior turns out to be wrong (e.g. "no, a source held for six months should not
   still be applied").
3. **Whether "held against the user" ever needs to be event-scoped.** §2 decided against
   a `pending_event_id` column on the reading that AC5's language is general-purpose
   provenance, not a per-event reservation. If REQ-020 or a later requirement discovers a
   stated need to only apply the pending source when the registration is for the *same*
   event the deep link named (e.g. to avoid misattributing a LinkedIn-sourced click on
   event A to an unrelated registration for event B opened via a different path), that is
   new scope requiring its own requirement text — not something this artefact resolves by
   adding the column preemptively.
4. **Clear-on-consume is REQ-020's implementation, not this artefact's.** §3 states the
   expected lifecycle (write on deep-link open, read-and-clear on registration) as
   necessary context for why the column is nullable and untimestamped, but the actual
   clear step is BACKEND-DEV's responsibility when REQ-020 is implemented; this artefact
   does not enforce it at the schema level (no trigger, no computed clearing mechanism —
   none is warranted for a single application-level read-then-null write inside REQ-020's
   own transaction).

---

## 11. Summary for the handoff

One additive column: `users.pending_source` (`text`, nullable). Holds the channel suffix
from an opened `?start=e_<event_id>__<channel>` deep link, "against the user" in the
literal sense of AC5's wording — not scoped to a specific pending event, since no stated
requirement needs that scoping and REQ-020 already knows the target event from its own
call. Migration is a single `ALTER TABLE users ADD COLUMN pending_source text;` —
additive, reversible, no S13/`decisions/0005` PII sign-off triggered, and the column
itself is an attribution tag, not personal data under S11. `events.agenda[]` (REQ-011)
needs no schema change for AC6/AC7 — both are write-time application validation against
`starts_at`/`ends_at`/the candidate array, consistent with REQ-011 §11's own prior
decision to leave the doors-cardinality rule at the application level. Four open
questions are flagged (§10) rather than resolved by invention: the exact string format
written into the column, whether any expiry policy is wanted, whether event-scoping is
ever needed, and that the read-and-clear step belongs to REQ-020's implementation.
