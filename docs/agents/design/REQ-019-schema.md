# REQ-019 — Schema addendum: nullable required `profiles` columns + per-optional-field skip markers

**Role:** DATA-DESIGNER (design only — no implementation code, no migration SQL/TS;
BACKEND-DEV writes both per `.claude/agents/data-designer.md`).

**Scope:** exactly one existing table, `profiles` (created by REQ-010's migration). Two
changes, both flagged as a schema gap by `docs/agents/design/REQ-019.md` §1 (CODE-DESIGNER,
not committed there — that artefact explicitly defers the concrete shape to this one):

1. Relax `NOT NULL` on six columns so a `profiles` row is insertable and updatable one
   required field at a time.
2. Add a durable "explicitly skipped" marker for each of the five optional columns, so
   `NULL` can mean two different things without collapsing them.

No other table is touched. No new table is introduced.

Builds on `docs/agents/design/REQ-010.md` (`profiles` table, `profiles_user_id_unique`)
and reads `docs/agents/design/REQ-019.md` in full — this artefact's job is to make
§2.2's `determineNextProfileField` (its exact three-step derivation table) a function of
columns that actually exist with the nullability it assumes.

---

## 1. Why both changes are needed — restating the gap precisely

`determineNextProfileField` (REQ-019.md §2.2) reads a `ProfileRecord` and returns the
next unanswered field by:

- **Step 1:** the first `REQUIRED_PROFILE_FIELDS` entry, in fixed order, that is
  `null`/`undefined` on the row (or the row itself does not exist yet).
- **Step 2:** once all six required fields are non-null, the first
  `OPTIONAL_PROFILE_FIELDS` entry that is BOTH null AND not marked skipped.
- **Step 3:** complete once every optional field is non-null or skipped.

Two things must be true in the database for this to be well-defined:

- A row with some required columns set and others still `NULL` must be a legal,
  insertable, updatable state (today it is not — five of the six required columns
  carry `NOT NULL`).
- "Null and not skipped" must be distinguishable from "null and skipped" for every
  optional column (today it is not — both currently read back as plain `NULL`).

---

## 2. Change 1 — relax `NOT NULL` on the six required columns

| Column | Nullable today | Nullable after this change |
|---|---|---|
| `first_name` | No | **Yes** |
| `last_name` | No | **Yes** |
| `company` | No | **Yes** |
| `position` | No | **Yes** |
| `is_student` | No | **Yes** |
| `experience_level` | No | **Yes** |

**All six, including `first_name` — accepting REQ-019.md §1's recommendation.**
`first_name` is always asked first (REQ-019.md §2.1's fixed order is not this
artefact's call to change), so no acceptance criterion strictly forces relaxing it: the
only row ever inserted mid-form already carries `first_name`. But keeping it `NOT NULL`
while relaxing the other five would make `isProfileComplete`/step 1 of
`determineNextProfileField` read as two different rules — "check five columns for
`NULL`, plus rely on a sixth column's constraint to make row-existence itself imply a
value" — instead of one uniform "all six required columns are non-null" check. That
split is exactly the kind of implicit, easy-to-miss coupling between a column's
existence and a business rule that this role's "no invalid state is representable, but
also no state is bound to a mechanism no requirement asked for" balance argues against.
Relaxing all six uniformly costs nothing today (in practice `first_name` is still always
set before any other required field, per the fixed order) and removes a rule that would
otherwise depend on `NOT NULL` doing double duty. Accepted.

**Why this is safe against REQ-010's original intent.** REQ-010 chose `NOT NULL` on
these six because a `Profile` row was, at the time, only ever created in one shot with
all required fields known — "no invalid state is representable" was free. REQ-019's own
partial-write rule (PRD FR-3, "each answer written to the Profile row AS IT ARRIVES")
changes what states are actually reachable in practice: a row with only `first_name` set
is now a normal, expected, mid-form state, not a bug. The constraint that used to prevent
an accidental defect now prevents a state the product requires. Relaxing it is not
"loosening validation for convenience" — it is correcting a constraint that was written
before the requirement that contradicts it existed.

**What still enforces completeness, now that the DB no longer does.**
`isProfileComplete`/step 3 of `determineNextProfileField` (REQ-019.md §2.2/§2.3) is the
sole authority on "is this profile done" once these columns are nullable — this is an
application-level invariant from this point on, not a database one. No CHECK constraint
is added to re-impose "eventually all six must be set," because:

- Nothing in REQ-019's acceptance criteria requires the database to reject an
  in-progress row — AC1 requires the opposite (a mid-form row must be a legal, resumable
  state), and there is no acceptance criterion asking for a database-level guarantee that
  a profile is eventually completed (completion is read, not enforced, by
  `isProfileComplete`).
- Any such CHECK could only be a "some column is non-null" disjunction, which cannot
  express "eventually completed" (a CHECK is evaluated per-row, per-statement, with no
  concept of "later") — the actual property REQ-019 needs ("resumable to completion") is
  a property of the read/write flow, not of one row's snapshot at write time.

This is stated explicitly per this role's own convention (REQ-014-schema.md §1 relaxing
`chapters.active`'s counterfactual to `NOT NULL`+default rather than nullable, reasoned
from acceptance criteria) rather than left for a reader to wonder whether a completeness
constraint was simply forgotten.

**Downstream readers of `profiles` that assumed these six were always non-null.**
Checked against every other requirement's design that reads `profiles`:

- REQ-019.md §2.5 `formatProfileDump` — already designed to print a "not set" placeholder
  for a null optional field; the required-field columns being nullable mid-form is
  consistent with the same design, since `formatProfileDump` is only ever called on a
  row `advanceOnboarding` has already confirmed is `"ready"` (REQ-019.md §4.1 step 6),
  i.e. all six required columns are non-null by the time it runs. No change needed there.
- No other requirement's design (REQ-014, REQ-016, REQ-017, REQ-018) reads any
  `profiles` column directly — confirmed by grep of `docs/agents/design/*.md` for
  `profiles.` / `Profile` outside REQ-010/REQ-019's own artefacts. Nothing else in-flight
  is blocked by this relaxation.

---

## 3. Change 2 — durable "explicitly skipped" marker for the five optional columns

**Decision: five booleans, one per optional column — `phone_skipped`, `email_skipped`,
`links_github_skipped`, `links_linkedin_skipped`, `links_site_skipped` — NOT a combined
JSONB/array/enum-set column.**

| Column | Type | Nullable | Default |
|---|---|---|---|
| `phone_skipped` | boolean | No | `false` |
| `email_skipped` | boolean | No | `false` |
| `links_github_skipped` | boolean | No | `false` |
| `links_linkedin_skipped` | boolean | No | `false` |
| `links_site_skipped` | boolean | No | `false` |

### 3.1 Reasoning — five booleans vs. a combined column

Two shapes were on the table (REQ-019.md §1 explicitly declined to choose):

**Option A — five booleans (chosen).**

- **The set of optional fields is fixed and closed at exactly five, named by this
  requirement's own text** (phone, email, GitHub, LinkedIn, site) — REQ-019.md §2.1's
  `OPTIONAL_PROFILE_FIELDS` is a compile-time constant, not a variable-length or
  organizer-configurable set. A combined array/JSONB column earns its complexity when the
  member set is open-ended or grows without a schema change (the way `events.agenda`
  earns JSONB in REQ-011, because agenda items are a variable-length, organizer-authored
  sequence). Here the set is fixed, so a JSONB/array column buys generality nothing in
  this requirement or any depends_on requirement asks for.
- **Matches this schema's own established convention for a per-row fact of this shape.**
  Every other multi-valued-but-fixed-cardinality fact in `profiles`/`users` is modeled as
  one plain boolean column per fact, never as a combined set: `is_student`,
  `publish_consent` (`profiles`), `blocked`, `broadcast_opt_in` (`users`). No table in
  this schema currently holds a JSONB/text-array column for a small, closed set of named
  boolean flags — `events.agenda` (REQ-011) is JSONB precisely because it is NOT a fixed,
  named set (it is a variable list of typed items), which is the opposite of this case.
  Introducing the schema's first "array of flag names" column for a case the plain-column
  convention already covers would be a new pattern with no requirement forcing it.
- **Directly queryable and directly readable by the platform this schema must eventually
  export to** (`.claude/agents/data-designer.md` — "Exportable and absorbable"). A plain
  boolean column translates to any relational store or spreadsheet-shaped export with
  zero interpretation. A JSONB array of skipped-field names requires whichever system
  absorbs this schema to parse and validate a JSON payload against this project's own
  fixed field-name vocabulary — an extra decoding step with no compensating benefit given
  the fixed cardinality.
- **Simpler Drizzle/TypeScript shape**, matching `ProfileRecord`'s own field list
  (REQ-019.md §2.2) one column per property, with no serialization/deserialization step
  and no risk of an unrecognized string ending up inside the array (a typo like
  `"linksGitub"` in a JSONB array is a silent no-op; a mistyped boolean column name is a
  compile error).
- **Cost, stated honestly:** five columns instead of one. At this schema's actual scale
  (~1,000 users, one row per user) this is negligible storage and no meaningful query
  cost difference; the "five columns is more schema surface" objection is the only one
  that favors Option B, and it does not outweigh the points above.

**Option B — one combined column (declined).** A single `text[]` or `jsonb` column
holding the names of skipped optional fields (e.g. `["phone", "linksGithub"]`). Declined
because it trades a fixed, closed, five-member set for a schema shape suited to variable
or growing sets, gains nothing this requirement needs, costs an extra
serialize/parse step at every read and write site (§2.4's `writeOptionalProfileField`/
`markOptionalProfileFieldSkipped`, REQ-019.md), and departs from this schema's own
established convention for exactly this kind of fact (named boolean flags, one column
each) without a stated reason to depart.

### 3.2 Nullability and default — `NOT NULL DEFAULT false`, not nullable

**Not nullable, default `false`.** These are the same reasoning REQ-014-schema.md §1
applied to `chapters.active`: a two-valued fact ("was this field explicitly skipped or
not") must not admit a third, unspecified `NULL` state that
`determineNextProfileField`'s step 2 check ("its matching `<field>Skipped` flag is
`false`", REQ-019.md §2.2) would have to special-case for no benefit. Every `profiles`
row — including the very first one ever inserted, holding only `first_name` — has a
determinate answer to "was phone explicitly skipped" (no, not yet, because the form has
not reached it), which is exactly what `DEFAULT false` gives it for free on insert with
no extra write. This also means `writeRequiredProfileField`'s very first upsert
(REQ-019.md §2.4, the `INSERT ... ON CONFLICT` that creates the row from a bare
`firstName` answer) needs no explicit value for any of these five columns — Postgres
supplies `false` for all five as part of the same `INSERT`, identically to how
`chapters.active DEFAULT true` backfilled every existing row for REQ-014.

### 3.3 Column naming — `<field>_skipped`, matching REQ-019.md's own recommendation

Names: `phone_skipped`, `email_skipped`, `links_github_skipped`, `links_linkedin_skipped`,
`links_site_skipped` — the existing column name plus a `_skipped` suffix, mirroring the
existing `links_github`/`links_linkedin`/`links_site` naming for the corresponding value
columns. No new word is introduced for the concept ("skipped" is the exact word REQ-019's
own text and acceptance criteria use — AC2, "skipping every optional field"); this keeps
PRD 5's one-word-per-concept rule intact rather than introducing a synonym like
`_declined`, `_omitted`, or `_not_provided`.

### 3.4 The "answered after having skipped" transition — no new state, an existing rule

REQ-019.md §2.4's `writeOptionalProfileField` already states the rule this schema must
support: writing a real value to an optional field also clears that field's skip flag
back to `false` in the same statement — "there is no 'answered AND skipped' state." This
artefact confirms the column shape supports that directly: `<field>_skipped` is a plain
mutable boolean with no history/audit requirement attached (nothing in REQ-019's scope
asks whether a field was *ever* skipped, only whether it is *currently* considered
skipped), so a single `UPDATE ... SET <value column> = $v, <field>_skipped = false` is
sufficient — no additional column or constraint is needed to make un-skipping
representable.

**No `CHECK` constraint enforcing "value column and skip flag are never both truthy at
once"** (i.e. forbidding a value column being non-null while its skip flag is `true`).
Two reasons this is not proposed:

- Nothing in REQ-019's acceptance criteria depends on the database rejecting that
  combination — the write-path discipline (§2.4's "answering un-skips") is what keeps it
  from occurring in practice, and enforcing it again at the DB layer adds machinery no
  acceptance criterion asks for (the exact overreach REQ-016-schema.md §6 already
  declined for a comparable case).
  Reserved as an open question below in case DATA-DESIGNER's own overreach concern is
  read differently by SECURITY-REVIEWER or CODE-DESIGN-VALIDATOR.
- Postgres treats `... SET a = x, b = false` as a single atomic statement — there is
  no window in which the un-skip write path itself passes through an invalid combined
  state.

---

## 4. Full column-change summary

| Column | Before | After |
|---|---|---|
| `first_name` | `text NOT NULL` | `text` (nullable) |
| `last_name` | `text NOT NULL` | `text` (nullable) |
| `company` | `text NOT NULL` | `text` (nullable) |
| `position` | `text NOT NULL` | `text` (nullable) |
| `is_student` | `boolean NOT NULL` | `boolean` (nullable) |
| `experience_level` | `text NOT NULL` | `text` (nullable) |
| `phone_skipped` | *(does not exist)* | `boolean NOT NULL DEFAULT false` (new) |
| `email_skipped` | *(does not exist)* | `boolean NOT NULL DEFAULT false` (new) |
| `links_github_skipped` | *(does not exist)* | `boolean NOT NULL DEFAULT false` (new) |
| `links_linkedin_skipped` | *(does not exist)* | `boolean NOT NULL DEFAULT false` (new) |
| `links_site_skipped` | *(does not exist)* | `boolean NOT NULL DEFAULT false` (new) |

No column is dropped or renamed. No other `profiles` column (`phone`, `email`,
`links_github`, `links_linkedin`, `links_site`, `public_bio`, `photo_file_id`,
`publish_consent`, `created_at`, `updated_at`, `user_id`, `id`) is touched.
`profiles_user_id_unique` (the uniqueness constraint REQ-019.md §2.4's upsert relies on
as its conflict target) is unchanged.

---

## 5. The migration (prose, not SQL — Drizzle-generated per `decisions/0005`)

Per `decisions/0005-orm-drizzle.md`: this migration is **generated by `drizzle-kit
generate`** against an updated `apps/bot/src/db/schema.ts` (six columns' `.notNull()`
calls removed on the `profiles` table definition, five new
`boolean("<name>").notNull().default(false)` columns added), never hand-written, and
committed as the plain `.sql` file that step produces under `apps/bot/`.

Expected statement shape (for BACKEND-DEV and REVIEWER to confirm the generated file
matches — this artefact does not write the SQL itself):

- `ALTER TABLE profiles ALTER COLUMN first_name DROP NOT NULL;`
- `ALTER TABLE profiles ALTER COLUMN last_name DROP NOT NULL;`
- `ALTER TABLE profiles ALTER COLUMN company DROP NOT NULL;`
- `ALTER TABLE profiles ALTER COLUMN position DROP NOT NULL;`
- `ALTER TABLE profiles ALTER COLUMN is_student DROP NOT NULL;`
- `ALTER TABLE profiles ALTER COLUMN experience_level DROP NOT NULL;`
- `ALTER TABLE profiles ADD COLUMN phone_skipped boolean NOT NULL DEFAULT false;`
- `ALTER TABLE profiles ADD COLUMN email_skipped boolean NOT NULL DEFAULT false;`
- `ALTER TABLE profiles ADD COLUMN links_github_skipped boolean NOT NULL DEFAULT false;`
- `ALTER TABLE profiles ADD COLUMN links_linkedin_skipped boolean NOT NULL DEFAULT false;`
- `ALTER TABLE profiles ADD COLUMN links_site_skipped boolean NOT NULL DEFAULT false;`

No other statement should appear (no rename, no type change, no other table touched). If
`drizzle-kit generate` proposes anything beyond these eleven statements, that is a signal
the working schema file has drifted from REQ-010/this artefact's committed shape and
should be reconciled before accepting the generated migration — the same caution
REQ-014-schema.md §2 states for its own single-column case.

**Backfill.** The `DROP NOT NULL` statements need no backfill (relaxing a constraint
never requires touching existing data — every existing row already satisfies "may be
null" trivially by already being non-null). The `ADD COLUMN ... DEFAULT false` statements
are backfilled by Postgres as part of the same `ALTER TABLE`, exactly as REQ-014-schema.md
§2 describes for `chapters.active DEFAULT true` — no separate `UPDATE` pass, no
application-level backfill script. Every existing `profiles` row (necessarily already
fully completed, since REQ-019 is the first requirement to make a partial row possible)
ends up with all five new flags `false`, which is the correct reading for a row where
every optional field already holds whatever value or `NULL` it held before this
migration — none of them were "explicitly skipped via this new mechanism," which did not
exist yet.

### 5.1 Reversibility

The down-migration is:

- `ALTER TABLE profiles ALTER COLUMN first_name SET NOT NULL;` (and the same for the
  other five required columns)
- `ALTER TABLE profiles DROP COLUMN phone_skipped;` (and the same for the other four
  skip columns)

**Not unconditionally reversible once real partial rows exist.** Re-adding `NOT NULL` to
any of the six required columns fails outright if any row in the table still has that
column `NULL` at rollback time (a genuinely in-progress signup) — this is the same
"reversible in principle, not reversible in practice once real data exists" caveat
REQ-014-schema.md §11 already applied to `consent_pd_at`/`consent_pd_version`, restated
here for the required-column relaxation specifically. Dropping the five `*_skipped`
columns is unconditionally reversible (a plain `DROP COLUMN` on an additive boolean with
default, same shape as REQ-016-schema.md §4's `pending_source` reversal) but is a lossy
reversal in the ordinary sense that any row that recorded a real skip loses that record —
acceptable for the same reason REQ-016-schema.md §4 accepted losing `pending_source`: it
is degrading a resumability aid back to its pre-existing (non-existent) state, not
corrupting a business record no other column captures.

---

## 6. S11 / S13 relevance

**S11 (PII never appears in plaintext logs, scoped to phone/email):** this change adds no
new column that stores phone or email content — the five new columns are booleans with no
PII content whatsoever (a flag saying "this optional field was skipped" carries no value
from the field itself). The six relaxed columns already existed and already held
whatever PII/non-PII content they held before (`phone`/`email` themselves are untouched —
this change never widens or narrows their nullability, which was already `Yes`). No new
S11 exposure.

**S13 (deletion anonymizes and preserves aggregates):** none of the eleven changed columns
is attendance history or an aggregate. The six required-field relaxations are the same
already-covered PII fields REQ-010 already subjected to S13's anonymization routine
(whatever that routine blanks today for `first_name`/`last_name`/`company`/`position`/
`experience_level` continues to apply unchanged — relaxing `NOT NULL` does not change what
anonymization must do, only what value is legal to hold before anonymization runs). The
five new `*_skipped` booleans should be included in whatever field list a future
anonymization routine resets (to `false`, the same "as if never asked" state a
newly-created row starts in) for consistency, but their presence or absence in that reset
has no bearing on S13's actual guarantee (a skip flag reveals nothing about identity or
attendance).

**Does relaxing `NOT NULL` on a personal-data column trigger S13 sign-off?** No — S13 (and
`decisions/0005`'s consequence section) gates a migration that **drops or rewrites**
personal-data content. `DROP NOT NULL` is the opposite of a destructive operation: it
strictly widens what a column may hold (adds `NULL` as a newly-legal value) and rewrites
no existing row's stored content — every existing row keeps its exact current value.
Flagged explicitly here, rather than left for SECURITY-REVIEWER to have to independently
conclude, since these are the first `NOT NULL` relaxations on already-PII columns this
schema has made and the reasoning is worth stating once for future reference: "widen
nullability" and "drop/rewrite a column" are different operations under S13/`decisions/0005`,
and only the latter is gated.

---

## 7. Confirmation: no conflict with other in-flight schema assumptions

- **REQ-020/021/022** (not yet designed, per REQ-019.md's own dependency note) will read
  `registrations` and, per REQ-019.md §2.3's `isProfileComplete`, will need to check
  profile completeness as a registration precondition. That check reads exactly the same
  six required columns this artefact relaxes, through `isProfileComplete`/
  `determineNextProfileField` — a pure function over `ProfileRecord`, never a raw
  `NOT NULL` assumption baked into a query. No future requirement is blocked by these
  columns becoming nullable, since REQ-019.md already designed the completeness check as
  an application-level read rather than relying on the database to guarantee it.
- **`profiles_user_id_unique`** (REQ-010) — unchanged, still the correct conflict target
  for REQ-019.md §2.4's per-field upsert.
- **No other requirement's design artefact references `profiles.first_name`,
  `.last_name`, `.company`, `.position`, `.is_student`, or `.experience_level`'s
  nullability directly** (confirmed by inspection of REQ-014/016/017/018's design docs,
  §2 above) — nothing else in the pipeline assumes these columns are `NOT NULL`.

---

## 8. Drizzle schema shape (pseudocode — not implementation)

Illustrating the changes to the existing `profiles` table definition in
`apps/bot/src/db/schema.ts`; not valid TypeScript/Drizzle syntax, for BACKEND-DEV to
translate:

```
table profiles:                                         -- unchanged columns omitted
  id                     uuid          PK default random
  user_id                uuid          NOT NULL  FK -> users.id (restrict)
  first_name             text          NULL      -- was NOT NULL; CHANGED
  last_name              text          NULL      -- was NOT NULL; CHANGED
  phone                  text          NULL      -- unchanged
  email                  text          NULL      -- unchanged
  company                text          NULL      -- was NOT NULL; CHANGED
  position               text          NULL      -- was NOT NULL; CHANGED
  is_student             boolean       NULL      -- was NOT NULL; CHANGED
  experience_level       text          NULL      -- was NOT NULL; CHANGED
  links_github           text          NULL      -- unchanged
  links_linkedin         text          NULL      -- unchanged
  links_site             text          NULL      -- unchanged
  phone_skipped          boolean       NOT NULL DEFAULT false   -- NEW
  email_skipped          boolean       NOT NULL DEFAULT false   -- NEW
  links_github_skipped   boolean       NOT NULL DEFAULT false   -- NEW
  links_linkedin_skipped boolean       NOT NULL DEFAULT false   -- NEW
  links_site_skipped     boolean       NOT NULL DEFAULT false   -- NEW
  public_bio             text          NULL      -- unchanged
  photo_file_id          text          NULL      -- unchanged
  publish_consent        boolean       NOT NULL DEFAULT false   -- unchanged
  created_at             timestamptz   NOT NULL DEFAULT now()   -- unchanged
  updated_at             timestamptz   NOT NULL DEFAULT now()   -- unchanged
  UNIQUE (user_id)  -- profiles_user_id_unique, unchanged
```

---

## 9. Acceptance criteria → schema element map

| AC | Schema element satisfying it |
|---|---|
| AC1 — restart mid-form (first 3 required fields answered) resumes at the 4th, first 3 already stored | §2's `NOT NULL` relaxation on the six required columns is what makes the intermediate row (`first_name`/`last_name`/`company` set, `position`/`is_student`/`experience_level` still `NULL`) a legal, insertable, persisted state at all — without it, REQ-019.md §2.4's per-answer upsert would fail on the very first insert once a second required answer diverges from "all six known." |
| AC2 — skipping every optional field still completes the profile | §3's five `*_skipped` booleans are the durable record that a skip happened, distinct from "not yet reached" — the exact distinction REQ-019.md §2.2 step 2/step 3 needs to read "every optional field is either non-null or marked skipped" as `true` after every optional field was skipped, and to resume correctly (not re-ask an already-skipped field) after a restart mid-optional-segment. |
| AC3 — declining consent leaves zero `profiles` rows | Unaffected by this artefact — REQ-019.md §3.2 step 1 never reads or writes `profiles` while consent is unset, by construction; no schema element is needed for this AC beyond `profiles` continuing to require a `user_id` FK (unchanged, REQ-010). |
| AC4 — an already-complete profile is asked no profile question on a second pass | `isProfileComplete` (REQ-019.md §2.3) reads the same six required columns and five skip flags this artefact defines; §4's summary table confirms no column this artefact changes affects the completeness check's logic, only which raw states are legally storable en route to it. |
| AC5 — phone+email entered, an error path produces no PII in logs | Unaffected by this artefact (§6) — neither of the eleven changed columns stores a new PII value; `phone`/`email` themselves are untouched. |
| AC6 — email accepted when absent, format-validated only when supplied | Unaffected by this artefact — `email`'s own nullability was already `Yes` before this change and remains so; `email_skipped` (§3) is what lets "absent because skipped" be told apart from "absent, not yet reached" for AC6's own resumability, though AC6's format-validation behavior itself lives entirely in REQ-019.md §2.3's `isValidEmailFormat`, not in any column this artefact adds. |

---

## 10. Open questions (not resolved by invention)

1. **Should a `CHECK` constraint forbid a value column being non-null while its matching
   skip flag is `true`?** §3.4 declines to add one, reasoning that REQ-019.md's own
   write-path discipline (answering un-skips, in the same statement) already prevents the
   combination from occurring, and that adding DB-level enforcement of a state the
   application already guarantees is unrequested machinery — the same class of restraint
   REQ-016-schema.md §6 already exercised for the doors-cardinality rule. Flagged in case
   SECURITY-REVIEWER or CODE-DESIGN-VALIDATOR judges the combined state severe enough
   (e.g. a future bug writing a value without clearing the flag, silently reintroducing an
   already-answered field as "still needs asking") to warrant a belt-and-suspenders
   constraint despite the added complexity — not decided here.
2. **`first_name`'s relaxation is a recommendation this artefact accepted, not one forced
   by an acceptance criterion.** Stated in §2 for the record: if a future review prefers
   to keep `first_name NOT NULL` (on the reasoning that it is, in practice, never null in
   a persisted row), that is a legitimate alternative this artefact considered and
   rejected for uniformity reasons, not because the alternative is unworkable.
3. **Whether `profiles` rows for organizer-pre-created people (a `User` row with no
   `tg_id` yet, per REQ-010's stable-id rule) can or should ever be pre-populated with a
   partial profile before the person's first `/start`.** Nothing in REQ-019's text raises
   this, and this artefact's relaxation does not foreclose it (a `profiles` row keyed by
   `user_id` could in principle be created for such a person by a future organizer-facing
   flow), but no such flow is designed here — flagged only because it is now schema-legal
   in a way it previously was not (a row need no longer wait for all six required answers
   to exist), not because this requirement asks for it.
