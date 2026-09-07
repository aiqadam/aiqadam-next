# REQ-031 — Schema addendum: a new `feedback` table + `users.broadcast_opt_in_asked_at`

**Role:** DATA-DESIGNER (design only — no implementation code, no migration SQL/TS;
BACKEND-DEV runs `drizzle-kit generate` and writes both, per `.claude/agents/data-designer.md`
and `decisions/0005-orm-drizzle.md`).

**Scope:** one new table (`feedback`) and one new nullable column on the existing `users`
table. No other table is touched, per `docs/agents/design/REQ-031.md` §0's own scoping —
this artefact resolves exactly the two shapes that document deferred (§0.1's skip-marker
shape and topic-votes type; §0.3's `broadcast_opt_in_asked_at` addition, already named
precisely enough there that no further open question remains on it).

Builds on `apps/bot/src/db/schema.ts`'s current `registrations` and `users` tables and
reads `docs/agents/design/REQ-031.md` in full — this artefact's job is to make §2.2's
`determineNextFeedbackField` and §2.7's `determineFeedbackFlowStep` functions of columns
that actually exist with the nullability and constraint shape they assume.

---

## 1. New table: `feedback`

| Column | Type | Nullable | Default | Constraint |
|---|---|---|---|---|
| `id` | `uuid` | No | `gen_random_uuid()` | PK |
| `registration_id` | `uuid` | No | — | `UNIQUE`, FK → `registrations.id` |
| `nps` | `integer` | No | — | `CHECK (nps >= 0 AND nps <= 10)` |
| `liked` | `text` | Yes | `NULL` | — |
| `improve` | `text` | Yes | `NULL` | — |
| `topic_votes` | `text[]` | Yes | `NULL` | — |
| `liked_skipped` | `boolean` | No | `false` | — |
| `improve_skipped` | `boolean` | No | `false` | — |
| `topic_votes_skipped` | `boolean` | No | `false` | — |
| `created_at` | `timestamptz` | No | `now()` | — |
| `updated_at` | `timestamptz` | No | `now()` | — |

### 1.1 `registration_id` — the AC2 mechanism, stated exactly

`uuid NOT NULL`, FK to `registrations.id`, with a **`UNIQUE` index** (`uniqueIndex` in
Drizzle, matching this schema's own existing convention — e.g. `profiles_user_id_unique`,
`uq_notification_ledger_registration_kind`), rather than a `UNIQUE` column-level
constraint spelled differently. Both compile to the identical Postgres object (a unique
btree index backing a uniqueness guarantee); the distinction has no behavioral
consequence, so this artefact follows the schema's own established spelling rather than
introduce a second one.

`ON DELETE restrict` (this schema's universal FK convention — every existing FK in
`schema.ts` uses `restrict`, none uses `cascade` or `set null`; §4 below states explicitly
why `feedback` does not need a different rule).

**This single column is the entire mechanism behind AC2** — "attempting a second feedback
row for the same registration FAILS ON A DATABASE CONSTRAINT, verified by attempting the
duplicate insert directly." AC2's own verification method is a raw duplicate `INSERT`
that bypasses `writeFeedbackNps`'s `ON CONFLICT` upsert (REQ-031.md §2.3) entirely — the
uniqueness must therefore hold as a database object a raw `INSERT` collides with, not as
an invariant only the application's own write path happens to preserve. A `UNIQUE` index
on `registration_id` is exactly that: any second `INSERT` naming a `registration_id`
already present in the table raises `23505 unique_violation` regardless of which code
path (or none) issued it.

**No FK/constraint on this table requires anything to exist before the first insert
beyond the `registrations` row itself** — confirmed directly: `registration_id`'s FK
target is `registrations.id`, a row that already exists by construction before any
feedback flow can start (REQ-031.md §5.2/§5.3 only ever select already-`admitted`,
already-checked-in registrations). No other table references `feedback`, and `feedback`
itself references nothing but `registrations`. The row is inserted on the NPS answer only
(REQ-031.md §1.3) — nothing in this table's constraint shape forces an earlier insert or
a placeholder row of any kind.

