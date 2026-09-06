# 0001 — Full producer/validator pipeline adopted, sized down from letflow, no external queue

**Date:** 2026-08-25
**Status:** decided

## Question

aiqadam-next started with a lightweight, judgment-call-heavy agent system (5 roles, 3
workflows, no handoff files, no gates beyond an informal REVIEWER check). Should it stay
lightweight given the project's small size (a single landing page, no backend, no test
framework), or adopt the full producer/validator pipeline pattern used by the sibling
project `letflow` (17 roles, hard gates on every producing step, JSON handoff files,
append-only bookkeeping, decision records, an anti-patterns log)?

## Decision

Adopt the full pipeline pattern — every producing step gets an independent validating
step, work moves via committed handoff files, bookkeeping is append-only, and this
decision-record/anti-patterns-log structure exists from the start. Explicitly **not**
adopted: letflow's external `letflow-queue` service for atomic multi-host task claiming
(see `docs/agents/protocols/TASK_QUEUE.md` in letflow for the pattern) — task selection
here stays file-based, mediated by `docs/agents/requirements.yaml`'s status field and
ORCH's own bookkeeping, because nothing currently drives concurrent multi-session work on
this repo.

## Reasoning

The user's own reasoning, recorded verbatim in intent: the set of tasks a project like
this needs — requirement drafting and validation, design, frontend implementation,
review, test design and execution, release validation — is the same shape regardless of
project size. What differs between letflow and aiqadam-next is the *complexity* of
individual tasks (a static site vs. a stateful BPM engine with tenant isolation), not
whether the task categories exist at all. A "lightweight" system that skips gates isn't
actually simpler work, it's the same work with less checking behind it.

The queue-service omission is a genuine scope difference, not a simplification of the
same thing: letflow's queue exists to solve a real problem (two hosts racing to claim the
same requirement) that has no analog here yet, since this project has had exactly one
active session. Add it if that changes — see `docs/agents/AGENT_SYSTEM.md` §7.

## Consequences

- Every role file, workflow, and protocol doc that follows is full-size: hard gates,
  explicit acceptance criteria, JSON handoff files under `handoffs/`, append-only
  `docs/status/requirement_status.yaml` and `handoffs/orchestrator.log`.
- Documentation does **not** carry letflow's dated corpus-measurement justifications
  (grep counts, incident timestamps, ISS-number citations) — this project has no history
  to measure yet. Rules are stated with their reasoning in plain prose. Real incidents get
  logged in `docs/agents/anti-patterns.md` and new decision records as they actually
  happen, going forward — not backfilled or invented.
- Mechanics are adapted for this project's actual tooling: `npm run lint`/`npm run
  build`/dev-server checks stand in for `mix compile`/`mix test`; there is no
  multi-tenant security-invariants gate (no backend, no user data) until one exists (see
  `docs/agents/AGENT_SYSTEM.md` §7 for the trigger); Git/GitHub mechanics
  (`GIT_SETUP.md`/`GIT_MERGE.md`) are unchanged in shape since git itself doesn't differ
  by stack.
- The "system tracks the project" extension rule from the prior lightweight design
  survives unchanged (`docs/agents/AGENT_SYSTEM.md` §2/`ORCHESTRATOR.md` §5) — full
  rigor now does not mean the roster is frozen; a genuinely new domain of work still gets
  its own role/workflow when it shows up.

## Addendum, 2026-09-06 — GitHub branch protection makes the unified PR path structural

**Decided by:** the project owner directly, stated reason: *"unified PR path to master.
Automated, humanless development remains as one of the main project principles."*

Until this date, "every merge goes through a PR, no PR waits for human approval" (see
`core-directives.md`'s Humanless Operation section) was true because the pipeline always
behaved that way — nothing on GitHub's side enforced it. As of 2026-09-06, `master` in
`aiqadam/aiqadam-next` carries a GitHub branch protection rule:

| Rule | State |
|---|---|
| Pull request required before merging | on |
| Required approving reviews | **0** — this is the load-bearing number; it is what keeps merges humanless while still requiring the PR path |
| Required status check | `build` (lint + build + docker-build verification, from `.github/workflows/ci-cd.yml`) |
| Branch must be up to date with `master` before merge | on |
| Force-push to `master` | blocked |
| Deletion of `master` | blocked |
| Applies to repo admins too (`enforce_admins`) | **true** — no bypass, `--admin` included |

**Consequence for agents, stated plainly so this never reads as a surprise:** a direct
`git push origin master` will now be rejected by GitHub (`GH006: Protected branch update
failed`) regardless of who or what attempts it — this was verified directly, not assumed,
by attempting exactly that push and reading the real rejection. This is not a bug, a
misconfigured token, or a reason to retry with `--force` — it is the rule working as
intended. **No pipeline mechanics changed as a result**, and none needed to:
`docs/agents/protocols/GIT_MERGE.md`'s existing flow (branch → rebase → PR → wait for CI
→ `gh pr merge --squash --delete-branch`) already satisfies every one of these rules on
its own, because 0 required reviewers means "PR open, required check green" is already
sufficient for `gh pr merge` to succeed — the same call the protocol always made.

**If `gh pr merge` ever fails with a review-requirement or bypass-denied error where it
previously succeeded:** that is a signal the ruleset itself changed (reviewers raised
above 0, or `enforce_admins` altered), not a transient failure to retry past. Report it
to ORCH as a BLOCKER rather than working around it — per `core-directives.md`'s
Instruction Precedence, a safety/gate rule is never something a handoff's instructions
override, and a GitHub-enforced rule is exactly that kind of rule now.

**Why 0 reviewers rather than exempting admins instead:** the alternative considered was
leaving `enforce_admins` off, which would let a `gh pr merge --admin` bypass everything
else if a check were ever false-red. Rejected because the owner's stated reason for this
whole change was for the restriction to be structural, not conditional on nobody
exercising the escape hatch — an unexercised bypass is still a bypass.
