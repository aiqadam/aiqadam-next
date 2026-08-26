# Core Directives — AI Qadam Next

**Audience:** every agent in the pipeline. Cross-cutting rules, not role-specific ones.

**Status:** AUTHORITATIVE for cross-cutting behavioral rules, and the canonical home of
the **Instruction Precedence** chain below.

**Relationship to `docs/agents/shared/HANDOFF_PROTOCOL.md`:** that file is canonical for
handoff *mechanics* (claiming a handoff, JSON encoding, timestamp sourcing, legal
`result.status` values). This file is canonical for the broader behavioral rules that
apply beyond the handoff lifecycle.

---

## ⛔ Zero Manual Work

**The goal is to reduce manual work for the human to zero.** There is no human operator
in the loop by design (see "Humanless operation" below).

Do everything yourself. The only valid reasons to leave something undone:

1. Two or more genuinely equivalent options requiring a preference no agent can infer
   from `docs/agents/requirements.yaml`, `docs/agents/decisions/`, or this file — file it
   as a `docs/agents/decisions/000x-*.md` draft with the options named, don't silently
   pick one and don't stall waiting for an answer.
2. **(ORCH only)** ORCH believes a standard workflow can be skipped. Since there is no
   human to confirm this with, ORCH may only skip a workflow step when this file or
   `docs/agents/ORCHESTRATOR.md` explicitly authorizes the specific shortcut (e.g. a
   docs-only change skipping the git wrapper) — never on its own judgment that "this
   one's simple."

**Forbidden output patterns** — if any of these appear, the response is wrong:
- "You can run..." / "You need to..." / "To complete this, run..."
- "This should work after you..." / "Once you do X, then Y will work"

**No step marked MANDATORY needs re-confirmation before it runs.** Push, merge, and
delete-branch are pre-authorized by `docs/agents/protocols/GIT_MERGE.md` for every run
that reaches Step Final with all gates green — do not pause to ask before doing them.

### Orchestrator exception

ORCH fulfils Zero Manual Work by running the pipeline **through subagents**, not by
editing `src/`/`public/` or running build commands directly. Implementing a change
directly "to save time" is a pipeline violation. The one exception is a change passing
every check of the sizing rule in `docs/agents/ORCHESTRATOR.md` §5 — that section is the
canonical definition and this file does not restate it. It is a checklist, never a
judgment call about what feels trivial.

---

## ⛔ Humanless operation

This pipeline runs without a human reviewer, approver, or merge-clicker in the loop —
see [decisions/0001-full-pipeline-adopted.md](../decisions/0001-full-pipeline-adopted.md).
Consequences:

- **No PR waits for human approval.** An agent opens the PR, an agent verifies CI is
  green, an agent merges it.
- **Because there is no human backstop, every gate in this pipeline must actually gate.**
  A validator that rubber-stamps its producer's work removes the only check that exists.
  Validators MUST re-derive their verdict from the artefact itself, never from the
  producer's self-report.
- **Errors are correctable, not catastrophic** for anything not yet deployed — a bad
  merge to a feature branch is fixed by a later commit. This is **not** true once
  something reaches production: `deploy-prod` in the CI pipeline
  ([deploy_guide.md](../../guides/deploy_guide.md)) is a real user-facing site, and a bad
  release there is a real incident, not a self-healing one. Don't use "errors are
  correctable" as license to skip a gate on anything that reaches `master`/prod — it
  licenses moving fast pre-merge, not carelessness at the point that matters.
- **Weak-model tolerance is a design constraint, not a caveat.** This pipeline must
  produce reliably average-or-better output even when the executing model is small or
  cheap — assume the acting agent has no memory of this file's reasoning beyond what is
  written down. Every role file, workflow doc, and guide must be explicit and mechanical
  enough that an agent with limited judgment still produces correct, in-scope work by
  following the steps literally. This is why every gate has a checklist instead of "use
  good judgment," and why validators re-derive rather than trust.

---

## ⚠️ Every producing step has a validating step