### 1.2 `nps` — `NOT NULL`, the property that makes "skipping NPS saves nothing" a schema fact

`integer NOT NULL`. `NOT NULL` here is not merely "NPS is required" — it is what makes
"skipping NPS does not save a feedback row" true **at the schema level**, per REQ-031.md
§0.1: since `nps` cannot be absent from a `feedback` row, and `writeFeedbackNps` (§2.3) is
the only function that ever inserts one, there is no way for a row to exist without an
NPS value — "no row" and "no NPS answer" become the same fact, with nothing else needed to
keep them in sync.

**`CHECK (nps >= 0 AND nps <= 10)`, adopted as recommended.** Mirrors this schema's
existing `chk_*` convention (`chk_registrations_checked_in_only_if_admitted`) — a cheap,
belt-and-suspenders guard against a value outside the PRD's stated 0–10 range ever
reaching storage, defensive against any future write path that does not route through
`isValidNpsValue` (REQ-031.md §2.3), including the very raw duplicate `INSERT` AC2's own
verification method performs (that `INSERT` will supply a valid `nps` to test the
`registration_id` collision, but the `CHECK` costs nothing to have in place regardless and
closes the same class of gap `chk_registrations_checked_in_only_if_admitted` closes for
S6). Named `chk_feedback_nps_range`.

### 1.3 `liked` / `improve` — nullable text, no format rule

`text`, nullable, no default. Free-form "what worked" / "what to improve" answers — no
acceptance criterion imposes a length or format constraint, so none is added, matching
this schema's existing free-text columns (`profiles.public_bio`, `events.description`).

### 1.4 `topic_votes` — `text[]`, not `jsonb`

**Decision: `text[]` (a native Postgres array column), not `jsonb`.**

REQ-031.md §0.2 states the question as genuinely open and names both options. Resolving
it:

- **The stored shape is already exactly "an array of strings" and nothing more** —
  `parseTopicVotes` (REQ-031.md §3.4) produces `string[]` (freeform typed topics, split on
  newlines/commas, trimmed, no per-item metadata, no nesting), and `FeedbackRecord.
  topicVotes` (§2.2) is typed `string[] | null`. `text[]` is Postgres's native
  representation of exactly this value with no wrapper object and no key to name — a
  `jsonb` column here would hold nothing but a bare JSON array (`["topic a", "topic b"]`),
  which is `text[]` plus an unneeded serialization layer.
- **No heterogeneity or future per-item metadata is named by this requirement.**
  `events.agenda` (REQ-011) earns `jsonb` because its elements are typed objects (`{
  kind, at, label }`) with more than one field each and a shape that has already grown
  once (REQ-016's channel/source additions did not touch it, but the type comment records
  it as a structured item, not a bare string). `audit_log.payload` (REQ-011) earns `jsonb`
  because it is genuinely polymorphic — an arbitrary diff shape that differs by
  `action`/`entity`. `topic_votes` has neither property: PRD FR-8 names "topic votes" as a
  list of topic strings, full stop, and REQ-031.md §0.2 itself confirms no taxonomy or
  per-vote metadata exists anywhere in scope. Choosing `jsonb` here to match those two
  precedents would be matching their *type*, not the *reason* they hold that type.
  This schema's own precedent for "reach for `jsonb` when the shape is a variable-length
  sequence of typed objects, and a plain column type when it is not" is `events.agenda`
  vs. every scalar column beside it — `text[]` is the correct continuation of that
  precedent for a plain sequence of scalars, not a departure from it.
