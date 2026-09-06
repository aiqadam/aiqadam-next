# REQ-014 — Schema addendum: `chapters.active` and `users.consent_pd_version`

**Role:** DATA-DESIGNER (design only — no implementation code, no migration SQL/TS;
BACKEND-DEV writes both per `.claude/agents/data-designer.md`).

**Scope:** exactly two new columns, closing two gaps surfaced by other roles' designs
for REQ-014:

1. `chapters.active` — the gap `docs/agents/design/REQ-010.md` §6 open question 2
   flagged: "REQ-014 talks about 'one active chapter' vs. 'two active chapters' as an
   existing predicate, but `Chapter`'s field list in REQ-010's own scope... has no such
   column." (§1–§9 below, unchanged from this artefact's first version.)
2. `users.consent_pd_version` — the gap `docs/agents/design/REQ-014.md` §[open
   questions] flagged: AC3 requires that accepting consent "records the consent wording
   version," but `users` (REQ-010 §2) has no column to hold it — only `consent_pd_at`,
   a timestamp with no companion for *which* wording was shown. (§10–§13 below.)

This artefact is separate from CODE-DESIGNER's handler-flow design for REQ-014's
`/start` command — this covers only what the database stores and how it is queried;
CODE-DESIGNER owns the conversation flow that reads and writes it.

No table other than `chapters` and `users` is touched. `users.chapter_id` already
exists (REQ-010 §2) and is sufficient to record the chapter-assignment outcome — §1–§9
add nothing further to `users`; §10 is the one addition `users` needs for AC3.

---

## 1. The column

| Field | Type | Nullable | Default |
|---|---|---|---|
| `active` | boolean | No | `true` |

**Name: `active`.** This is the exact word REQ-014's requirement text and acceptance
criteria use ("one active chapter", "two active chapters") and the exact word REQ-010's
open question already named. PRD 5's vocabulary rule (one word per concept) rules out a
synonym like `is_enabled`, `status = 'active'|'inactive'`, or `live` — those either
introduce a second word for the same concept or turn a binary fact into a string enum
with no other member ever named by any requirement. A boolean is the correct shape
because the spec never describes a third chapter state (no "archived", "paused", or
"draft" chapter is mentioned anywhere in PRD 5, PRD 14, or REQ-014) — inventing a status
enum for values nothing asks for would violate the "don't add a field/state the
requirement doesn't call for" rule as surely as adding an extra table would.

**NOT NULL.** REQ-014's AC2 logic ("exactly one chapter row marked active" / "two active
chapters") is a two-valued distinction read directly off this column. A nullable boolean
would introduce a third, unspecified state (`NULL` — "unknown"/"not yet decided") that
no acceptance criterion, PRD section, or user story asks for, and that the counting query
in §4 would have to special-case for no benefit. Every chapter row must have a
determinate active/not-active reading for the `/start` logic to be well-defined, exactly
the same reasoning REQ-010 applied to `users.role` and `users.blocked`.

**Default `true` — justification.** The requirement text states no chapter currently
exists in any real database: chapters are created by an organizer-facing management flow
that is not yet built in this codebase (no requirement in scope through REQ-014 creates
one via a handler; REQ-010 only created the table). Two defaults are possible; `true` is
the correct one:

- **If the default were `false`:** the very first chapter ever inserted (by however
  BACKEND-DEV seeds it for REQ-014's own acceptance testing, or by whatever later
  requirement builds chapter management) would be inactive unless every insert path
  remembered to override the default. AC2's own first branch — "exactly one chapter row
  marked active... assigns that chapter... WITHOUT prompting" — could not be exercised
  from a plain, default-shaped insert; every test setup would need an explicit
  `active = true` write just to reach the single-chapter case. That is exactly backwards
  for the case REQ-014 treats as the common, no-friction path (STORY-DETAILS A4: "Land in
  the right city" — silent assignment is the expected outcome for a chapter that exists
  and has users landing in it).
