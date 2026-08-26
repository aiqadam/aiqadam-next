# WF-02 — Requirement Implementation

**Trigger:** one or two `pending` requirements in `docs/agents/requirements.yaml` (see
`ORCHESTRATOR.md` §4's batch cap) with all `depends_on` satisfied, validated by WF-01.
**Owner:** `ORCH`

## Overview

```
[INPUT: pending requirement IDs — max 2 per run]
           │
           ▼
┌──────────────────────────┐
│  STEP 00: GIT SETUP      │ ← FRONTEND-DEV, docs/agents/protocols/GIT_SETUP.md
└──────────┬───────────────┘
           │ PASS — ORCH flips status: pending → in_progress, logs "started" event
           ▼
┌──────────────────────┐
│  STEP 1: DESIGN      │ ← CODE-DESIGNER
│  Component structure,│
│  props/types, content │
│  shape                │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  STEP 1b: DESIGN     │ ← CODE-DESIGN-VALIDATOR ⛔ HARD GATE
│  GATE                │
└──────────┬───────────┘
      VALID?├── NO ──► REWORK (max 3, back to STEP 1)
           │
          YES
           ▼
┌──────────────────────┐
│  STEP 2: BUILD       │ ← FRONTEND-DEV
│  src/, public/       │
└──────────┬───────────┘
      FAIL─► REWORK
           │ PASS
           ▼
┌──────────────────────┐
│  STEP 2b: REVIEW     │ ← REVIEWER ⛔ HARD GATE
│                      │   design-system compliance, code quality, scope creep
└──────────┬───────────┘
           │ PASS
           ▼
┌──────────────────────┐
│  STEP 3: TEST DESIGN │ ← TEST-DESIGNER
│  (scope test first — │   no user-visible surface (docs-only requirement)?
│   skips 3b/4 if N/A) │   → skip straight to STEP 5
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│  STEP 3b: TEST GATE  │ ← TEST-DESIGN-VALIDATOR ⛔ HARD GATE
└──────────┬───────────┘
      VALID?├── NO ──► REWORK (max 3, back to STEP 3)
           │
          YES
           ▼
┌──────────────────────┐
│  STEP 4: VERIFY RUN  │ ← TEST-RUNNER
└──────────┬───────────┘
      PASS?├── NO ──► rework responsible agent → back to STEP 4
           │
          YES
           ▼
┌──────────────────────┐
│  STEP 5: RELEASE     │ ← RELEASE-VALIDATOR
│  VALIDATION          │   (re-verifies independently — does not trust Step 4's
└──────────┬───────────┘   report alone)
      PASS?├── NO ──► route to blocking agent
           │
          YES
           ▼
┌──────────────────────┐
│  STEP 6: DOC UPDATE  │ ← DOC-UPDATER
└──────────┬───────────┘
           │ PASS — ORCH independently confirms the specific files/fields
           │        DOC-UPDATER claims to have changed actually changed
           ▼
┌──────────────────────────┐
│  STEP FINAL: GIT MERGE   │ ← same agent as Step 00
│  rebase → PR → merge     │   docs/agents/protocols/GIT_MERGE.md
└──────────┬───────────────┘
           │ PASS
           ▼
[OUTPUT: requirements' status = done in docs/agents/requirements.yaml;
 feature/<run-id> squash-merged into master]
```

## Step 00 — Git setup

**Agent:** `FRONTEND-DEV`
**Protocol:** `docs/agents/protocols/GIT_SETUP.md`

ORCH supplies `context.branch_name = "feature/<run-id>"`. On PASS: ORCH flips the
requirement(s)' status to `in_progress` in `docs/agents/requirements.yaml` and appends a
`started` event to `docs/status/requirement_status.yaml` (real UTC timestamp).

**ORCH also extracts the requirement text once, here, for the whole run** — copies each
in-scope requirement's full `description` into `context.requirement_text` on this and
every subsequent handoff. Steps 1 through 6 read the requirement from there, never open
`docs/agents/requirements.yaml` themselves — see `core-directives.md`'s "Load Scoped
Context, Not Whole Files."

## Step 1 — Design

**Agent:** `CODE-DESIGNER`

```
1. Read the requirement(s) from your handoff's context.requirement_text and
   task.acceptance_criteria — not by opening docs/agents/requirements.yaml.
2. Read docs/guides/frontend_developer_guide.md and the Design System readme
   (docs/Design system for AI agents/readme.md).
3. Write docs/agents/design/<requirement-id-or-slug>.md:
   - Component structure (new components, or which existing ones change)
   - Props/types for anything new (TypeScript shapes, not implementation)
   - Content shape (what copy/data it needs, sourced from CONTENT-BA's brief if one
     exists)
   - Design-token usage (which existing tokens/classes apply — never a new token)
   - Responsive/theme behavior (what changes at mobile width, what changes in dark
     theme, if relevant)
   - Open questions (not silently resolved by guessing)
4. Validate against requirements: every acceptance criterion maps to a concrete design
   element. No acceptance criterion left unaddressed.
5. Complete the handoff: artifacts_out: ["docs/agents/design/<slug>.md"],
   next_action: "Route to CODE-DESIGN-VALIDATOR".
```

### Acceptance criteria
- [ ] Every acceptance criterion maps to a concrete design element
- [ ] All new component props/types are defined with field-level detail
- [ ] Only existing design-system tokens/classes referenced — no new ones proposed
- [ ] Open questions listed explicitly, not silently resolved

## Step 1b — Design gate ⛔ HARD GATE

**Agent:** `CODE-DESIGN-VALIDATOR`

```
1. Read the design artefact independently — do not read CODE-DESIGNER's result.summary
   as a substitute for reading the actual .md file.
2. For each acceptance criterion:
   a. Has a corresponding design element? No "TBD"/deferral language?
   b. Props/types fully specified?
   c. Every color/spacing/typography reference resolves to an actual token in
      docs/Design system for AI agents/tokens/tokens.css — not invented?
   d. No implementation code present (no actual .tsx code blocks — structure and
      types only, not component bodies)?
3. FAIL immediately on any check failure — no partial credit.
4. Complete the handoff: PASS → "Route to FRONTEND-DEV (Step 2)" |
   FAIL → "Rework CODE-DESIGNER", issues listing every failed check by requirement id.
```

## Step 2 — Build

**Agent:** `FRONTEND-DEV`

```
1. Verify branch: git branch --show-current must equal feature/<run-id>. If not: STOP,
   report FAIL before touching any file.
2. Read docs/agents/design/<slug>.md for this requirement.
3. Implement per the design in src/ (and public/ for any new static asset).
4. npm run lint — if FAIL, fix and retry (counts as rework).
5. npm run build — if FAIL, fix and retry.
6. Self-review checklist (docs/guides/frontend_developer_guide.md §4):
   [ ] No raw hex colors, only var(--token-name)
   [ ] No new spacing values outside the 4px-step scale
   [ ] Lucide icons only, correctly sized, currentColor
   [ ] Checked in both light and dark theme
   [ ] Checked at a mobile width and a desktop width
   [ ] Copy follows the casing/vocabulary rules in the design system
7. Complete the handoff: artifacts_out: ["src/...", "public/..."],
   next_action: "Route to REVIEWER (Step 2b)".
```

### Acceptance criteria
- [ ] `npm run lint` exits 0
- [ ] `npm run build` exits 0
- [ ] Matches the design artefact from Step 1
- [ ] No design-system token/pattern violation

## Step 2b — Review ⛔ HARD GATE

**Agent:** `REVIEWER`

```
1. Read the diff: git diff master...HEAD
2. Check against the design system (docs/Design system for AI agents/readme.md): tokens,
   type scale, spacing, component classes, icon rules, copy rules.
3. Check against docs/agents/anti-patterns.md.
4. Check scope: does the change do what the requirement asked, no more, no less.
5. Check consistency with any relevant docs/agents/decisions/ record.
6. FAIL if a genuine violation is found; otherwise PASS with any non-blocking notes
   recorded for the record.
7. Complete the handoff: PASS → "Route to TEST-DESIGNER (3)" |
   FAIL → "Rework FRONTEND-DEV".
```

## Step 3 — Test design

**Agent:** `TEST-DESIGNER`

**Scope test (run first):** does Step 2's `artifacts_out` contain anything with real
user-visible surface — i.e. is there an actual rendered change this step could plausibly
write a verification check against? A requirement whose only artefacts are `.md` files
(a decision record, a docs-only update) has nothing to manually verify beyond "the file
says what it should."

```
NO user-visible surface → complete the handoff: status: PASS, summary: "out of scope —
    no visual/behavioral surface produced by this requirement (docs-only artifacts:
    <list them>)", next_action: "Route directly to RELEASE-VALIDATOR (Step 5) — Steps
    3b/4 skipped, RELEASE-VALIDATOR verifies acceptance criteria by reading the
    artefacts directly."
YES → continue to the full procedure below.
```

```
1. Read the requirement(s) from your handoff's context.requirement_text and
   task.acceptance_criteria, plus docs/agents/design/<slug>.md.
2. Write docs/agents/test-specs/<REQ-ID>.md: for each acceptance criterion, a concrete
   verification case — the exact route/component, the exact viewport(s) and theme(s) to
   check, the exact expected behavior. This is a manual checklist today (no automated
   test framework exists yet — see AGENT_SYSTEM.md §7); write it precisely enough that
   TEST-RUNNER can follow it mechanically without judgment calls.
3. Verify: every acceptance criterion has ≥1 verification case that would fail if
   violated.
4. Complete the handoff: artifacts_out: ["docs/agents/test-specs/<REQ-ID>.md"],
   next_action: "Route to TEST-DESIGN-VALIDATOR".
```

### Acceptance criteria
- [ ] Every acceptance criterion has at least one verification case
- [ ] Each case names the exact route, viewport(s), theme(s), and expected result

## Step 3b — Test design gate ⛔ HARD GATE

**Agent:** `TEST-DESIGN-VALIDATOR`

```
1. Read the test spec file independently.
2. For each acceptance criterion, verify:
   a. At least one verification case targets it
   b. No "TODO" left in the spec
   c. Each case is precise enough to run without judgment (names the exact route,
      viewport, theme, expected result — not "check it looks right")
3. FAIL immediately on any check failure.
4. Complete the handoff: PASS → "Route to TEST-RUNNER (4)" | FAIL → "Rework
   TEST-DESIGNER".
```

## Step 4 — Verification run

**Agent:** `TEST-RUNNER`

```
1. npm run lint && npm run build — quote real output.
2. npm run dev, then follow docs/agents/test-specs/<REQ-ID>.md's cases exactly: each
   route, viewport, theme — report what was actually observed, not an impression.
3. Write test-reports/report-<date>-<run-id>.yaml with the actual output: lint/build
   result, each verification case and its outcome.
4. Complete the handoff: PASS/FAIL, artifacts_out: ["test-reports/..."],
   next_action: PASS → "Route to RELEASE-VALIDATOR" |
                FAIL → "Rework responsible agent (FRONTEND-DEV/TEST-DESIGNER)".
```

Failures caused by this run's own implementation are reworked on this branch. Failures
unrelated to this run's own acceptance criteria (pre-existing on `master`) are filed and
forwarded per `ISSUE_QUEUE.md` — not fixed here, don't block this step's own PASS
verdict. See `core-directives.md`'s "Failure Attribution Is Structural, Never By
Count-Matching" for how "pre-existing" must be established.

## Step 5 — Release validation

**Agent:** `RELEASE-VALIDATOR`

```
1. Independently re-run: npm run lint && npm run build (do not trust TEST-RUNNER's
   report alone — see core-directives.md's "Every producing step has a validating
   step"). If Step 4 had a manual verification pass, spot-check at least one case
   yourself rather than accepting the report wholesale.
2. Confirm every requirement_id in scope has all its acceptance_criteria satisfied —
   check each one explicitly against the actual code/rendered page, not against
   TEST-RUNNER's summary.
3. Check docs/agents/requirements.yaml for staleness relative to what actually shipped.
4. Complete the handoff: PASS → "Route to DOC-UPDATER" |
   FAIL → identify the blocking issue and name which agent it routes back to.
```

## Step 6 — Documentation update

**Agent:** `DOC-UPDATER`

```
1. For each requirement_id: flip status "pending"/"in_progress" → "done" in
   docs/agents/requirements.yaml.
2. Append a "done" event to docs/status/requirement_status.yaml (append, do not rewrite
   prior entries; real UTC timestamp).
3. Update README.md if the change altered documented current behavior.
4. Complete the handoff: artifacts_out: [every file actually touched, named
   explicitly], next_action: "Route to FRONTEND-DEV for Step Final".
```

**ORCH's independent check before advancing:** read DOC-UPDATER's `artifacts_out` and
confirm each named file actually contains the claimed change — grep for the flipped
status, the new event entry — before writing the run-done log line.

## Step Final — Git merge

**Agent:** same as Step 00.
**Protocol:** `docs/agents/protocols/GIT_MERGE.md`

ORCH supplies `context.branch_name` and `context.requirement_ids`. Use DOC-UPDATER's
`result.summary` as the commit/PR summary. List forwarded `ISS-NNNN` ids under a
"Forwarded, not fixed here" note if any exist.

## Parallel execution rule

At this project's size, WF-02 runs a single track (design → build → review → test →
release → doc), not letflow's parallel backend/frontend split — there is no backend.
If a future requirement genuinely spans two independent surfaces (e.g. this site plus a
separate backend service, once one exists), revisit this rule then.
