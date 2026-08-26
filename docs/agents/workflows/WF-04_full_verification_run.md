# WF-04 — Full Verification Run

**Trigger:** pre-release check (before a `deploy-prod` `workflow_dispatch`), or a
scheduled/requested full-site validation.
**Owner:** `ORCH`

## Overview

```
[INPUT: "validate before release" or "run a full check"]
        │
        ▼
┌──────────────────────────┐
│  STEP 00: GIT SETUP      │ ← FRONTEND-DEV, only if this run is expected to produce
│  (conditional)           │   fixes; a pure read-only validation pass with no fixes
└──────────┬───────────────┘   needed skips the git wrapper entirely
           ▼
┌───────────────────────┐
│  STEP 1: FULL CHECK   │ ← TEST-RUNNER
│  lint, build, manual  │
│  pass over every page │
└──────────┬─────────────┘
           ▼
┌───────────────────────┐
│  STEP 2: RELEASE      │ ← RELEASE-VALIDATOR
│  VALIDATION           │   Independently re-checks every "done" requirement against
│                        │   its acceptance criteria — not a re-run of Step 1's report,
└──────────┬─────────────┘   a fresh check against the code/rendered site.
           ▼
      Any BLOCKER/MAJOR found?
      ├─ NO  → PASS. RELEASE-VALIDATOR writes docs/status/release-<date>.yaml
      │        recording the clean result.
      └─ YES → Each finding is either:
               (a) this run's own responsibility to fix (a genuine regression) →
                   route to the owning agent, fix, re-run from Step 1 (a WF-03 loop
                   nested inside this run — cap at max_rework same as any other rework)
               (b) filed and forwarded per ISSUE_QUEUE.md if it's pre-existing and
                   unrelated (rare for a full-site run, but possible)
```

## Step 1 — Full check

**Agent:** `TEST-RUNNER`

```
1. npm run lint && npm run build — the entire project, quote real output.
2. npm run dev (or npm run build && npm run start for a production-shaped check), then
   walk every page/section currently in src/app and src/components/landing/ — both
   themes, a mobile and a desktop viewport each.
3. Write test-reports/report-<date>-WF04.yaml with full actual output.
4. Complete the handoff: PASS/FAIL, artifacts_out: ["test-reports/..."].
```

**Attribution rule for every failure this step reports** — the overview's branch (b),
"pre-existing and unrelated," is an attribution that must be earned structurally, never
by observing that the failure set matches a previous run's. See `core-directives.md`'s
"Failure Attribution Is Structural, Never By Count-Matching."

## Step 2 — Release validation

**Agent:** `RELEASE-VALIDATOR`

```
1. Read docs/agents/requirements.yaml for every requirement with status: done.
2. For each, independently re-check its acceptance_criteria against the actual current
   code/rendered site — not against what docs/status/requirement_status.yaml's history
   narrates happened. This is the check that catches a "done" that was never actually
   true.
3. Confirm no docs/agents/decisions/ record was silently contradicted by shipped code.
4. Write docs/status/release-<date>.yaml: which requirements were checked, which passed
   independent re-verification, any findings.
5. Complete the handoff: PASS/FAIL, next_action per the overview above.
```

## Output

A dated `docs/status/release-<date>.yaml` record that either clears the release or names
exactly what's blocking it — independently re-derived, not copied from earlier steps'
self-reports.