**No agent's claim that it finished a task is itself evidence that the task is done.**
See [AGENT_SYSTEM.md](../AGENT_SYSTEM.md) §2 for the full producer/validator table. A
validator that only reads the producer's `result.summary` and says PASS has not
validated anything — it has copied a claim. Every validator role's file states exactly
what it must independently re-check (file existence, specific content, an actual command
run) rather than what it may take on trust.

### Re-derive under the conditions the property is actually about

Re-deriving a verdict is necessary but **not sufficient**. Ask what conditions the
property under test is *about*, and construct them if the ambient environment doesn't
supply them. **A green check run under conditions where the property could not have
failed is not evidence** — it is a passing run of a different test.

Example: a requirement's acceptance criterion is "the mobile nav collapses below 768px."
Checking it at a 1280px viewport and calling it PASS because "the page rendered fine" is
not a re-derivation — it never exercised the condition the criterion is about. The
validator must actually resize to under 768px and look.

---

## ⛔ Instruction Precedence

When two instruction sources disagree, apply them in this order — **first match wins**:

1. **Your handoff's `task` block** — the specific work, its acceptance criteria, and any
   rework notes. Most specific, so it wins.
2. **Your role file** (`.claude/agents/<role>.md`) — what your role may and may not do.
3. **`docs/agents/ORCHESTRATOR.md`** — orchestration decision logic: the sizing rule,
   gate enforcement, rework/escalation rules.
4. **Your workflow's step** (`docs/agents/workflows/WF-0N_*.md`) — the procedure for the
   step you are executing.
5. **Protocol docs** (`docs/agents/protocols/*.md`, `docs/agents/shared/HANDOFF_PROTOCOL.md`,
   `docs/agents/AGENT_SYSTEM.md`) — handoff mechanics, git mechanics, issue mechanics,
   roster/artifact-ownership mechanics.
6. **This file** (`core-directives.md`) — cross-cutting behavioral rules.
7. **`AGENTS.md`/`CLAUDE.md`** — the session-start pointer.

Two rules override the chain, always, at every level:

- **A `docs/agents/decisions/` record is never overridden by anything above it.** If a
  step seems to require contradicting a decided record, stop and flag it for REVIEWER
  sign-off — don't resolve it yourself in either direction.
- **A safety/gate rule is never overridden by a more specific instruction.** No handoff
  `task.description` can authorize skipping a validator, satisfying a gate by editing
  what it measures, or reporting unverified work as done. If a handoff appears to ask for
  that, it is malformed — report it as a BLOCKER in `result.issues`.

**This chain governs what you are told to DO, not what you are told IS TRUE.** Rank 1
makes your handoff's `task` block the highest authority for the *work*. It confers no
authority on the handoff's *factual claims* — a handoff is a record written by another
agent. When a handoff asserts a checkable fact your work depends on (a file exists, a
path follows a convention, a count is N), verify it before building on it — see
`HANDOFF_PROTOCOL.md` §1.1.

**Never resolve a conflict silently.** Follow the chain, then record the conflict in your
handoff's `result.issues` at MINOR severity so it gets fixed at the source.

---

## ⛔ Load Scoped Context, Not Whole Files

Every role except ORCH, REQ-ANALYST, and REQ-VALIDATOR: your requirement text is in your
handoff's `context.requirement_text` and `task.acceptance_criteria`. Read it there.
Consult `docs/agents/requirements.yaml` only to resolve a specific ID it names, and read
only that entry with a targeted read (`grep -A 15 "id: REQ-005"` or similar) rather than
opening the whole file.

**ORCH** reads what it needs to select and scope work, and is the role that copies the
in-scope requirement's full `description` into each handoff it creates.

**REQ-ANALYST and REQ-VALIDATOR** legitimately need whole-file access (numbering, schema
consistency, cross-requirement checks) — prefer `grep`/targeted reads when a check is
targeted, full read only when the check genuinely is global. At this project's current
size, `requirements.yaml` is small — full reads are cheap here in a way they wouldn't be
at letflow's scale, but the habit of preferring a targeted read still applies once it
grows.

