# Shared Protocol — Handoff Lifecycle

**Audience:** every agent in the pipeline.
**Status:** Canonical for handoff *mechanics*. Conflicts with any other document are
resolved by the Instruction Precedence chain in
`docs/agents/instructions/core-directives.md` — not by this file claiming to win — and
reported in your handoff `result.issues` at MINOR severity so the drift gets fixed at
the source.

See `docs/agents/instructions/core-directives.md` for the broader behavioral rules this
protocol operates inside of (Zero Manual Work, Humanless Operation, Unblock-Everything).

---

## 1. Claim your handoff

At session start, find the handoff addressed to you:

```
handoffs/<RUN-ID>/step-*.json  where  to_agent == "<YOUR_AGENT_ID>"  and  status == "PENDING"
```

```bash
grep -rl '"to_agent": "<YOUR_AGENT_ID>"' handoffs/ | xargs grep -l '"status": "PENDING"' 2>/dev/null
```

Then:
1. Read the file, plus every artefact listed in `context.artifacts_in`.
2. Set `status` to `IN_PROGRESS`.
3. **Do not set `started_at` yourself — it is ORCH's field, stamped at dispatch (§1.2).**
   If the handoff reaches you with `started_at` still null, leave it null, do the work,
   and report it in `result.issues` at MINOR so ORCH fixes the dispatch.

If no PENDING handoff exists for you and none was named directly by the caller: report
that and stop. Do not invent work — check `docs/agents/requirements.yaml` for the next
`pending` requirement instead, per `docs/agents/ORCHESTRATOR.md`.

## 1.1 A handoff's factual premises are checkable, and may be wrong

Instruction Precedence puts your handoff's `task` block at rank 1. That makes it the
highest authority on **what to do**. It says nothing about the handoff's **factual
claims** — a handoff is a record written by another agent, not ground truth.

**The rule.** When a handoff makes a *checkable factual claim* your work depends on — a
file exists, a path follows a convention, a count is N — verify it before building on
it. **A verified disagreement outranks the handoff:** report it in `result.issues`, act
on what you measured, and state plainly what you did and why.

**This is not license to disregard the handoff's instructions.** Instruction Precedence
still governs those, and a **safety/gate rule is never overridable** by anything,
including your own measurement. The distinction is between what you are told to **do**
and what you are told **is true**. Silently complying with a false premise and silently
ignoring a correct instruction are both failures.

## 1.2 `started_at` is stamped at dispatch, by ORCH

**ORCH's procedure, mechanically, every dispatch:**

1. Take one clock read when creating the handoff file.
2. Write **both** `created_at` and `started_at` from that single value, in the same
   write that creates the file. If the agent spawn is not the same write/action as the
   handoff file's creation (any other tool call happens in between), re-read the clock
   and overwrite `started_at` at the moment of spawning instead.
3. **Do not ask the receiving agent to stamp it in the spawn prompt.** The spawn prompt
   tells the agent to claim the handoff by setting `status` to `IN_PROGRESS`, and says
   nothing about `started_at`.

**What the field means: the moment the work was DISPATCHED, not the moment the agent
began.** It is a property of ORCH's act, which is why ORCH owns it.

**A null `started_at` on a handoff already in your hands is ORCH's to fix, not yours.**
A value invented now for a dispatch nobody can attest to is worse than a visible gap —
report it (§1 step 3) rather than filling it in.

---

## 2. Handoff file schema

