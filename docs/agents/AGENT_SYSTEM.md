# AI Qadam Next — Agent System Overview

## 1. Purpose

This project is a Next.js marketing/community site for AI Qadam. It runs a full
producer/validator agent pipeline, adapted from the sibling project `letflow`'s pattern
and sized for this project's actual tooling (npm/Next.js, no backend, no multi-tenant
data) — see [decisions/0001-full-pipeline-adopted.md](decisions/0001-full-pipeline-adopted.md)
for why the full pattern was adopted rather than a lighter one, and what was deliberately
left out.

## 2. Core principle: every producing step has a validating step

**No agent's claim that it finished a task is itself evidence that the task is done.**
Every role that produces an artefact is paired with a role that independently checks it
before the pipeline advances — a validator that only reads the producer's summary and
says PASS has not validated anything, it has copied a claim. See
[instructions/core-directives.md](instructions/core-directives.md) for the full
statement of this rule and what "independently re-derive" means in practice.

| Produces | Validates |
|---|---|
| REQ-ANALYST (requirement text) | REQ-VALIDATOR |
| CODE-DESIGNER (design artefact) | CODE-DESIGN-VALIDATOR |
| FRONTEND-DEV (`src/`, `public/`) | REVIEWER |
| TEST-DESIGNER (test/checklist specs) | TEST-DESIGN-VALIDATOR |
| TEST-RUNNER (verification run + report) | RELEASE-VALIDATOR re-verifies independently, does not trust the report alone |
| DOC-UPDATER (status/doc updates) | ORCH verifies the specific files/fields changed, per the handoff's `artifacts_out`, before logging the run done |

## 3. The system tracks the project

Every role exists because the project currently has work that role covers. When the
project gains a genuinely new domain of work — a backend/API layer, a new framework, a
CMS, a second product surface, an auth system — **the agent system must be extended to
cover it**, not stretched to pretend an existing role already does. This is ORCH's
standing responsibility (see [ORCHESTRATOR.md](ORCHESTRATOR.md) §7), re-checked on every
request, not a one-time setup task.

Concretely:
- A new domain of work gets its own subagent under `.claude/agents/`, a guide under
  `docs/guides/` if it accumulates enough substance, and a workflow under
  `docs/agents/workflows/` if it changes how work moves.
- A small addition (one new component, one new page) stays inside FRONTEND-DEV's
  existing scope — a new role is for a new *domain*, not a bigger instance of an
  existing one.
- Record the trigger as a new file under `decisions/` when the addition is architecturally
  significant (a new stack, a new data-handling surface); a routine roster addition just
  needs a one-line note in the new role file itself.

## 4. Agent roster

| AGENT_ID | Role | Responsibility | May write to |
|---|---|---|---|
| ORCH | Orchestrator | Routes work, enforces gates, owns handoff/bookkeeping mechanics, extends the system as the project grows. Default role when none is stated. | `handoffs/**`, `docs/agents/requirements.yaml` (status/impl fields only), `docs/status/requirement_status.yaml` (append) |
| REQ-ANALYST | Requirement Analyst | Drafts new requirements into `docs/agents/requirements.yaml`. Writes requirement text only. | `docs/agents/requirements.yaml` (new entries) |
| REQ-VALIDATOR | Requirement Validator | Hard gate on REQ-ANALYST — testability, consistency, sizing, dependency correctness. | none (review only) |
| CODE-DESIGNER | Code/Content Designer | Produces the design artefact (component structure, props/types, content shape) before implementation. Design docs only — no implementation code. | `docs/agents/design/**` |
| CODE-DESIGN-VALIDATOR | Design Validator | Hard gate on CODE-DESIGNER — every acceptance criterion maps to a concrete design element, no implementation code present. | none (review only) |
| FRONTEND-DEV | Frontend Developer | Builds and changes `src/`, `public/` per the design artefact and the AI Qadam Design System. | `src/**`, `public/**` |
| REVIEWER | Reviewer | Hard gate on FRONTEND-DEV — design-system compliance, code quality, scope creep, consistency with `decisions/`. | none (review only) |
| CONTENT-BA | Content & Requirements | Drafts/validates copy against brand voice; may also act as REQ-ANALYST for content-shaped requirements. | `docs/agents/requirements.yaml` (content entries) |
| TEST-DESIGNER | Test Designer | Writes test/verification specs (manual checklists today; automated test code once a framework exists) for a change that passed REVIEWER. | `docs/agents/test-specs/**`, test code once a framework exists |
| TEST-DESIGN-VALIDATOR | Test Design Validator | Hard gate on TEST-DESIGNER — every acceptance criterion has a runnable check, no coverage gaps. | none (review only) |
| TEST-RUNNER | Test Runner | Executes the verification (lint/build/manual checklist, or automated suite once one exists), reports pass/fail with real output. | `test-reports/**` |
| RELEASE-VALIDATOR | Release Validator | Independently re-verifies acceptance criteria before a requirement is marked done — re-runs the checks itself, doesn't trust TEST-RUNNER's report alone. | `docs/status/**` (release records) |
| DOC-UPDATER | Documentation Updater | Flips requirement status, appends the status-history event, updates docs when behavior changed. | `docs/agents/requirements.yaml` (status field), `docs/status/requirement_status.yaml` (append), `README.md` |
| ISSUE-FIXER | Issue Fixer | Diagnoses root cause of a reported/discovered defect. Diagnosis only — routes to CODE-DESIGNER/FRONTEND-DEV for the fix. | `docs/issues/**` |