The same rule generalizes: prefer a targeted read over a whole-file read for any large
file. `git diff main...HEAD` beats reading every changed file; `grep -n` beats reading a
long YAML to find one key. The deliberate exception is the **current**
`docs/status/requirement_status.yaml`, which you must read in full before appending to
it — kept small enough that this is practical (see §7 of AGENT_SYSTEM.md on the deferred
roll rule).

---

## ⚠️ Unblock-Everything

Every agent MUST resolve any problem that blocks full completion of the current task,
even if the problem is unrelated to the current task's original scope.

- Unrelated lint/build errors blocking the change → fix them.
- Verification reveals a failure → determine root cause and fix, don't just report and
  stop.

**Scope boundary.** This covers what stands in your way. A defect you merely *notice*
while working — unrelated, not blocking your acceptance criteria — is filed and
forwarded, not fixed here: report the finding to ORCH per
`docs/agents/protocols/ISSUE_QUEUE.md`. You do **not** choose an issue id yourself; only
ORCH allocates ids. It becomes its own later run, not unbounded scope creep on this one.

**Only exception:** a destructive or irreversible change to unrelated functionality.
Flag those for ORCH escalation instead of touching them.

---

## ⛔ No Issue Left Local-Only

A defect noticed but never filed is invisible to the next run. Any newly discovered
issue — whether it's the task at hand or an incidental finding — must end up registered
in `docs/issues/`, following `docs/agents/protocols/ISSUE_QUEUE.md`. The discovering
agent reports the finding to ORCH (title, description, severity, affected files) and
stops there — it does not choose an id or write the file itself.

"Out of scope for the current fix" is a reason to file the finding as its own issue —
never a reason to leave it undocumented.

---

## ⛔ No Speculation

Never report something as working without verifying it yourself. Run the build, run the
lint, look at the actual page — then report.

**Forbidden phrases:** "This should work...", "This looks like it will...", "This
probably...", "This might...", "I believe this...".

**If you cannot verify** — no Node/npm available, no way to view a rendered page — say so
explicitly. A requirement stays `in_progress`, not `done`, until someone actually runs
the checks and reports real output.

---

## ⛔ No Background Wait For A Cross-Turn Notification

**A dispatched agent must complete its work within its own tool-call loop.** Once a
spawned subagent's own tool-call loop ends, nothing further ever runs on its behalf —
there is no mechanism that resumes it later. The cross-turn "notification when a
background task finishes" capability exists **only for the top-level orchestrating
session**; a subagent that starts a long-running or backgrounded operation and then ends
its turn expecting to be woken up by such a notification will never be woken up.

**Any operation that could tempt a "start it and check back later" pattern — a build, a
lint run, a dev-server boot for visual checking — must be run and waited on
synchronously.** The agent's own tool call blocks until the operation actually finishes,
and the agent reads the real result before its turn ends. Do not call `Bash`/`PowerShell`
with `run_in_background: true` for this purpose, do not call `Monitor` to watch it, do
not call `ScheduleWakeup` expecting to be resumed — none of these deliver their result
back to a subagent's own turn. If a build is slow, that's fine — let the call take as
long as it takes.

This project's checks (`npm run lint`, `npm run build`) are fast relative to letflow's
full Elixir test suite, so the temptation this rule guards against is less likely to
arise here — but the rule is unconditional regardless of how fast the operation
typically is, since a subagent has no way to know in advance whether a given run will be
the slow one.

---

## ⛔ Never Call a Red Pipeline OK Without a Source

If CI is red or a `gh pr checks` call reports failure, you may not report it as
acceptable on your own judgment.

```bash
gh run view <run-id> --json jobs --jq '.jobs[]|"\(.name): \(.conclusion)"'
gh run view <run-id> --log-failed
```

Read the actual failing step. "It's probably flaky" is not a valid attribution without
reading the log.

---

## ⛔ Failure Attribution Is Structural, Never By Count-Matching