```json
{
  "handoff_id": "<uuid-v4>",
  "run_id": "<run-id>",
  "workflow_id": "<WF-01|WF-02|WF-03|WF-04|ADHOC-nnn>",
  "step": "01",
  "from_agent": "<AGENT_ID>",
  "to_agent": "<AGENT_ID>",
  "file": "handoffs/<run_id>/step-01-agent.json",
  "created_at": "<ISO8601-UTC>",
  "started_at": "<ISO8601-UTC or null>",
  "completed_at": "<ISO8601-UTC or null>",
  "status": "PENDING|IN_PROGRESS|COMPLETED|FAILED|ESCALATED|CANCELLED",
  "priority": "HIGH|NORMAL|LOW",
  "context": {
    "requirement_ids": ["<REQ-ID>", "..."],
    "requirement_text": {
      "<REQ-ID>": "<the requirement's full description, copied verbatim from docs/agents/requirements.yaml>"
    },
    "source_text": {
      "<relative/path/to/source>": "<text copied verbatim from that file, when this dispatch depends on exact wording>"
    },
    "related_handoff_ids": ["<uuid>", "..."],
    "artifacts_in": ["<relative/path>", "..."]
  },
  "task": {
    "description": "<clear, actionable task for the receiving agent>",
    "acceptance_criteria": ["<measurable criterion>", "..."]
  },
  "result": {
    "status": "PASS|FAIL|PARTIAL|BLOCKED|SKIPPED",
    "summary": "<one paragraph>",
    "artifacts_out": ["<relative/path>", "..."],
    "issues": [
      {"severity": "BLOCKER|MAJOR|MINOR", "description": "<description>", "affected_requirement": "<REQ-ID or null>"}
    ],
    "git_evidence": {
      "branch_name": "<feature/<run_id> or null>",
      "commit_sha_list": ["<sha>"],
      "remote_branch": "<origin/branch or null>",
      "push_status": "ok|failed|skipped",
      "pr_url": "<url or null>",
      "pr_create_error": "<error string or null>"
    },
    "next_action": "<suggested next step for ORCH>"
  },
  "rework_count": 0,
  "max_rework": 3,
  "gate_history": [
    {"iteration": 0, "gated_at": "<ISO8601-UTC>", "status": "FAIL", "summary": "<one paragraph>", "issues": ["..."], "next_action": "<what the rework must change>"}
  ]
}
```

**`gate_history` is OPTIONAL** — appears only on a gate-step handoff (REQ-VALIDATOR,
CODE-DESIGN-VALIDATOR, TEST-DESIGN-VALIDATOR, REVIEWER, RELEASE-VALIDATOR) that went
through at least one FAIL-and-rework cycle before its current `result`. Each entry
records a past `result` iteration, superseded by the file's current one.

**`context.requirement_text` — written by ORCH, read by everyone else.** ORCH copies
each in-scope requirement's full `description` verbatim from
`docs/agents/requirements.yaml` into this map. Receiving agents read the requirement
*here*, not by opening the whole file — see `core-directives.md`'s "Load Scoped Context,
Not Whole Files." Listing `"docs/agents/requirements.yaml"` in `artifacts_in` is not a
substitute.

### What goes in `task.description`, and what goes in `artifacts_in`

**`task.description` carries the instruction. It does not carry a second copy of a file
it already names.**

| Belongs INLINE, in `task.description`/`task.acceptance_criteria` | Belongs as a PATH in `context.artifacts_in` |
|---|---|
| What the receiving agent must do, in the order it must do it | A prior handoff's diagnosis, verdict, or evidence |
| The acceptance criteria this step is judged against | A diff, a build log, a test report |
| Constraints scoped to *this* step | An issue record, a decision record, a role or protocol file |
| Which judgments the dispatcher is deliberately leaving to the agent | Any file the agent is going to open anyway |

When content on the right is *also* reproduced on the left, the reproduction is the
defect — cite the path and state what to do with it. Where copied source text genuinely
must travel inside the handoff (a clause being amended, a line being quoted back), it
goes in `context.source_text`, keyed by source path — never duplicated in
`task.description` prose.

**Legal `result.status` values:**

| Value | Meaning |
|---|---|
| `PASS` | Work complete, acceptance criteria met |
| `FAIL` | Work attempted, acceptance criteria not met |
| `PARTIAL` | Some criteria met; remainder blocked and listed in `issues` |
| `BLOCKED` | Could not start or continue; blocker named in `issues` |
| `SKIPPED` | Step not applicable to this run (state why in `summary`) |

### Worked examples — what a finished `result` block looks like

<example name="validator-fail">
A FAIL names every failed check, by acceptance criterion, with the specific gap — never
a general impression:

```json
"result": {
  "status": "FAIL",
  "summary": "2 of 4 acceptance criteria unmet in docs/agents/design/events-filter.md. AC2 (mobile-collapsed filter state) has no design element: the doc names the desktop layout but never states the under-768px behavior. AC3's empty-state copy is 'shows nothing' — not concrete copy, so FRONTEND-DEV would have to invent it.",
  "artifacts_out": [],
  "issues": [
    {"severity": "BLOCKER", "description": "AC2: no design element covers the sub-768px collapsed state. Design must state the trigger and the collapsed layout.", "affected_requirement": "REQ-014"},
    {"severity": "BLOCKER", "description": "AC3: empty-state copy unspecified. State the exact heading/body/CTA text per content_ba_guide.md.", "affected_requirement": "REQ-014"}
  ],
  "next_action": "Rework CODE-DESIGNER — 2 BLOCKERs above, rework iteration 1 of 3"
}
```
</example>

