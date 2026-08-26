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
