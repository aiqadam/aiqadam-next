# REQ-040-schema — `invite_list_entries` table design

**Role:** DATA-DESIGNER (design only — no implementation code, no migration SQL/TS;
BACKEND-DEV adds this table to `apps/bot/src/db/schema.ts` and runs `drizzle-kit
generate` per `.claude/agents/data-designer.md` and `decisions/0005-orm-drizzle.md`).

**Scope:** resolves exactly the four items `docs/agents/design/REQ-040.md` §3.1/§8 open
question 3 defers to DATA-DESIGNER — the exact column shape, the uniqueness constraint,
the add/remove mechanism, and the relink-under-uniqueness scenario — plus weighs in on
open question 1 (§3.4's business-card-field placement) from a data-design angle, as the
handoff requests. **No other resolved decision in REQ-040.md is revisited here** —
`opened_at`'s semantics (§3.2), the `registered`/`attended` derivation (§3.3), the
relink *mechanism*'s scope (all of A's events, §2.4), and the audit-action taxonomy (§5)
are all reused unchanged as given.

---

## 0. Re-verified against the live schema

`apps/bot/src/db/schema.ts` (current, 495 lines) confirmed by reading in full:

- No `invite_list_entries` table exists yet — this is a pure addition, no `ALTER` of any
  existing table.