There is no dedicated backend, mobile, or DevOps role yet because none of that exists in
the project — see §3. `SECURITY-REVIEWER` from letflow's pattern is likewise not present:
this is a static site with no tenant data, auth, or user input handling to gate. The
first backend/user-data feature is the trigger to add one (see §3 and §7 below).

## 5. How work moves

Work moves via **committed handoff files**, same mechanism as letflow, minus the external
queue service — see [shared/HANDOFF_PROTOCOL.md](shared/HANDOFF_PROTOCOL.md) for the full
lifecycle and JSON schema. In short: ORCH writes a `PENDING` handoff file under
`handoffs/<RUN-ID>/`, commits it, then dispatches the receiving role; the receiving role
claims it, does the work, and writes its own `result` block before completing.

Task **selection** (which requirement to work on next) is read directly from
`docs/agents/requirements.yaml`'s `status` field by ORCH — there is no external queue
mediating this, unlike letflow. See §7 for why, and the trigger for revisiting it.

## 6. Artifact locations

| Artifact | Location | Owner |
|---|---|---|
| Application code | `src/` | FRONTEND-DEV |
| Static assets | `public/` | FRONTEND-DEV |
| Design system reference | `docs/Design system for AI agents/` | external source, read-only to every role |
| Design artefacts | `docs/agents/design/` | CODE-DESIGNER |
| Test/verification specs | `docs/agents/test-specs/` | TEST-DESIGNER |
| Test/verification reports | `test-reports/` | TEST-RUNNER |
| Requirements registry | `docs/agents/requirements.yaml` | REQ-ANALYST (draft), DOC-UPDATER (status) |
| Requirement status history | `docs/status/requirement_status.yaml` | ORCH, DOC-UPDATER (both append-only) |
| Release validation records | `docs/status/` | RELEASE-VALIDATOR |
| Issue registry | `docs/issues/` | ISSUE-FIXER (diagnosis), ORCH (id allocation) |
| Handoff files | `handoffs/<RUN-ID>/` | ORCH (creates), receiving role (completes) |
| Handoff registry/log | `handoffs/registry.json`, `handoffs/orchestrator.log` | ORCH (both append-only) |
| Decision records | `docs/agents/decisions/` | ORCH |
| Anti-patterns log | `docs/agents/anti-patterns.md` | whoever catches the mistake, via ORCH |
| Deployment scripts/config | `deploy/`, `Dockerfile` | FRONTEND-DEV (until a dedicated DevOps role exists — see §3) |
| Role guides | `docs/guides/` | whoever's guide it is, kept current by that role |

## 7. What this system deliberately does not have (yet)

- **External task-claiming queue** (letflow's `letflow-queue`) — needed once multiple
  sessions work this repo concurrently and a file-read-then-write race on
  `requirements.yaml`'s status field becomes a real risk, not a theoretical one. Until
  then, ORCH reading and writing that file directly is the mechanism, and it is a single
  point of coordination because there is, in practice, one active session.
- **Security invariants gate** — needed once there's a backend with auth, user data, or
  tenant isolation to gate. Add a `SECURITY-REVIEWER` role and an
  `instructions/security-invariants.md` doc at that point, not before.
- **Automated test framework / real TEST-RUNNER automation** — `package.json` has no test
  runner today. TEST-DESIGNER/TEST-RUNNER operate against manual checklists (see
  [guides/qa_testing_guide.md](../guides/qa_testing_guide.md)) until one is introduced;
  see decision record trigger in §3.
- **Volume-rolling for `requirement_status.yaml`** — letflow splits its run-history file
  into bounded volumes once it grows large. This project's file starts empty; add a roll
  rule only once a full read genuinely becomes impractical (see the file's own header).

## 8. Canonical instruction surfaces

| Category | Canonical file |
|---|---|
| Cross-cutting behavioral rules, instruction precedence | [instructions/core-directives.md](instructions/core-directives.md) |
| Handoff lifecycle and JSON schema | [shared/HANDOFF_PROTOCOL.md](shared/HANDOFF_PROTOCOL.md) |
| Routing logic, sizing rule, rework/escalation | [ORCHESTRATOR.md](ORCHESTRATOR.md) |
| Git branch/merge mechanics | [protocols/GIT_SETUP.md](protocols/GIT_SETUP.md), [protocols/GIT_MERGE.md](protocols/GIT_MERGE.md) |
| Incidentally-discovered defects | [protocols/ISSUE_QUEUE.md](protocols/ISSUE_QUEUE.md) |
| Visual design, tokens, components, copy rules | [Design system for AI agents/readme.md](../Design%20system%20for%20AI%20agents/readme.md) |
| Frontend build/run/lint mechanics | [guides/frontend_developer_guide.md](../guides/frontend_developer_guide.md) |
| Manual verification process | [guides/qa_testing_guide.md](../guides/qa_testing_guide.md) |
| Content/copy/requirement drafting | [guides/content_ba_guide.md](../guides/content_ba_guide.md) |
| Deploy mechanics | [guides/deploy_guide.md](../guides/deploy_guide.md) |
| Standing decisions | [decisions/](decisions/) |
| Process mistakes and their fixes | [anti-patterns.md](anti-patterns.md) |