- **Directly exportable/absorbable** (`.claude/agents/data-designer.md`'s own rule): a
  Postgres `text[]` round-trips through `pg_dump`/`COPY`/most BI and spreadsheet tooling as
  a delimited list with no JSON-decoding step; a future platform absorbing this schema
  reads it as "a list of strings" without first having to know it should expect a JSON
  array specifically (as opposed to, say, an object) inside the `jsonb` column.
- **Directly queryable with native array operators** if a later requirement ever needs to
  count votes per topic (`unnest(topic_votes)` + `GROUP BY`) — no `jsonb_array_elements`
  indirection needed. Nothing in REQ-031's own scope needs this today, but it costs
  nothing to have the simpler operator available should REQ-031.md §10 open question 2's
  "tie topics to a real taxonomy" ever get picked up.
- **Cost, stated honestly:** this is the first native array column in this schema (every
  existing multi-valued column is either `jsonb` or a separate table). That is a real,
  if small, increase in "distinct column-shape vocabulary" a reader of `schema.ts` must
  hold. Weighed against `jsonb`'s cost here (an unneeded serialize/parse step at every
  read/write site, and a JSON array that is *only* ever a flat array of strings gaining no
  actual flexibility from being wrapped in JSON), the array's directness wins for this
  specific, closed-shape value.

**Nullable, no default.** `NULL` means "not yet reached or not yet answered"; an empty
array (`{}`) is reserved for a genuinely different fact ("answered, with zero topics
listed" — not reachable by `parseTopicVotes`, which the design routes through the skip
path instead whenever the reply is blank per §3.4/§6.3 step 1's blank-text short-circuit,
but not schema-forbidden either). No `CHECK` constrains array length or element format —
nothing in REQ-031.md asks for one, and PRD FR-8 sets no cap on topic count.

### 1.5 Skip markers — three booleans, following the REQ-019 convention exactly

**Decision: three plain booleans — `liked_skipped`, `improve_skipped`,
`topic_votes_skipped` — `NOT NULL DEFAULT false`, not a combined structure.**

This is the identical shape and identical reasoning `REQ-019-schema.md` §3 already
established for `profiles`' five skip markers, generalized here to three columns on a
different table, for the same reasons, re-derived rather than merely cited:

- **The set of optional fields is fixed and closed at exactly three**, named directly by
  REQ-031.md §2.1's `FeedbackField` union (`"liked" | "improve" | "topicVotes"`) — not
  organizer-configurable, not variable-length. The same "a combined array/JSONB column
  earns its complexity only when the member set is open-ended" reasoning that favored five
  booleans over one array for `profiles` applies unchanged to three.
- **Matches this schema's own established convention.** Every fixed-cardinality boolean
  fact in this schema (`is_student`, `publish_consent`, `blocked`, `broadcast_opt_in`, and
  now REQ-019's own five `*_skipped` columns) is one column per fact. No table holds a
  combined flag-set column for a closed, named set — introducing one here for three flags
  when `profiles` already set the five-flag precedent on the exact same "skip a step of a
  DB-derived resumable form" mechanism would be an unforced departure, not a considered
  choice.
- **Exportable and absorbable** with zero decoding step, identical reasoning to REQ-019.
- **Matches `FeedbackRecord`'s own one-property-per-column shape** (REQ-031.md §2.2:
  `likedSkipped: boolean`, `improveSkipped: boolean`, `topicVotesSkipped: boolean`) with no
  serialize/deserialize step at `getFeedbackByRegistrationId`/`markFeedbackFieldSkipped`.
- **`NOT NULL DEFAULT false`, not nullable** — same two-valued-fact reasoning
  REQ-014-schema.md §1 applied to `chapters.active` and REQ-019-schema.md §3.2 applied to
  its own five columns: "was this field explicitly skipped" has a determinate answer (no,
  not yet) for every row from the moment it is created by `writeFeedbackNps`'s `INSERT`
  (REQ-031.md §2.3), which supplies no explicit value for any of the three — Postgres's
  `DEFAULT false` fills all three for free on that first insert, identically to how
  `profiles`' own five skip columns are defaulted on `writeRequiredProfileField`'s first
  upsert.