<example name="validator-pass">
A PASS states what was independently re-derived and how. "Looks good" is not a PASS;
naming the artefact opened and the check run is:

```json
"result": {
  "status": "PASS",
  "summary": "Read docs/agents/design/events-filter.md directly. All 4 acceptance criteria map to concrete design elements: AC1->filter chip layout SS2.1, AC2->collapsed-under-768px trigger and layout SS2.3, AC3->empty-state copy verbatim SS3, AC4->design-token usage confirmed (no raw hex present). No TBD/deferral language (grepped). No .tsx code present in the artefact -- structure/props description only.",
  "artifacts_out": [],
  "issues": [],
  "next_action": "Route to FRONTEND-DEV"
}
```
</example>

<example name="partial">
PARTIAL is for genuinely met-plus-blocked, never for "mostly passed":

```json
"result": {
  "status": "PARTIAL",
  "summary": "3 of 4 acceptance criteria verified manually (see test-reports/report-20260825-WF02-REQ014.yaml). AC4 (dark-theme check) could not be completed: the dev server would not start in this environment (npm run dev timed out, see report for full output). Not a code defect -- an environment limitation this run could not resolve.",
  "artifacts_out": ["test-reports/report-20260825-WF02-REQ014.yaml"],
  "issues": [
    {"severity": "MAJOR", "description": "AC4 unverifiable in this environment -- dev server would not start. Needs re-verification in an environment where it does.", "affected_requirement": "REQ-014"}
  ],
  "next_action": "ORCH decision: AC4 blocks 'done' for REQ-014 -- route to RELEASE-VALIDATOR once a working environment is available, do not mark done yet"
}
```
</example>

---

## 3. Timestamps come from the clock, never from memory

```powershell
(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
```
```bash
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

`completed_at` must never precede `started_at`.

| Field | Who writes it | When |
|---|---|---|
| `created_at` | ORCH | at handoff creation |
| `started_at` | **ORCH only** | at dispatch — same write and clock read as `created_at`, per §1.2 |
| `completed_at` | the receiving agent | when it completes the handoff |
| `status` | the receiving agent, `PENDING`→`IN_PROGRESS` (§1) →`COMPLETED`/`FAILED` (§4). ORCH sets the initial `PENDING`, and sets `ESCALATED`/`CANCELLED` per `ORCHESTRATOR.md` | on claiming and completing |
| `result` | **the receiving agent, and only the receiving agent** — its own attested first-hand report | when it completes the handoff |
| `task` (including `description`/`acceptance_criteria`) | **ORCH only** — the dispatch itself; the receiving agent never modifies it | at handoff creation |

---

## 4. Completing a handoff

```
1. Set status: COMPLETED (or FAILED, if result.status is FAIL/BLOCKED and nothing more
   can be attempted this step).
2. Set completed_at from the clock.
3. Fill result in full — status, summary, artifacts_out, issues, next_action.
4. Stage and commit: the handoff file itself, plus every artifact it produced, by
   explicit filename (never a blanket add).
5. Report completion so ORCH can route the next step.
```

## 4.1 Recovery — an agent that cannot report

If a dispatched agent dies or is otherwise unable to complete its own handoff (a session
crash, an unrecoverable tool error), ORCH reconstructs what it can from observable
evidence — git history, files actually changed, partial output — and writes the `result`
itself, marking the reconstruction explicitly:

```json
"not_agent_attested": {
  "reconstructed_by": "ORCH",
  "reconstructed_at": "<ISO8601-UTC>",
  "reason": "<what happened to the acting agent, and why it could not report>",
  "fields_written": ["status", "completed_at", "result"],
  "evidence": ["<command run> -> <what it established>", "..."],
  "not_verifiable_after_the_fact": ["<what could not be settled>", "..."]
}
```

A **redispatch** (a fresh agent picks the step back up and does the work itself) does
**not** carry this field — the replacement agent's `result` is a genuine first-hand
report, nothing was reconstructed. Only use `not_agent_attested` when nobody actually
attests to the work first-hand.

---

## 5. Append-only files

`handoffs/orchestrator.log` and `handoffs/registry.json` are append-only — see
`core-directives.md`'s Bookkeeping section. A commit that reduces either file's size is
a defect, not a cleanup.
