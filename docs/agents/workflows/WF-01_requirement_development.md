# WF-01 — Requirement Development & Validation

**Trigger:** new feature/content request that has no drafted requirement yet.
**Owner:** `ORCH`

## Overview

```
[INPUT: feature/content request]
        │
        ▼
┌───────────────────┐
│  STEP 1: DRAFT    │ ← REQ-ANALYST (or CONTENT-BA for a content-shaped requirement)
│  Write requirement(s)
│  into docs/agents/requirements.yaml
└────────┬──────────┘
         │
         ▼
┌───────────────────┐
│  STEP 2: VALIDATE │ ← REQ-VALIDATOR ⛔ HARD GATE
│  Check quality     │
└────────┬──────────┘
         │
    PASS?├─── NO ──► REWORK → back to STEP 1 (max 3)
         │
        YES
         │
         ▼
[OUTPUT: requirement(s) status: pending in docs/agents/requirements.yaml,
 confirmed well-formed, testable, consistent — ready for WF-02]
```

WF-01 skips the git wrapper (Step 00/Final) — it only writes to `docs/agents/`, per
`core-directives.md`'s File Placement Rules.

## Step 1 — Draft requirements

**Agent:** `REQ-ANALYST` (or `CONTENT-BA` when the requirement is primarily
copy/content-shaped — see `docs/guides/content_ba_guide.md`)

```
1. Read docs/agents/requirements.yaml in full (existing schema: id/title/owner/status/
   description/acceptance_criteria/depends_on — do not invent a different schema).
2. Read docs/agents/anti-patterns.md and docs/agents/decisions/ for anything relevant.
3. For a new requirement:
   a. Assign the next REQ-NNN id (check the highest existing REQ number).
   b. Write it with: title, owner (FRONTEND-DEV or CONTENT-BA — whichever role actually
      implements it), status: pending, description (specific, cites real file paths
      where relevant), at least 2 concrete/verifiable acceptance_criteria, depends_on
      (existing REQ ids whose completion this needs, or empty list).
   c. Size it to one agent turn — if it doesn't fit, split it into multiple
      requirements with depends_on chaining them.
4. Append to docs/agents/requirements.yaml (append, do not reorder or rewrite existing
   entries).
5. Complete the handoff: status PASS, artifacts_out: ["docs/agents/requirements.yaml"],
   next_action: "Route to REQ-VALIDATOR".
```

### Acceptance criteria for this step
- [ ] Every new requirement has id, title, owner, status, description, ≥2 acceptance
      criteria, depends_on
- [ ] No orphaned `depends_on` references
- [ ] No contradiction with an existing `done` requirement or a `docs/agents/decisions/`
      record

## Step 2 — Validate requirements ⛔ HARD GATE

**Agent:** `REQ-VALIDATOR`

```
1. Read the new/changed requirement(s) plus docs/agents/requirements.yaml in full for
   context.
2. For each, check:
   a. TESTABILITY — can a check be written that definitively passes or fails? Vague
      words ("appropriately", "as needed", "looks good") → FAIL.
   b. CONSISTENCY — does it conflict with any `done` requirement or a
      docs/agents/decisions/*.md record?
   c. DEPENDS_ON CORRECTNESS — are the cited dependencies actually the right ones?
   d. DESIGN-SYSTEM FIT — if it implies any visual/copy element, is it expressible
      within the AI Qadam Design System (no request for a new color, font, or copy
      pattern the system doesn't already support)? If it genuinely needs something the
      system doesn't support, that's a MAJOR finding to flag, not a silent FAIL — it may
      mean the design system itself needs an update, which is outside this gate's scope
      to decide.
   e. SIZE — does this look like one agent turn, or does it smuggle in multiple
      unrelated deliverables that should be split?
3. If ANY check fails: FAIL, list issues by requirement id and check letter.
4. If all pass: PASS.
5. Complete the handoff: next_action PASS → "requirement ready for WF-02" |
   FAIL → "Rework REQ-ANALYST/CONTENT-BA".
```

### Acceptance criteria for this step
- [ ] Every check a-e above was actually run against the new requirement text
- [ ] Any FAIL cites the specific requirement id and which check failed

## Rework loop

Same as `docs/agents/ORCHESTRATOR.md` §6: on FAIL, ORCH increments `rework_count`,
appends the issues to the producer's next task description, re-routes. Max 3 before
escalation.

## Output

A `pending` requirement in `docs/agents/requirements.yaml` that REQ-VALIDATOR has
confirmed is well-formed, testable, and consistent — genuinely ready for WF-02 to pick
up. WF-01 does not flip status further; it stays `pending` until WF-02 starts work.
