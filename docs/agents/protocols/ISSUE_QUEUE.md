# ISSUE_QUEUE Protocol

**Read by:** every agent
**Used in:** any step that discovers a defect outside its own current scope

## Purpose

A run does one job and does it completely: git-setup once, the run's own steps,
git-merge once. A defect discovered *incidentally* — not the thing the run was
dispatched to fix — is filed and forwarded to become its own later run, rather than
silently expanding the current run's scope or being dropped.

This is distinct from `core-directives.md`'s Unblock-Everything directive: that covers
defects that block *this run's own* acceptance criteria (fix them now, in this run).
This protocol covers defects that are merely adjacent — noticed, not blocking.

## id allocation — no external queue

Unlike letflow, this project has no external service atomically allocating issue ids
(see `docs/agents/AGENT_SYSTEM.md` §7 — deferred until concurrent multi-session work is
real). **ORCH allocates ids by checking the highest existing `ISS-NNNN` under
`docs/issues/` and incrementing.** This is a real, acknowledged race if two ORCH sessions
file simultaneously — acceptable risk at this project's current single-session scale. If
concurrent sessions become routine, adapt letflow's `letflow-queue` atomic-allocation
pattern rather than tolerating collisions (see `ORCHESTRATOR.md` §8).

## Procedure

```
1. The discovering agent reports the finding to ORCH (title, description, severity,
   affected_files) -- it does not pick a number or write the file itself.

2. ORCH allocates the next ISS-NNNN by checking docs/issues/ for the highest existing
   number and incrementing (zero-padded to 4 digits, e.g. ISS-0001, ISS-0012).

3. ORCH writes docs/issues/<ISS-NNNN>.yaml:
   id: <ISS-NNNN>
   title: <one-line summary>
   discovered_by: <AGENT_ID>
   discovered_in_run: <run-id>
   discovered_at: <UTC timestamp from the clock>
   severity: BLOCKER | MAJOR | MINOR
   description: >
     <what's wrong, where, and why it matters>
   affected_files:
     - <path>
   status: open

4. If the finding should be visible outside this repo's own bookkeeping (e.g. it affects
   the live site), also open a GitHub issue and record its number:
   gh issue create --title "<ISS-NNNN>: <title>" --body "<description>

   Discovered by <AGENT_ID> during <run-id>."
   Record the returned issue number in the yaml as github_issue: <n>.

5. Commit docs/issues/<ISS-NNNN>.yaml as part of the current step's normal commit.

6. Do NOT extend the current run to fix it. Do NOT launch a nested workflow. The
   current step's own PASS/FAIL verdict is unaffected by an incidentally-discovered
   issue -- only issues that ARE the current step's own failure drive that step's rework.
```

## Issue status vocabulary

`docs/issues/ISS-NNNN.yaml`'s `status:` field — the canonical list:

- `open` — filed, not yet being worked.
- `in_progress` — a run has picked it up and is working it.
- `resolved` — **a root cause was actually removed**, and a regression check proves it
  (see WF-03 Step 4). Shipping useful, verified work is *not* the same thing.
- `instrumented` — the run built and verified real improvements, and that run's own
  acceptance criteria were met, but the underlying defect's **root cause is not removed**.
  MUST carry `superseded_by: ISS-NNNN` naming the successor issue with the remaining
  work — file that successor before transitioning the record.
- `no_defect` — **investigated and measured, and there was no root cause there to
  remove.** Terminal, like `resolved`, but asserts a different thing. MUST carry, citing
  the closing run's diagnosis: (1) the first-hand check that was run, with real output;
  (2) the specific candidate mechanisms tested, each with its result — including what was
  looked for and not found; (3) the stated limitations of the method; (4) the run-id and
  timestamp under `verdict_in_run:`/`verdict_at:` (not `resolved_*`, which would assert a
  resolution that didn't happen).

An issue nobody investigated cannot reach `no_defect` — with nothing to cite under (1)-(3)
there's nothing to write, and it stays `open`.

## Closing an issue's GitHub mirror — evidence is mandatory

`WF-03_issue_resolving.md` Step 5 owns the close procedure; this section states the rule
it implements. A `gh issue close` on any issue this protocol tracks — and any local
status flip to a terminal value — MUST carry either:

1. a `--comment` on the GitHub issue citing the resolving evidence (the run-id, the
   `docs/issues/ISS-NNNN.yaml` record, and — for `resolved` only — the regression check
   that proves it), or
2. a genuinely linked/merged PR with a `Closes`/`Fixes` reference in the issue's own
   GitHub timeline.

A closure carrying neither is undocumented, not merely under-documented.

## Never delete an issue file

It is the audit trail of what was found and when it was fixed — same append/never-rewrite
spirit as `docs/status/requirement_status.yaml`.