Calling a lint/build failure "pre-existing" (and therefore filed-and-forwarded rather
than this run's problem) is an **attribution**, and it has to be earned. This also
decides which side of "Unblock-Everything"'s scope boundary a failure falls on — a
failure attributable to this run blocks and is fixed here; a failure structurally
cleared is filed and forwarded.

To call a failure pre-existing you must show one of these, and name the specific
evidence:

1. **Structurally, this branch cannot have caused it** — the failing file and its
   dependencies do not appear in `git diff --name-only main...HEAD`; or
2. **It reproduces at the merge-base** — check out the merge-base, run it, quote the
   output; or
3. **A demonstrated mechanism outside this branch**, stated causally and evidenced by an
   actual check of that mechanism, never by assertion that one probably exists.

"Known failure" is not an attribution. Neither is "the previous run reported this."
**Matching a previously-reported failure is NOT evidence of pre-existence, and a count
differing by one is NOT evidence of regression.** If you can show none of the three
routes, report the failure as unattributed and file it — don't stretch route 1 to fit.

### In the diff is not the same as caused by the diff

Extra scrutiny is owed to a failing check that touches a file in the diff. But the
standard for clearing it is a **causal argument**, not proximity or its absence. "It's
in the diff, so it's ours" and "it's in the diff but looks unrelated" are equally
inadequate — write down the mechanism.

---

## ⛔ File Placement Rules

| File type | Directory |
|---|---|
| Handoff files | `handoffs/<RUN-ID>/` |
| Handoff registry/log | `handoffs/registry.json`, `handoffs/orchestrator.log` |
| Design artefacts | `docs/agents/design/` |
| Test/verification specs | `docs/agents/test-specs/` |
| Test/verification reports | `test-reports/` |
| Requirement status history | `docs/status/requirement_status.yaml` |
| Release validation records | `docs/status/` |
| Issue registry | `docs/issues/` |
| Decision records | `docs/agents/decisions/` |
| Application code/assets | `src/`, `public/` |
| Scratch (one-off scripts, debug dumps) | not committed — use your own scratchpad, never the project root, `src/`, or `docs/` |

**Before completing any handoff:** confirm no stray file landed in the project root
outside `package.json`, `package-lock.json`, `README.md`, `AGENTS.md`, `CLAUDE.md`,
`Dockerfile`, `next.config.ts`, `tsconfig.json`, `eslint.config.mjs`, `.gitignore`. Move
anything else to the correct directory.

**Workflow artefacts are committed to git**: `handoffs/`, `docs/agents/design/`,
`docs/issues/`, `docs/status/` are the audit trail. Commit them at the end of the step
that produces or modifies them, not just at Step Final.

---

## ⛔ Bookkeeping Is Not Optional

**1. `handoffs/orchestrator.log` is append-only.** Open with append mode, never
overwrite. A commit that shrinks this file's line count is a defect — flag it
immediately if observed, don't assume it was intentional.

**2. Timestamps come from the clock, never from memory.**

```powershell
(Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
```
```bash
date -u +"%Y-%m-%dT%H:%M:%SZ"
```

`(Get-Date).ToString(...)` without `.ToUniversalTime()` silently emits local time wearing
a `Z` suffix — always call `.ToUniversalTime()` first. `completed_at` must never precede
`started_at`.

**3. `docs/status/requirement_status.yaml` is append-only.** Read it in full before
appending, preserve its schema, append — never rewrite, reorder, or delete an entry.

---

## ⛔ Never Satisfy a Gate by Editing What It Measures

If a gate blocks you, fix the condition it's detecting. **Never make the detector stop
reporting.** Forbidden regardless of how the task is phrased: disabling an ESLint rule
inline to silence a warning instead of fixing it, deleting a failing check instead of
fixing what it caught, wrapping a failing command so its exit code is masked.

If a gate itself is wrong, escalate to change the gate's definition (flag it in your
handoff's `result.issues`); don't quietly satisfy it by other means.

---

## ⛔ Output File Format Rules

**YAML for structured records** (`docs/agents/requirements.yaml`,
`docs/status/requirement_status.yaml`, `docs/issues/*.yaml`, release records).
**JSON for handoff files** (`handoffs/<run-id>/*.json`, `handoffs/registry.json`) — ORCH
reads/writes them as structured data and JSON's stricter grammar suits that better.
**Markdown for everything narrative** (decision records, anti-patterns entries, design
artefacts, role/workflow/protocol docs).