- `audit_log.entity_id` is `uuid("entity_id").notNull()` with **no `.references()`
  call** — it is explicitly polymorphic/non-FK (REQ-011.md §7's own stated reasoning,
  restated in the column comment: "a single column cannot reference more than one target
  table"). This is load-bearing for §2 below: a hard `DELETE` of an
  `invite_list_entries` row can never break an `audit_log` row that names it, because
  `audit_log` never held a real foreign key to it in the first place.
- Every existing table's `created_at`/`updated_at` pair is `timestamptz NOT NULL DEFAULT
  now()` — the universal convention this table also follows.
- Every person/entity-referencing FK in this schema (`registrations.user_id`,
  `.checked_in_by`, `.invited_by_user_id`, `.invite_code_id`; `invite_codes.
  issued_to_user_id`, `.grants_companion_of`; `event_staff.user_id`;
  `notification_ledger.registration_id`; `feedback.registration_id`; `venues.chapter_id`
  etc.) is `ON DELETE RESTRICT`, uniformly. No table in this schema uses `CASCADE` or
  `SET NULL` anywhere. This table follows the same posture (§1).
- `apps/bot/drizzle/meta/_journal.json` currently ends at `idx: 7`, tag
  `0007_sturdy_network`. The migration this design implies is BACKEND-DEV's next
  `drizzle-kit generate` output, expected to land as `0008_*` — additive only (`CREATE
  TABLE`, no `ALTER` of an existing table), so it is a **trivially reversible** migration
  (`DROP TABLE invite_list_entries` undoes it completely, with no data loss to any other
  table).
- `domain/profile.ts`'s `createWalkinProfile` confirms the codebase's established
  `""`-means-"not given" convention: the column itself is plain nullable `text` with no
  default, and the `"" → null` translation happens in application code
  (`company: input.company === "" ? null : input.company`), never in the schema. This
  table's optional business-card fields follow the identical pattern (§1.3).

---

## 1. Resolved column definitions

| Column | Type | Nullable | Default | FK / constraint |
|---|---|---|---|---|
| `id` | `uuid` | No | `gen_random_uuid()` | Primary key |
| `event_id` | `uuid` | No | — | FK → `events.id`, `ON DELETE RESTRICT` |
| `user_id` | `uuid` | No | — | FK → `users.id`, `ON DELETE RESTRICT` |
| `invite_code_id` | `uuid` | **Yes** | `NULL` | FK → `invite_codes.id`, `ON DELETE RESTRICT` |
| `added_by` | `uuid` | No | — | FK → `users.id`, `ON DELETE RESTRICT` |
| `opened_at` | `timestamptz` | **Yes** | `NULL` | — |
| `name` | `text` | No | — | — |
| `company` | `text` | **Yes** | `NULL` | — |
| `position` | `text` | **Yes** | `NULL` | — |
| `created_at` | `timestamptz` | No | `now()` | — (this table's `added_at`, §1.1) |
| `updated_at` | `timestamptz` | No | `now()` | — |

Reference shape (BACKEND-DEV's starting point for the `schema.ts` addition — stated
conceptually, not as literal Drizzle syntax): a `uuid` primary key defaulting to a
random value; four `uuid` foreign keys — `event_id` (→ `events.id`, required),
`user_id` (→ `users.id`, required), `invite_code_id` (→ `invite_codes.id`, optional —
the one nullable FK), `added_by` (→ `users.id`, required) — each `ON DELETE RESTRICT`,
matching this schema's uniform FK posture (§0); a nullable `opened_at` timestamp with no
default; three plain text columns (`name` required, `company`/`position` optional); the
usual `created_at`/`updated_at` `timestamptz NOT NULL DEFAULT now()` pair; and one named
unique index, `uq_invite_list_entries_event_user`, on `(event_id, user_id)` (§2). The
Column|Type|Nullable|Default|FK table above is the authoritative shape; this paragraph
only restates it in words for a reader moving straight to `schema.ts`. BACKEND-DEV
writes the actual `pgTable(...)` definition and runs `drizzle-kit generate`.

### 1.1 `added_at` is `created_at`, not a second column

REQ-040.md §3.1 left this open ("DATA-DESIGNER decides whether `added_at` duplicates or
is simply `created_at` under this table's own name for that pair"). **Resolution: no
separate `added_at` column.** `created_at` already means exactly "when this row first
existed," which is precisely what "when the entry was added" means for a table whose
only lifecycle events are add and (hard) remove (§2) — there is no update-in-place
history this row accrues that would make "added" and "created" diverge, unlike, say,
`registrations` where `created_at` (request time) and a hypothetical "admitted at" are
genuinely different instants. Adding a second column that always equals `created_at`
would be a pure duplicate with no independent fact behind it — precisely what this
role's "no field a stated requirement does not call for" constraint rules out. Every
reference to "`added_at`" elsewhere (REQ-040.md §3.1, its audit-payload prose) reads as
this table's `created_at`.

### 1.2 `name` is `NOT NULL`; `company`/`position` are nullable, no default

- `name` — REQ-040.md §4.1 already states the handler refuses a blank name before the
  `INSERT` ("`name` required — usage-message refusal if blank"). Making the column
  itself `NOT NULL` is the same belt-and-suspenders discipline `registrations`'
  `chk_registrations_checked_in_only_if_admitted` and `feedback`'s `chk_feedback_
  nps_range` already establish for this codebase: a rule the handler enforces is *also*
  made structurally impossible to violate at the row level, so a future write path that
  forgets the handler-level check still cannot produce a nameless entry.
- `company`/`position` — plain nullable `text`, no default, no `CHECK`. This directly
  answers the handoff's item 5 question ("should these fields be nullable/optional so an
  organizer can add a minimal 'just a name' entry?") — **yes**: with `name` the only
  `NOT NULL` business-card column, `/invite_list_add <event_id> <name> | |` (empty
  company/position) is a legal row. The `""`-means-"not given" translation is
  application-level, exactly `createWalkinProfile`'s established convention (§0) — this
  schema does not encode "not given" as anything other than `NULL`, matching every other
  optional `profiles` column.

### 1.3 Why these fields live on `invite_list_entries`, not `profiles` — data-design concurrence

CODE-DESIGNER's §3.4 reasoning (S1 scope: organizer's own independently-known data vs.
data the guest told the bot) is the security/consent argument. From a pure data-shape
angle, three further points support the same placement:

1. **No second "guest" concept is available to hold them instead.** REQ-040.md's own
   opening line rules out a parallel guest table. The only two candidates are `profiles`
   (ruled out, §3.4) and this table. There is no third option that doesn't reintroduce
   the "second identity representation" failure mode DESIGN-REVIEW.md already warned
   against.
2. **The fields are more correctly *per-entry* than per-person.** A business card an
   organizer holds for a guest is a fact about *this instance of listing them for this
   event*, not a durable fact about the `users` row — an organizer might list the same
   pre-created guest for two different events months apart with an updated `company`
   (they changed jobs) each time, with each list's own row correctly preserving what the
   organizer knew *at that add-time*, not silently overwriting a shared value. A
   per-`users` column (even hypothetically) would force a single, mutable, cross-event
   "guest card" that neither the requirement nor any AC asks for.
3. **§4.2's display-precedence rule (profiles data wins once it exists) only works
   cleanly if these are two structurally distinct columns**, not one column being
   migrated in place — the `LEFT JOIN profiles ... COALESCE(profiles.x, invite_list_
   entries.x)` shape REQ-040.md §4.2 already specifies needs both sides to exist
   independently.

No schema-level structural safeguard beyond nullability (§1.2) is needed or proposed —
the S1/S3 boundary questions (open question 1 in REQ-040.md §8) remain SECURITY-
REVIEWER's to close, restated, not re-litigated, here.

---

## 2. Uniqueness — `UNIQUE(event_id, user_id)` adopted

**Decision: adopt the recommendation.** `uq_invite_list_entries_event_user`, a plain
(non-partial) unique index on `(event_id, user_id)`, mirroring `registrations`'
`uq_registrations_event_user` and `event_staff`'s `uq_event_staff_event_user` — both
already establish "one row per (event, person)" as this codebase's standing pattern for
membership-shaped tables, and nothing about a list entry's semantics differs from that
pattern: a person is either on a given event's invitation list or not, never twice.

Adopting it (rather than leaving it unenforced) also directly serves AC2 (two never-seen
guests can each be added once without collision — unaffected, they get different
`user_id`s) and structurally forecloses an organizer accidentally double-adding the same
person to the same event's list through two separate `/invite_list_add` calls, which no
AC exercises but which the constraint prevents for free.

This constraint is **not** partial (contrast `registrations_waitlist_order_idx`'s `WHERE
admission = 'waitlisted'` partial index) because there is no soft-state column on this
table to exclude rows by (§3 — remove is a hard `DELETE`, so there is never a "removed
but still present" row for the index to need to skip).

---

## 3. Remove mechanism — hard `DELETE`, not `removed_at`

**Decision: hard `DELETE`.**

### 3.1 Why hard delete is safe here (the audit-row question the handoff poses)

The handoff asks directly: "does a hard DELETE still let you write an audit row
referencing the now-gone entity?" **Yes, cleanly** — confirmed by §0's re-reading of the
live schema: `audit_log.entity_id` carries **no foreign key** (it is `uuid().notNull()`
with no `.references()`, REQ-011.md §7's polymorphic-column design, unchanged since
Release 1). Nothing in this schema requires the row an `audit_log` entry names to still
exist — `audit_log` already holds historical facts about rows that may since have
changed or, in this table's case, been deleted. `AC11`'s "removing a list entry writes
exactly one `audit_log` row" (§4.4's `invite_list.remove` action, REQ-040.md §5) is
satisfied by writing that row **before** or **in the same transaction as** the `DELETE`
— the write order within the transaction is BACKEND-DEV's implementation detail, not a
schema constraint, since no FK enforces an ordering either way.

### 3.2 Why hard delete over `removed_at`, on the merits

- **No AC or STORY-DETAILS text asks for a removed entry to remain visible, filterable,
  or re-activatable anywhere in the list UI.** §4.2's list view (REQ-040.md) queries
  `invite_list_entries` with no mention of a removed/active filter — a `removed_at`
  column would need every read site to remember to exclude removed rows (`WHERE
  removed_at IS NULL`), a discipline this table has no other precedent needing (contrast
  `registrations`, which genuinely needs `admission` because a withdrawn/rejected
  registration is still meaningfully "the same person's outcome for this event" that the
  product needs to keep showing history for — a removed list entry has no analogous
  stated need).
- **A soft marker reopens the uniqueness question for no benefit.** If `removed_at` were
  added, `UNIQUE(event_id, user_id)` (§2) would need to become a **partial** index
  (`WHERE removed_at IS NULL`) to let a removed guest be re-added — exactly the
  `registrations_waitlist_order_idx` pattern, but adopted here purely to route around a
  self-inflicted problem rather than to serve a real query. Hard delete has no such
  side effect: the plain unique index is correct as-is (§2), and removing then re-adding
  the same person is trivially just `DELETE` followed by a fresh `INSERT` — which
  directly resolves REQ-040.md §8 open question 4 ("re-adding a previously removed
  guest") as a non-issue requiring no special-case rule: it is simply adding a row, same
  as adding any other guest, because no trace of the prior entry exists to conflict with
  it.
- **This table records list *membership*, not an *outcome*.** `registrations.admission`
  encodes a decision with downstream meaning (`rejected` vs. `withdrawn` are
  semantically distinct and both matter for reporting/audit). "On the list" vs. "not on
  the list" carries no equivalent distinction worth a stored word — `audit_log`'s
  `invite_list.add`/`invite_list.remove` rows (§5, REQ-040.md, unaffected by this choice)
  already carry the complete historical record of who was added/removed and when, which
  is the actual "history" the product needs; the *current* list should show only current
  membership, which a hard delete expresses directly.

### 3.3 What is explicitly not affected by this choice

Removing a list entry **never** touches the underlying `users` row (REQ-040.md §4.4,
restated) — the row `A` a removed entry pointed at is untouched, `tg_id` unchanged, still
present for e.g. a later invite-code issue via REQ-037's raw path. Only the membership
row (`invite_list_entries`) is deleted.

---

## 4. Relink scenario, traced against `UNIQUE(event_id, user_id)`

The handoff's central question: does adopting `UNIQUE(event_id, user_id)` (§2) create a
conflict risk during REQ-040.md §2.4's collision-relink, if the real account (**B**)
already has its own entry for the same event **A**'s entry is being repointed from?

**Yes, a conflict is possible, and this design states the exact mechanism that avoids
it — a plain two-statement sequence, no new upsert primitive needed.**

### 4.1 The scenario, concretely

- **A** — the pre-created placeholder row, `tg_id NULL`. Per REQ-040.md §2.4 point 2,
  *every* `invite_list_entries` row with `user_id = A.id` is repointed on relink, across
  *all* events A appears on — not only the event being redeemed. Say A has entries for
  events `E1` (the event being redeemed) and `E2` (some other event A was separately
  listed for).
- **B** — the redeemer's own, separate, pre-existing `users` row (the collision case,
  §2.4). Suppose an organizer had, independently and earlier, *also* added **B** (the
  real, known person) directly to `E2`'s list — entirely plausible: B is a known
  community member who might legitimately appear on other organizers' lists under their
  own identity, unrelated to A's placeholder existing for a different, VIP-outreach
  purpose.
- Now: `invite_list_entries` holds `(E1, A)`, `(E2, A)`, and `(E2, B)`. The relink must
  repoint `(E1, A) → (E1, B)` and `(E2, A) → (E2, B)`. The first is unobstructed. The
  second collides: `(E2, B)` already exists, and `UNIQUE(event_id, user_id)` forbids a
  second `(E2, B)` row.

### 4.2 Resolution — conflict-free relink in two statements, one transaction

Stated conceptually (BACKEND-DEV's implementation, not this artefact's):

- **Step 1 — a conditional repoint.** Update every `invite_list_entries` row currently
  pointing at `user_id = A` to instead point at `user_id = B`, but only where doing so
  would not collide with §2's unique constraint — i.e. only where no row already exists
  for that same `event_id` with `user_id = B`. A row-existence check scoped to
  `(event_id, B)` is the condition; rows for events where B already has an entry are
  left untouched by this step.
- **Step 2 — cleanup of the leftovers.** Delete every remaining `invite_list_entries`
  row still pointing at `user_id = A` (exactly the rows step 1's condition skipped,
  because B already had an entry for that event). B's own pre-existing entry for that
  event is never read or written by this step — it is simply left in place.
- Both steps run inside one transaction, so the pair is atomic: either both apply or
  neither does.

Traced against the scenario: step 1 repoints `(E1, A) → (E1, B)` (no conflict) and
leaves `(E2, A)` alone (conflict exists, `NOT EXISTS` is false). Step 2 then deletes the
one remaining row, `(E2, A)`. Final state: `(E1, B)` and `(E2, B)` — exactly one entry
per event for B, `A` holds zero entries anywhere, matching REQ-040.md §2.4 point 3's "A
is left inert... no longer the target of any list entry."

This is a direct instance of §3's hard-delete mechanism, not a new one: the conflicting
row is not "merged" field-by-field (no data is copied from A's entry into B's — B's
pre-existing entry for E2 is already the more relevant record: it reflects an organizer
directly, deliberately choosing to list B under their own real identity, which is
strictly more authoritative than a placeholder's business-card guess). This composes
cleanly with REQ-040.md §2.4 point 1's separate `invite_codes.issued_to_user_id`
repoint (unaffected by this table's conflict — `invite_codes` carries no analogous
unique constraint on `issued_to_user_id` that this scenario could collide with, per
REQ-033.md's own open question 2 confirming no such constraint exists).

### 4.3 Audit-row count under this scenario

REQ-040.md §5/§2.4 point 4 states one `invite_list.entry_relinked` `audit_log` row **per
repointed entry**. This design extends that literally: one row per entry that
*originally* belonged to A (whether it ends as an `UPDATE` in step 1 or a `DELETE` in
step 2) — the fact recorded is identical either way ("A's list membership fact for this
event is now represented by B"), and the payload shape already carries `eventId`, making
the two cases indistinguishable to a reader of the audit trail by design: from the
organizer's perspective, both outcomes mean exactly the same thing — "this event's list
now shows B where it used to show A." In the scenario above, that is **two** rows (one
for `E1`, one for `E2`), matching "one per repointed entry" read as "one per entry A
held," not "one per successful `UPDATE`."

### 4.4 Why this does not require inventing a new business rule

The handoff's framing ("does this create a conflict risk... trace this scenario") asks
for a mechanism, not a new outcome — REQ-040.md §2.4 has already decided the *business*
question (never merge identity-bearing data, only touch this table's own rows,
retire A permanently). Resolving *this* table's own internal duplicate — two rows both
correctly, if redundantly, asserting "B is on E2's list" — by keeping the one that
already existed and dropping the newly-orphaned duplicate is a data-shape mechanic
entirely internal to this table, the same class of decision §3's remove-mechanism choice
already is, not a new fact about identity or eligibility. No alternative reading (e.g.
attempting to merge `name`/`company`/`position` from A's entry into B's, or preferring
A's `invite_code_id` over B's) is adopted, because REQ-040.md §2.4 already establishes
B's own existing, real data as the more authoritative side of any such comparison — a
principle this table's conflict resolution simply inherits rather than re-derives.

---

## 5. Keys, relationships, and cascade behavior — summary

| Relationship | Cascade / delete behavior |
|---|---|
| `invite_list_entries.event_id → events.id` | `ON DELETE RESTRICT` — an event with any list entries cannot be deleted (matches every other `events.id` reference in this schema). |
| `invite_list_entries.user_id → users.id` | `ON DELETE RESTRICT` — a user (placeholder or real) named by a list entry cannot be deleted while the entry exists. Repointed, never nulled, on relink (§4). |
| `invite_list_entries.added_by → users.id` | `ON DELETE RESTRICT` — the organizer who added an entry is never removable while that historical attribution exists (same posture as `registrations.checked_in_by`). |
| `invite_list_entries.invite_code_id → invite_codes.id` | `ON DELETE RESTRICT`, nullable. An issued code cannot be deleted out from under the entry that references it; the entry can exist with no code at all (`NULL`), per STORY-DETAILS F9 step 2. |
| Removal of a list entry | Hard `DELETE` of the `invite_list_entries` row only (§3) — never touches `users`, `invite_codes`, `registrations`, or `audit_log`. |
| Anonymization (S13, if ever applied to a `users` row) | Out of scope for this design — no anonymization routine exists yet in this codebase to specify against (same open-question posture `REQ-031-schema.md` §8/`REQ-032-schema.md` §7 already carry forward for `feedback`/`no_show_reason`). Flagged, not resolved, here: if/when such a routine exists, whether an *inert, retired* placeholder row (§4, post-relink `A`) should also be anonymized despite holding no reachable list entries is an open question for that future routine. |

---

## 6. What is computed and has no column — restated, unchanged

`registered`/`attended` remain fully columnless (REQ-040.md §3.3, reused verbatim — no
change proposed here). This table's only stored facts are exactly the four REQ-040.md §7
already enumerates as closed: `created_at` (`added_at`, §1.1), `opened_at` (§3.2 of
REQ-040.md, unchanged), and the two identity/attribution FKs (`user_id`, `added_by`) plus
the optional business-card snapshot (§1.3) needed to render an entry before any
`profiles` row exists. No engagement/activity signal, no `invited`/`opened`/`registered`/
`attended` status column — `invited` remains the row's own existence, exactly as
REQ-040.md §3.1/§4.2 already states.

---

## 7. Migration — what BACKEND-DEV does

1. Add the `inviteListEntries` table definition (§1's reference shape) to
   `apps/bot/src/db/schema.ts`, in the file's existing section-comment style (a short
   header block naming REQ-040, mirroring every prior section).
2. Run `drizzle-kit generate` — expected to produce `apps/bot/drizzle/0008_*.sql`,
   additive only (`CREATE TABLE invite_list_entries (...)`, plus the
   `uq_invite_list_entries_event_user` unique index and the four `FOREIGN KEY`
   constraints). No `ALTER` of any existing table.
3. This migration is **fully reversible** — a plain `DROP TABLE invite_list_entries`
   undoes it with zero data loss elsewhere, since no other table's column, constraint,
   or data is touched by creating it.
4. No handler, domain function, or migration content beyond the table itself is this
   artefact's concern — REQ-040.md §1/§2/§4 (BACKEND-DEV's Step 2) own everything that
   reads or writes rows in it.

---

## 8. Acceptance criteria this artefact closes (from REQ-040.md's own AC list)

| AC | How this artefact closes it |
|---|---|
| 1, 2 | §1's column shape (`user_id NOT NULL`, no constraint blocking two different placeholder `users` rows from each getting their own entry — REQ-010's proven multi-`NULL` `tg_id` property is on `users`, untouched here). |
| 5 | §6 — no stored `registered`/`attended` field; `opened_at` justified in REQ-040.md §3.2, unchanged, restated §6. |
| 6, 7 | §4's full relink trace, including the uniqueness-conflict sub-case REQ-040.md itself did not walk through. |
| 11 | §3.1 — hard `DELETE` is confirmed compatible with "exactly one `audit_log` row" because `audit_log.entity_id` carries no FK to break. |

---

## 9. Open questions (not resolved by invention)

1. **§1.3's data-design concurrence with REQ-040.md §3.4** is offered as support, not a
   second vote that overrides SECURITY-REVIEWER's own sign-off — REQ-040.md §8 open
   question 1 remains open, routed to Step 2c exactly as CODE-DESIGNER left it.
2. **§4.3's audit-row-count reading** ("one row per entry A held, whether the outcome is
   an `UPDATE` or a `DELETE`") is this artefact's own extension of REQ-040.md §2.4 point
   4's literal text ("one additional AuditLog row... per repointed entry") to the
   conflict sub-case REQ-040.md did not itself enumerate. It is offered as the reading
   most consistent with §2.4's own stated principle, not as a re-opening of that
   decision — flagged for CODE-DESIGN-VALIDATOR/SECURITY-REVIEWER to confirm rather than
   silently accepted as beyond question.
3. **§5's anonymization question** (whether a permanently-retired, entry-less placeholder
   `users` row should be in scope for a future S13 routine) is explicitly left open,
   extending the same open posture `REQ-031-schema.md`/`REQ-032-schema.md` already carry
   for other tables — no such routine exists yet to decide it against.