- **If the default is `true`:** a freshly inserted chapter is immediately usable by
  `/start`'s silent-assignment branch with no extra write, matching the fact that a
  chapter is presumably created because it is meant to receive people, not to sit dormant
  until a second, separate "activate it" step nothing in scope defines. Multi-chapter
  ambiguity (AC2's second branch) only arises once a second row is inserted, which is a
  deliberate, visible action by whoever creates it — at that point two `true` rows
  coexisting is the exact state AC2 tests, produced without needing to remember an
  additional flag.

This default is a design recommendation grounded in AC2's own two test setups, not an
invented business rule about which chapters should be "live" in some product sense —
whether a chapter, once real chapter-management exists, should ever be creatable in an
inactive state is left to whichever future requirement designs that flow (see §7 open
question 1).

---

## 2. The migration (prose, not SQL)

This is a single additive `ALTER TABLE` migration against the already-existing
`chapters` table created by REQ-010's migration:

- `ALTER TABLE chapters ADD COLUMN active boolean NOT NULL DEFAULT true;`
- No other column, table, index, or constraint changes. No existing row's other columns
  (`code`, `name`, `timezone`, `default_lang`, `created_at`, `updated_at`) are read,
  rewritten, or reformatted by this migration.
- Because a `NOT NULL` column with a `DEFAULT` is being added (not one without a
  default), Postgres backfills every existing row with the default value as part of the
  same `ALTER TABLE` statement — no separate `UPDATE` pass, no application-level backfill
  script, and no window where existing rows would fail the `NOT NULL` constraint.
- Drizzle Kit's `generate` step against the updated `chapters` table definition (adding
  `active: boolean("active").notNull().default(true)` to `apps/bot/src/db/schema.ts`)
  produces exactly this single `ALTER TABLE ... ADD COLUMN` statement — no other
  statement should appear in the generated `.sql` file. If `drizzle-kit generate`
  proposes anything beyond this one `ADD COLUMN` line (a rename, a type change elsewhere,
  a second table's alteration), that is a signal the working schema file has drifted from
  REQ-010's committed shape and should be reconciled before accepting the generated
  migration, not applied as-is.

**Reversibility.** The down-migration is `ALTER TABLE chapters DROP COLUMN active;`.
This is a clean, lossless reversal in the sense that matters for a fresh boolean flag: no
other column's data is affected, and every current row's `active` value is fully
determined by the default (no requirement through REQ-014 lets any handler set it to
anything other than what BACKEND-DEV writes for testing), so nothing product-meaningful
is lost by dropping it. It is not "reversible" in the sense of recovering a
value that carried independent information no other column captures — but no such value
exists yet, because no organizer-facing flow that sets `active` per-chapter for a genuine
business reason is in scope through REQ-014.

---

## 3. Why this does not trigger S13 sign-off

`security-invariants.md` S13 gates deletion/rewrite of personal-data or
attendance-history columns (the failure case it names is an "anonymization" that leaves
PII recoverable, or a hard delete that "retroactively alters a past event's published
figures"). This change is neither:

- **Not a drop or rewrite.** It is a pure `ADD COLUMN` with a default, on a table that
  gains a column — no existing column is dropped, renamed, retyped, or has its stored
  values altered.
- **Not personal data.** `chapters` holds no PII and no attendance history — REQ-010 §1
  lists its full field set (`code`, `name`, `timezone`, `default_lang`) as chapter
  metadata, not data about a person. `active` is one more piece of chapter metadata, the
  same category as `name` or `timezone`. It carries no `tg_id`, no name, no contact
  detail, no consent state, and no relationship to any individual's attendance record.
- **No FK, no join key change.** §4/§6 below confirm `active` is read by itself, is never
  joined against, and never touches `tg_id`.

On that basis this artefact records, for SECURITY-REVIEWER's use, that this migration
falls outside S13's gate: it is additive metadata on a non-personal-data table, with no
existing data loss.

---

## 4. Query shape for "exactly one" vs. "more than one" active chapter

**Recommendation: `SELECT id FROM chapters WHERE active = true LIMIT 2`, read by row
count (0, 1, or 2-meaning-"2 or more"), not `SELECT COUNT(*) ... WHERE active = true`.**

Reasoning:

- AC2's two branches only need to distinguish three cases: zero, exactly one, and more
  than one. A `LIMIT 2` query answers this with a result set of size 0, 1, or 2 — the
  handler never needs to know whether there are 2 or 200 active chapters, only that there
  is "more than one," so counting past 2 is wasted work. `COUNT(*)` forces Postgres to
  scan (or index-scan) every matching row to produce an exact total the caller is going
  to immediately truncate back down to a three-way branch; `LIMIT 2` lets the planner
  stop after the second match.
- At current and foreseeable chapter counts (a handful — this is a two-city Events Bot
  per PRD 5's `uz`/`kz` example codes) the performance difference is negligible either
  way; the recommendation is made for query-shape clarity (the code reading the result
  literally mirrors the three branches AC2 describes) rather than for scale.
- This is not a time-dependent predicate — `active` is a stored fact read as-is, with no
  "as of when" question attached, so `decisions/0006`'s explicit-clock-parameter rule
  does not apply to this particular query. It would apply if a future requirement made
  chapter activity time-bounded (e.g. "active from X to Y"), which nothing in scope does;
  flagged for completeness, not because it is triggered here.
- An index recommendation: given the query filters `WHERE active = true` on a small
  table, no dedicated index is necessary at current scale (REQ-010's `chapters` table has
  no requirement-stated volume that would need one); if chapter volume ever grows enough
  to matter, a partial index `ON chapters (active) WHERE active = true` would be the
  natural choice, mirroring the pattern already used for `registrations`' waitlist
  ordering in REQ-011's schema. Not required for REQ-014's acceptance criteria as
  written.

---

## 5. Confirmation: no other schema changes needed

- **`users` table:** no new column. `users.chapter_id` (REQ-010 §2, nullable FK to
  `chapters.id`, `ON DELETE RESTRICT`) already exists and is exactly what "persists the
  answer to `users.chapter_id`" (AC2's own wording) writes into. The silent-assignment
  branch and the asked-once branch both terminate in the same write: setting
  `users.chapter_id` to the chosen chapter's `id`. No second column is needed to
  represent "how" the assignment happened (silent vs. asked) — nothing in REQ-014's
  acceptance criteria asks that to be stored, and inventing one would be exactly the kind
  of unrequested field this role is instructed not to add.
- **No new table.** The "asked once" prompt is a conversation-flow concern
  (CODE-DESIGNER's territory — which chapters to list, what the message says, how the
  answer is captured) with no persistent state of its own beyond the eventual
  `users.chapter_id` write.

---

## 6. Mapping to AC2 and AC5

- **AC2** ("With exactly one chapter row marked active, /start assigns that chapter to
  the new user WITHOUT prompting; with two active chapters and no arrival context, /start
  asks once and persists the answer to `users.chapter_id`"): satisfied by §1's `active`
  column existing as the predicate `/start` reads, and §4's query shape giving the
  handler the exact three-way signal (0 / 1 / >1) AC2's two tested branches require.
  CODE-DESIGNER's handler-flow design consumes this query; this artefact supplies only
  the column and the query shape, not the handler.
- **AC5** ("`git grep` over apps/bot finds no query or branch that uses `tg_id` as a
  foreign key or as a join key between domain tables"): this new column does not touch
  `tg_id` in any way. `active` is a plain boolean on `chapters`, queried and written
  without reference to any user row at all — the chapter-activity check and the
  chapter-assignment write (`users.chapter_id`) both resolve through `users.id` /
  `chapters.id`, never `tg_id`, consistent with REQ-010 §5.1's binding rule that this
  artefact restates rather than departs from.

---

## 7. Open questions (not resolved by invention)

1. **Should a chapter ever be creatable as inactive, and by what flow?** No requirement
   through REQ-014 defines organizer-facing chapter creation/management at all — REQ-010
   created the table, this artefact adds the column, but nothing yet writes `active` to
   anything other than its default. Whichever future requirement designs chapter
   management should decide whether `active = false` is ever an intended initial state
   (e.g., a chapter being prepared before launch) or whether `active` only ever
   transitions `true → false` (retiring a chapter) after creation. Not decided here.
2. **Zero active chapters — what should `/start` do?** REQ-014's acceptance criteria
   describe exactly two states: "exactly one active chapter" and "two active chapters."
   Neither the requirement text nor any acceptance criterion describes the zero-active-
   chapters case. This is a real reachable state under this schema (nothing prevents
   every chapter row from having `active = false` — e.g., between retiring one chapter
   and activating its replacement, or before any chapter is ever created). The §4 query
   shape distinguishes this case cleanly at the data layer (`LIMIT 2` returns zero rows),
   so the *data* fully supports detecting it — but what `/start` should then say or do
   (refuse silently, show an error, fall back to some chapter, hold the user in an
   unassigned state) is a product/UX decision this artefact does not make. **Flagged
   explicitly for CODE-DESIGNER**, who owns the `/start` handler-flow design and needs an
   answer to design the flow completely: either the zero-active-chapters case must be
   handled with defined behavior in that design, or it must be recorded there as an
   explicit out-of-scope/should-not-happen assumption for REQ-014, pending a decision
   record if it is ever expected to occur in production.
3. **Should `chapters.active` ever be settable through `/profile`'s "changing chapter"
   feature (REQ-019)?** REQ-014's scope note says chapter is "changeable later via
   /profile (REQ-019's scope)." That is a `users.chapter_id` write by a member choosing
   among *already-active* chapters, not a write to `chapters.active` itself (which is an
   organizer/owner-level fact about the chapter, not a per-user preference). This
   artefact assumes REQ-019 only ever reads `active` (to offer a member a choice among
   currently active chapters) and never writes it — flagged so REQ-019's own design
   confirms rather than silently assumes this boundary.

---

## 8. Drizzle schema shape (pseudocode — not implementation)

Illustrating the one-line addition to the existing `chapters` table definition in
`apps/bot/src/db/schema.ts`; not valid TypeScript/Drizzle syntax, for BACKEND-DEV to
translate:

```
table chapters:                                 -- unchanged columns omitted for brevity
  ...
  default_lang  text          NOT NULL
  active        boolean       NOT NULL DEFAULT true    -- NEW: REQ-014's "one active chapter" predicate
  created_at    timestamptz   NOT NULL DEFAULT now()
  updated_at    timestamptz   NOT NULL DEFAULT now()
```

---

## 10. The second column: `users.consent_pd_version`

CODE-DESIGNER's `docs/agents/design/REQ-014.md` flagged this gap directly: AC3 requires
that accepting the personal-data consent prompt "records the consent wording version,"
readable back from the row (AC3's own verification method: "verified by reading the row
back"). `users.consent_pd_at` (REQ-010 §2) is a timestamp with no companion column
recording *which* wording a given user accepted — a bare timestamp cannot answer "which
version was this" once the wording is ever revised, and re-deriving the answer from
"whatever the code constant said at read time" would silently mis-attribute the version
for anyone who consented under an earlier wording after a later one ships. That is not
what AC3 asks for: it asks for a stored value read back from the row.

| Field | Type | Nullable | Default |
|---|---|---|---|
| `consent_pd_version` | text | Yes | none (`NULL`) |

**Name: `consent_pd_version`.** Adopting CODE-DESIGNER's proposed name as-is — it reads
as a direct pairing with the existing `consent_pd_at` (same `consent_pd_` prefix, same
concept: the personal-data consent event), and introduces no synonym for "consent"
alongside the two other, deliberately separate consents this schema already tracks
(`broadcast_opt_in`, `profiles.publish_consent` — S1's "three separate consents, one
home each" rule, which this column does not disturb: it is metadata *about* the existing
`consent_pd_at` consent, not a fourth consent).

**Type: text, not an integer version number.** Two shapes were considered:

- **Integer version number** (e.g. `1`, `2`, incrementing each time the wording
  changes). This would work if wording revisions were guaranteed to be a strictly
  ordered, centrally-numbered sequence forever. But REQ-014's own scope note says the
  wording shipped now is "a plain factual placeholder... carrying an explicit version
  identifier" written by an implementing agent standing in for the product owner, who
  will supply real legal text later (USER-STORIES B1: "needs Viktor's wording and a
  version number"). Nothing in the requirement commits to that identifier always being a
  bare incrementing integer — the eventual legal/product process that replaces the
  placeholder might tag revisions by date, by locale-specific document version, or by
  some other scheme not yet decided. Choosing `integer` now would bind a future,
  unrelated decision (how the product owner's legal text gets versioned) to a schema
  type chosen before that process exists.
- **Text** (e.g. `"v1"`, `"v1-placeholder"`, or later `"2026-09-legal-v2"`). A short
  string tag accepts an incrementing integer written as text (`"1"`, `"2"`) just as
  easily as a date-stamped or descriptive tag, so it does not foreclose whichever
  numbering the product owner's real wording eventually uses. It costs nothing at
  current volumes (one row per user, one short string) and matches the placeholder
  AC4 already requires to exist ("carrying an explicit version identifier" — AC4 never
  says that identifier is numeric).

Text is the correct choice: it is the strictly more general shape, it matches AC4's own
wording ("identifier," not "number"), and it does not encode an assumption about a
future, out-of-scope versioning scheme this requirement does not define.

**Nullable, matching `consent_pd_at`'s own pattern.** A `/start`-created `users` row
(AC1) exists before consent is ever requested — "no profiles row and NO phone/email
value exists for that user" until consent is accepted (AC3), and the User row itself is
created first holding only Telegram-supplied fields (REQ-014's scope note). Exactly the
same reasoning REQ-010 applied to `consent_pd_at` (nullable: null until the timestamp is
set) applies here: `consent_pd_version` is null from row creation until the same write
that sets `consent_pd_at` also sets it, and a `NOT NULL` constraint would either force a
meaningless placeholder value at row-creation time (the exact anti-pattern PRD 5's
"optional field must never block completion" rule targets, applied here to *row
creation*, which must not be blocked or fictionalized just to satisfy a column
constraint) or block `/start`'s very first write, which AC1 requires to succeed with a
bare tg_id/tg_username/lang row and nothing else.

**Both-or-neither, not enforced by a schema constraint.** `consent_pd_at` and
`consent_pd_version` are set together by the same handler write (the consent-acceptance
branch CODE-DESIGNER's flow design owns) and should never be set independently — a
timestamp with no version, or a version with no timestamp, is a meaningless half-state.
This artefact does **not** recommend a `CHECK` constraint enforcing
`(consent_pd_at IS NULL) = (consent_pd_version IS NULL)`: nothing in REQ-014's
acceptance criteria asks for database-level enforcement of this pairing, and adding one
would be exactly the kind of unrequested schema behavior this role is instructed not to
invent. The pairing is a handler-write discipline for CODE-DESIGNER's design to state
explicitly (single write sets both columns together), not a constraint this artefact
imposes.

---

## 11. The migration for `users.consent_pd_version`

A single additive `ALTER TABLE` against the already-existing `users` table (REQ-010's
migration):

- `ALTER TABLE users ADD COLUMN consent_pd_version text;`
- No default value needed or recommended — a nullable column with no `DEFAULT` clause
  simply back-fills every existing row with `NULL`, which is exactly the correct value
  for any row that predates this migration (no such row has actually gone through a
  consent flow with a recorded version yet, since this column does not exist until now).
- No other column, index, or constraint changes. No existing column of `users`
  (`tg_id`, `tg_username`, `lang`, `role`, `chapter_id`, `broadcast_opt_in`,
  `consent_pd_at`, `blocked`, `created_at`, `updated_at`) is read, rewritten, or
  reformatted.
- Drizzle Kit's `generate` step against the updated `users` table definition (adding
  `consentPdVersion: text("consent_pd_version")` to `apps/bot/src/db/schema.ts`,
  directly beside the existing `consentPdAt` field for readability) produces exactly one
  `ALTER TABLE ... ADD COLUMN` statement.

**Reversibility.** The down-migration is
`ALTER TABLE users DROP COLUMN consent_pd_version;`. This is a clean, lossless-in-the-
relevant-sense reversal for any row created before real consent wording exists: it drops
placeholder version tags, not evidentiary data whose loss would matter to a real
person's consent record. Once real users have accepted a real wording version, dropping
this column would discard information that (per S1/S11's consent-provenance concerns)
could matter if a later dispute asks "what did this user actually agree to" — the same
caveat REQ-010 attached to `consent_pd_at` itself. It is additive and safely reversible
at the time this migration is written; it stops being a "nothing lost" reversal only
once real acceptances exist, exactly mirroring `consent_pd_at`'s own status.

---

## 12. Why this does not trigger S13 sign-off

Per `security-invariants.md` S13 (gates deletion/rewrite of personal-data or
attendance-history columns):

- **Not a drop or rewrite.** Pure `ADD COLUMN`, nullable, no default requiring a
  backfill computation — no existing column is dropped, renamed, retyped, or has its
  stored values altered.
- **The column itself carries no personal data.** A version tag (`"v1"`,
  `"v1-placeholder"`) identifies which piece of *product copy* a user was shown — it is
  a fact about the wording, not a fact about the person. It contains no name, no
  contact detail, no Telegram identifier, and no free text a user supplied; it is drawn
  from a small, implementer-controlled set of literal values (whatever versions the
  placeholder-then-real wording ever has). This is the same category distinction PRD 5
  and S1 already draw between the *fact that consent occurred* (which IS
  privacy-relevant, hence `consent_pd_at` existing at all) and *metadata describing that
  event* (a version tag), which is why this addition is additive schema evolution
  rather than a change to what personal data is collected — REQ-014 collects no new
  personal-data field via this column; it only makes the already-required-to-exist
  wording version (AC3/AC4) queryable.
- **No FK, no join key change.** This column is never joined against and never
  referenced by `tg_id`, consistent with §6's AC5 restatement below.

Relevant for S11 (data-minimization / no unnecessary personal data): this column does
not enlarge what personal data is collected about a user — the consent event itself
(`consent_pd_at`) is already required by S1/AC3 independent of this column; this column
only adds a non-personal label for *which wording* produced that already-required
event. It is exactly the same category as `chapters.active` in §3: metadata about a
product artefact (a chapter row; a wording revision), not about a person.

---

## 13. Mapping to AC3 and AC4

- **AC3** ("accepting sets `users.consent_pd_at` to a non-null timestamp and records the
  consent wording version, verified by reading the row back"): `consent_pd_at` already
  satisfies the timestamp half (REQ-010 §2, unchanged). `consent_pd_version` is the
  column that satisfies "records the consent wording version" — without it, AC3's second
  clause has nowhere to write to, and "verified by reading the row back" would have no
  column to read. CODE-DESIGNER's handler-flow design is responsible for the single
  write that sets both columns together (§10's "both-or-neither" discipline) at the
  moment consent is accepted; this artefact supplies only the column.
- **AC4** ("The consent wording stored is a plain factual placeholder carrying an
  explicit version identifier... verified by reading the committed wording and the
  handoff's result.issues entry"): `consent_pd_version` is where that "explicit version
  identifier" is stored per-user, letting a reader confirm which identifier a given
  user's acceptance recorded. The *wording text itself* is a copy/catalog concern
  (REQ-013's mechanism, per REQ-014's own scope note) and is not a `users` column — this
  artefact stores only the version tag, not the wording body, consistent with "don't add
  a field the requirement doesn't call for" (the wording text has its own home in the
  copy catalog, not duplicated onto every user row).
- **AC5** ("no query or branch uses `tg_id` as a foreign key or join key"): unaffected —
  `consent_pd_version` is a plain per-row text column on `users`, read and written by
  `users.id`, never joined to anything, and involves `tg_id` in no way.

---

## 14. Combined migration recommendation for BACKEND-DEV

**One combined migration, not two.** Both new columns (`chapters.active` and
`users.consent_pd_version`) are required by the same requirement (REQ-014), touch two
different tables with no dependency between them, and are each a single, independent
`ADD COLUMN` statement with no shared logic. Drizzle Kit's `generate` step naturally
produces both `ALTER TABLE` statements in one migration file when both table
definitions in `apps/bot/src/db/schema.ts` are updated in the same BACKEND-DEV turn —
that is simpler for BACKEND-DEV (one `generate` run, one migration file, one review
pass) than sequencing two separate migrations for the same requirement, and there is no
reversibility, ordering, or rollback reason to keep them apart: each statement is
independently additive and neither reads or depends on the other's column. If BACKEND-
DEV's tooling or workflow prefers two migration files for traceability, that is an
acceptable alternative with no design objection — this artefact's only requirement is
that each statement remains the single `ADD COLUMN` specified in §2 and §11
respectively, whether they land in one file or two.

---

## 15. Summary for the handoff

Two new columns, both closing gaps this requirement's own acceptance criteria created:

1. `chapters.active boolean NOT NULL DEFAULT true` (§1–§9) — closes REQ-010's flagged
   open question for AC2's "one active chapter" / "two active chapters" predicate. A
   single additive `ALTER TABLE ... ADD COLUMN` migration, no data loss, no rewrite of
   any other column — outside S13's gate because it is non-personal-data metadata on a
   non-PII table. Query shape: `SELECT id FROM chapters WHERE active = true LIMIT 2`,
   read by result-row count, not `COUNT(*)`.
2. `users.consent_pd_version text` (nullable, no default) (§10–§13) — closes
   CODE-DESIGNER's flagged gap for AC3's "records the consent wording version." A single
   additive `ALTER TABLE ... ADD COLUMN` migration, no data loss, no rewrite of any
   other column — outside S13's gate and adds no new personal-data field (S11): it is a
   version tag on already-required consent metadata, not personal data itself. Set
   together with `consent_pd_at` by one handler write; no schema-level constraint
   enforces that pairing (left to CODE-DESIGNER's handler design).

No `users` change beyond `consent_pd_version` and no `chapters` change beyond `active`.
No `tg_id` involvement anywhere in either column. **Recommendation for BACKEND-DEV: one
combined migration touching both tables**, generated in a single turn after both
`schema.ts` table definitions are updated (§14) — acceptable to split into two files if
BACKEND-DEV's workflow prefers, with no design objection either way.

Four open questions remain from this artefact's first version (§7, chapters.active
only, unchanged): whether inactive chapter creation is ever a real flow, **what
`/start` should do with zero active chapters (unanswered by REQ-014's acceptance
criteria — CODE-DESIGNER needs a decision or an explicit assumption to complete the
handler-flow design)**, and whether REQ-019's chapter-change feature ever writes
`active` (assumed: no, read-only). No new open question is raised by
`consent_pd_version` — its shape, nullability, and write timing are fully determined by
AC3/AC4 and REQ-010's existing `consent_pd_at` pattern.