**Naming: `<field>_skipped`.** Matches `liked`/`improve`/`topic_votes`'s own column names
plus the exact `_skipped` suffix REQ-019 already established for this concept — no new
word introduced (`skipped` is the literal word REQ-031.md's own AC3 uses), keeping the
one-word-per-concept rule intact.

**No `CHECK` forbidding "value column non-null while its skip flag is true."** Same
declination REQ-019-schema.md §3.4 made for the identical shape, restated for this table:
`writeFeedbackOptionalField` (REQ-031.md §2.4) already clears the skip flag in the same
`UPDATE` that writes a real value ("there is no 'answered AND skipped' state" — the
identical sentence REQ-031.md §2.4 uses, verbatim from REQ-019's own precedent), so the
combined state never occurs via the design's own write path, and no acceptance criterion
asks the database to reject it independently. Flagged as an open question below for the
same reason REQ-019-schema.md flagged it, not silently declined.

### 1.6 `created_at` / `updated_at`

`timestamptz NOT NULL DEFAULT now()`, this schema's universal convention on every table.
Write-time facts, never read back into a decisions/0006-governed time-dependent predicate
— the same treatment `notification_ledger`'s identical pair already receives.

---

## 2. Full table definition (Drizzle pseudocode — not implementation)

```
table feedback:
  id                    uuid          PK default random
  registration_id       uuid          NOT NULL  FK -> registrations.id (restrict)
  nps                   integer       NOT NULL
  liked                 text          NULL
  improve               text          NULL
  topic_votes           text[]        NULL
  liked_skipped         boolean       NOT NULL DEFAULT false
  improve_skipped       boolean       NOT NULL DEFAULT false
  topic_votes_skipped   boolean       NOT NULL DEFAULT false
  created_at            timestamptz   NOT NULL DEFAULT now()
  updated_at            timestamptz   NOT NULL DEFAULT now()
  UNIQUE (registration_id)                                  -- uq_feedback_registration_id
  CHECK (nps >= 0 AND nps <= 10)                             -- chk_feedback_nps_range
```

`FeedbackRecord` (REQ-031.md §2.2) maps onto this 1:1, column for property, with
`registrationId`/`nps`/`liked`/`improve`/`topicVotes`/`likedSkipped`/`improveSkipped`/
`topicVotesSkipped` — no column exists that `FeedbackRecord` does not expose, and no
`FeedbackRecord` property lacks a backing column.

---

## 3. New column on `users`: `broadcast_opt_in_asked_at`

| Column | Type | Nullable | Default |
|---|---|---|---|
| `broadcast_opt_in_asked_at` | `timestamptz` | Yes | `NULL` |

**Resolves REQ-031.md §0.3 exactly as that document already specified** — this artefact
confirms the shape rather than re-deriving it, since §0.3 left nothing further open.

**Mirrors `consent_pd_at`/`consent_pd_version`'s existing pairing convention**
(`REQ-014-schema.md` §10, `users` table, `apps/bot/src/db/schema.ts` lines 72–79): a
nullable `timestamptz`, set together with a companion answer-bearing column
(`broadcast_opt_in`, already `boolean NOT NULL DEFAULT false`) by the same handler write,
never one without the other, with **no schema-level constraint enforcing the pairing** —
that discipline lives in the write path (`writeBroadcastOptInAnswer`, REQ-031.md §2.6),
exactly as `consent_pd_at`/`consent_pd_version`'s pairing is enforced by the consent
handler, not by a `CHECK`. Concretely, comparing to REQ-014-schema.md §10's own stated
reasoning for `consent_pd_version`:

- **Nullable, matching `consent_pd_at`'s own pattern**: a `users` row created before the
  question is ever reached (every row, at `/start`, and every row belonging to a person
  who has not yet finished a feedback flow) must be able to hold "never asked" without a
  placeholder value — `NULL` is that state.
- **Both-or-neither, not enforced by a schema constraint**: `REQ-014-schema.md` §10
  explicitly declines a `(consent_pd_at IS NULL) = (consent_pd_version IS NULL)` `CHECK`
  for its own pair; this artefact makes the identical choice for
  `broadcast_opt_in`/`broadcast_opt_in_asked_at` for the identical reason — nothing in
  REQ-031's acceptance criteria asks the database to reject a state where one is set and
  the other is not, and `writeBroadcastOptInAnswer` (REQ-031.md §2.6) is, by that
  document's own statement, "the ONLY function anywhere in this design... that ever writes
  `users.broadcast_opt_in` or `users.broadcast_opt_in_asked_at`" — a single write site is
  a stronger practical guarantee than a `CHECK` would add, and adding one anyway would be
  the same unrequested-machinery overreach REQ-016-schema.md §6/REQ-019-schema.md §3.4
  already declined for comparable cases.

**No default** (implicitly `NULL`) — matching `consent_pd_at`'s own no-default shape.
Every existing `users` row (all created before this migration, hence never asked) reads
back `NULL` after the migration with no explicit backfill needed, which is exactly the
correct "never asked" state for a pre-existing row (§4's backfill note below states this
explicitly).

**Column ordering in `schema.ts`**: placed immediately after `broadcastOptIn` in the
`users` table definition, mirroring how `consentPdVersion` sits immediately after
`consentPdAt` — grouping a boolean/timestamp answer pair visually, matching the existing
file's own layout convention rather than appending unrelated columns at the end.

---

## 4. Cascade / delete behavior

**`feedback.registration_id` FK: `ON DELETE restrict`**, matching every other FK in this
schema (no existing FK uses `cascade` or `set null`). No requirement in scope ever deletes
a `registrations` row outright — S13 (deletion anonymizes and preserves aggregates)
governs a *person's* deletion, not a registration's, and REQ-011's own design already
established that registrations are never hard-deleted, only transitioned through
`admission` states (`withdrawn`, `rejected`, etc.). `restrict` is therefore the correct,
already-established default: it is not a new decision this artefact is making, only
confirming `feedback` introduces no exception to it.

**S13 interaction — anonymization, not deletion.** When a person exercises `/profile →
delete my data` (S13), the anonymization routine operates on `users`/`profiles` PII
columns; `registrations` rows (and, by the same reasoning, `feedback` rows keyed to them)
are attendance history that S13 requires to survive anonymization so that aggregate
counts (show-rate, attendance history) do not silently change. `feedback.nps`/`liked`/
`improve`/`topic_votes` carry free-text and a number, not identity-bearing content by
themselves — but `liked`/`improve`/`topic_votes` are free text a respondent could
voluntarily type identifying information into (e.g. naming themselves or a colleague).
**This artefact flags, rather than resolves, whether `feedback.liked`/`improve`/
`topic_votes` should be included in whatever field list a future anonymization routine
blanks** — no anonymization routine exists yet in this codebase to extend (S13's routine
is not yet implemented as of REQ-031), so this is recorded as an open question (§8.1)
rather than invented here, the same restraint REQ-019-schema.md §6 exercised for its own
five skip columns' inclusion in a not-yet-built routine.

**`users.broadcast_opt_in_asked_at`** is not PII content itself (a bare timestamp saying
"asked once") and needs no special anonymization handling beyond whatever `users` row
anonymization already does to timestamps on that row generally (unaffected by this
change, per the same reasoning REQ-014-schema.md §6 applied to `consent_pd_version`).

---

## 5. S11 / S13 relevance

**S11 (PII never appears in plaintext logs, scoped to phone/email):** this change adds no
phone or email column. `feedback.liked`/`improve`/`topic_votes` are free text that could
*incidentally* contain something a respondent chose to type, but they are not the
phone/email fields S11 is scoped to, and REQ-031.md's own design never echoes their
content into a log, audit payload, or third-party message — `advanceFeedbackFlow`
(REQ-031.md §6.4) only ever sends catalog-defined prompt text back to the same respondent,
never their own prior free-text answers. No new S11 exposure from this schema change
itself; S11 compliance for these columns is otherwise a handler-level property this
artefact does not need to re-derive.

**S13 (deletion anonymizes and preserves aggregates):** `feedback.nps` is exactly the kind
of aggregate-bearing signal S13 says must survive anonymization (a numeric satisfaction
score has no bearing on identity and should not be zeroed just because its author later
deletes their PII) — it should NOT be blanked by a future anonymization routine. `liked`/
`improve`/`topic_votes`, as free text, are the open question named in §4/§8.1 above: they
may need blanking (they are not aggregate data, and could incidentally carry
identity-adjacent content), but no routine exists yet to specify this against, so it is
recorded, not resolved.

**Does adding `feedback` or `broadcast_opt_in_asked_at` trigger S13/`decisions/0005`
sign-off?** No — both are purely additive (`CREATE TABLE`, `ADD COLUMN`), touching no
existing personal-data column's content. S13/`decisions/0005` gates a migration that drops
or rewrites personal-data content; neither operation here does either.

---

## 6. The migration (prose, not SQL — Drizzle-generated per `decisions/0005`)

Per `decisions/0005-orm-drizzle.md`: this migration is **generated by `drizzle-kit
generate`** against an updated `apps/bot/src/db/schema.ts` (one new `pgTable("feedback",
...)` definition exported alongside the existing tables; one new `broadcastOptInAskedAt:
timestamp("broadcast_opt_in_asked_at", { withTimezone: true })` column added to the
`users` table definition), never hand-written, and committed as the plain `.sql` file that
step produces under `apps/bot/drizzle/`. Current migration state: `0005_violet_venom.sql`
is the latest (per `apps/bot/drizzle/meta/_journal.json`, idx 5) — this migration will be
generated as `0006_<generated-name>.sql`, the next sequential file, by `drizzle-kit
generate` itself (the tag is auto-assigned, not chosen by any agent).

Expected statement shape (for BACKEND-DEV and REVIEWER to confirm the generated file
matches — this artefact does not write the SQL itself), following `0005_violet_venom.sql`'s
own observed shape for a new table with a FK and a unique index:

```sql
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid NOT NULL,
	"nps" integer NOT NULL,
	"liked" text,
	"improve" text,
	"topic_votes" text[],
	"liked_skipped" boolean DEFAULT false NOT NULL,
	"improve_skipped" boolean DEFAULT false NOT NULL,
	"topic_votes_skipped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_feedback_nps_range" CHECK ("feedback"."nps" >= 0 AND "feedback"."nps" <= 10)
);
--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feedback_registration_id" ON "feedback" USING btree ("registration_id");
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "broadcast_opt_in_asked_at" timestamp with time zone;
```

No other statement should appear (no rename, no type change, no other table touched). If
`drizzle-kit generate` proposes anything beyond these four statement groups, that is a
signal the working schema file has drifted from this artefact's committed shape and
should be reconciled before accepting the generated migration — the same caution
REQ-019-schema.md §5 states for its own case.

**Backfill.** `CREATE TABLE feedback` needs no backfill (a new, empty table). `ADD COLUMN
broadcast_opt_in_asked_at` needs no backfill either: it has no default, so every existing
`users` row receives `NULL` as part of the same `ALTER TABLE`, which is exactly the
correct "never asked" state for a row that predates this migration (§3 above).

### 6.1 Reversibility

The down-migration is:

- `DROP TABLE feedback;`
- `ALTER TABLE users DROP COLUMN broadcast_opt_in_asked_at;`

**Both unconditionally reversible in the "clean, not necessarily lossless" sense this
schema's own precedent uses** (REQ-016-schema.md §4's `pending_source` reversal,
REQ-019-schema.md §5.1's `*_skipped` columns): `DROP TABLE feedback` is a clean structural
reversal but is lossy in the ordinary sense that every respondent's actual NPS/liked/
improve/topic-votes answers are destroyed — this is real data loss, not merely
degradation of a resumability aid, and should be treated with the same caution any
`DROP TABLE` of user-submitted content deserves (a backup/export before rollback, if this
migration is ever rolled back after real feedback rows exist, is an operational
precaution, not a schema-level guarantee this artefact can provide). Dropping
`broadcast_opt_in_asked_at` is lossy in the identical, narrower sense `consent_pd_version`'s
own reversal is (REQ-014-schema.md §11): the "already asked" fact for every person who
answered the broadcast question is lost, though `broadcast_opt_in`'s own boolean answer is
untouched (it existed before this migration and survives the column drop). Neither
reversal fails outright the way re-adding `NOT NULL` can (REQ-019-schema.md §5.1) — no
`NOT NULL`/`CHECK` is being re-imposed on pre-existing data in either down-migration — so
both are mechanically safe to run at any time, only informationally lossy.

---

## 7. Acceptance criteria → schema element map

| AC | Schema element satisfying it |
|---|---|
| AC1 — checked-in-only send; admitted-but-never-checked-in receives nothing | Not a schema property — `registrations.checked_in_at`/`admission` (REQ-011, unchanged) already carry this; `feedback` adds no column bearing on eligibility. |
| AC2 — one feedback row 1:1 with the registration; a second row fails on a DB constraint | §1.1's `UNIQUE` index on `feedback.registration_id` — the entire mechanism, exercised directly by a raw duplicate `INSERT` per the AC's own stated verification method. |
| AC3 — every question except NPS skippable, feedback still saves; skipping NPS saves nothing | §1.2's `nps NOT NULL` (no row can exist without it — the only path that ever inserts one, `writeFeedbackNps`, always supplies it); §1.5's three `*_skipped` columns as the durable "explicitly skipped, not merely not-yet-reached" state AC3's resumability needs. |
| AC4 — exactly one T+24h reminder, nothing thereafter | Not a schema property of `feedback`/`users` directly — governed by `notification_ledger`'s existing `UNIQUE(registration_id, kind)` constraint (REQ-025, unchanged); `feedback`'s own existence is what REQ-031.md §5.3's `NOT EXISTS` selection clause reads to decide "did they engage." |
| AC5 — broadcast-opt-in asked once; a later event's flow does not re-ask; `broadcast_opt_in` stays false after a decline | §3's new `broadcast_opt_in_asked_at` column — the entire mechanism: `NULL` means never asked, non-`NULL` (regardless of the paired `broadcast_opt_in` value) means never ask again, read as a global per-user gate (REQ-031.md §2.7), not per-registration. |
| AC6 — no "want to speak" question, no `talks` table/entity | This artefact adds no `talks`/`Talk` table or column — confirmed by §1–§3 above naming only `feedback` and one `users` column. |
| AC7 — request reaches a user with `broadcast_opt_in = false` (transactional) | Not a schema property — governed by `sendLedgeredNotification`'s `classification: "transactional"` code path (REQ-025, unchanged), which never reads `broadcastOptIn`. Schema imposes no constraint that would prevent a transactional send regardless of that column's value. |

---

## 8. Open questions (not resolved by invention)

1. **Should `feedback.liked`/`improve`/`topic_votes` be included in a future S13
   anonymization routine's blanked-field list?** §4/§5 name this explicitly: `nps` should
   clearly survive (it is aggregate-shaped, like show-rate), but the three free-text
   columns could incidentally carry identity-adjacent content a respondent typed
   voluntarily. No anonymization routine exists yet in this codebase to extend, so this is
   left as a decision for whichever future requirement implements S13's routine, not
   invented here.
2. **Should a `CHECK` constrain `topic_votes`'s array length or element content (e.g.
   forbidding an empty-string element, or capping the number of topics)?** Declined here —
   `parseTopicVotes` (REQ-031.md §3.4) already drops empty segments after trimming before
   ever calling a write function, and no acceptance criterion caps topic count. Flagged in
   case SECURITY-REVIEWER or CODE-DESIGN-VALIDATOR wants a defensive belt-and-suspenders
   bound despite no requirement forcing one — the same class of restraint REQ-019-schema.md
   §3.4 exercised for its own comparable case.
3. **No `CHECK` forbidding a value column being non-null while its matching `_skipped`
   flag is `true`**, for the identical reason and with the identical caveat
   REQ-019-schema.md §3.4/§10 open question 1 already recorded for `profiles`' five
   columns — restated here rather than silently assumed for `feedback`'s three.
