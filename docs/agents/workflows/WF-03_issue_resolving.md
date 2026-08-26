# WF-03 — Issue Resolving

**Trigger:** a queued `docs/issues/ISS-NNNN.yaml` entry (`status: open`), or a
self-discovered/user-reported defect in existing behavior.
**Owner:** `ORCH`

WF-03 vs. WF-02: if the expected behavior is already specified (in
`docs/agents/requirements.yaml` or an existing design artefact), this is WF-03. If the
feature itself isn't specified yet, that's a new requirement — WF-01 then WF-02.

## Overview

```
[INPUT: ISS-NNNN or a described defect]
        │
        ▼
┌──────────────────────────┐
│  STEP 00: GIT SETUP      │ ← FRONTEND-DEV, docs/agents/protocols/GIT_SETUP.md
└──────────┬───────────────┘
           │ PASS
           ▼
┌───────────────────────┐
│  STEP 0.5: REGISTRY   │ ← ISSUE-FIXER
│  LOOKUP               │   Has this exact issue been seen/fixed before? Check
│                        │   docs/issues/ for a resolved entry with matching symptoms.
└──────────┬─────────────┘
           ▼
┌───────────────────────┐
│  STEP 1: DIAGNOSE     │ ← ISSUE-FIXER
│  Root cause, not      │   Does NOT implement the fix — produces a diagnosis for
│  symptom              │   CODE-DESIGNER to design a fix from.
└──────────┬─────────────┘
           ▼
┌───────────────────────┐
│  STEP 2: FIX DESIGN   │ ← CODE-DESIGNER → CODE-DESIGN-VALIDATOR ⛔ (same as WF-02 1/1b)
└──────────┬─────────────┘
           ▼
┌───────────────────────┐
│  STEP 3: IMPLEMENT    │ ← FRONTEND-DEV (same procedure as WF-02 Step 2)
│  → REVIEWER           │   → REVIEWER (same as WF-02 2b)
└──────────┬─────────────┘
           ▼
┌───────────────────────┐
│  STEP 4: REGRESSION   │ ← TEST-DESIGNER writes a verification case that reproduces
│  CHECK                │   the bug and FAILS against pre-fix code, then PASSES
│                        │   post-fix — the fail-then-pass proof the fix actually
│                        │   fixes something.
│                        │   → TEST-DESIGN-VALIDATOR → TEST-RUNNER (same as WF-02 3/3b/4)
└──────────┬─────────────┘
           ▼
┌───────────────────────┐
│  STEP 5: CLOSE ISSUE  │ ← ISSUE-FIXER sets docs/issues/ISS-NNNN.yaml status: resolved,
│                        │   resolving run-id, real UTC timestamp. If a GitHub issue
│                        │   exists (github_issue field), close it with evidence per
│                        │   ISSUE_QUEUE.md.
└──────────┬─────────────┘
           ▼
┌──────────────────────────┐
│  STEP FINAL: GIT MERGE   │ ← same agent as Step 00
└──────────┬───────────────┘
           ▼
[OUTPUT: ISS-NNNN resolved; fix merged to master with a regression check]
```

## Step 0.5 — Registry lookup

**Agent:** `ISSUE-FIXER`

```
1. Read docs/issues/*.yaml for entries with status: resolved whose description mentions
   similar symptoms/files.
2. If a clear match exists: cite it in this handoff's context, and check whether the
   same root cause has recurred (a fix that didn't actually fix the underlying issue). If
   recurring, flag severity as at least MAJOR regardless of the original severity.
3. Complete the handoff: summary notes whether a prior match was found.
```

## Step 1 — Diagnose

**Agent:** `ISSUE-FIXER`

```
1. Reproduce the issue directly — load the actual page, exercise the actual behavior,
   read actual output. Do not diagnose from the bug report's prose alone (No
   Speculation).
2. Trace to root cause: which component, which assumption broke, why nothing caught it
   (if anything existed to catch it).
3. Write the diagnosis into the handoff's result.summary: root cause (not just
   symptom), affected files, and what a fix needs to change.
4. Do NOT implement the fix. Complete the handoff: next_action: "Route to
   CODE-DESIGNER for fix design".
```

## Steps 2-4

Follow the same procedures as WF-02's Step 1/1b (design), 2/2b (implement + review),
3/3b/4 (test), with one addition: **Step 4's verification case must be shown to fail
against the pre-fix code and pass against the post-fix code**. TEST-DESIGNER states this
explicitly: checked out the pre-fix commit, exercised the case, confirmed it failed (or,
if the failure was a build/runtime error rather than a wrong-but-rendering result, quote
that error); then confirms it passes on the fix branch. A check that only ever ran
against already-fixed code proves nothing about whether it actually covers the bug.

**When the pre-fix failure is "the component/behavior did not exist":** the fail-then-
pass rule is right for a fix to **existing** behavior. It's trivially satisfiable when
the fix *adds* something new — the pre-fix failure is then "the element isn't there,"
which proves the addition is new and nothing about whether the verification actually
discriminates a correct implementation from a wrong one. Where this applies, TEST-DESIGNER
additionally states what specific wrong implementation the case would catch (e.g. "if the
collapsed-state trigger fired at 900px instead of 768px, this case would fail because it
resizes to exactly 750px and checks for the collapsed layout") — a stated, falsifiable
claim about discriminating power, not just presence.

## Step 5 — Close the issue

**Agent:** `ISSUE-FIXER`

```
1. docs/issues/ISS-NNNN.yaml: status: <resolved | instrumented | no_defect>, plus that
   status's own required keys — see docs/agents/protocols/ISSUE_QUEUE.md's "Issue status
   vocabulary". Not every run ends in `resolved` — check which one this run's outcome
   actually supports before writing this line.
2. Evidence-on-close is a HARD requirement (see ISSUE_QUEUE.md's "Closing an issue's
   GitHub mirror" section) if github_issue is set.
3. Complete the handoff: PASS, next_action: "Route to Step Final".
```

## Output

The issue's root cause is fixed, proven by a fail-then-pass regression check, merged to
`master`, and the issue record closed with a real resolution timestamp — not just marked
done on an agent's say-so.
