# GIT_SETUP Protocol

**Read by:** `FRONTEND-DEV`
**Used in:** WF-02 Step 00, WF-03 Step 00

## Purpose

Creates the feature branch before any file changes are made, and pushes it immediately
as a coordination signal.

## Branch naming convention

```
feature/<run-id>
```

Examples: `feature/WF02-REQ003-20260825`, `feature/WF03-ISS0001-fix-20260825`.

One branch per run-id.

## Procedure

```
1. git checkout master

2. git pull --ff-only origin master
   If FAIL (non-fast-forward): STOP.
   -> complete-handoff(status: FAIL, issues: [{severity: BLOCKER,
       description: "local master has diverged from origin -- needs resolution before
       any run can branch from it"}])
   Do not proceed until resolved. ORCH escalates -- this blocks every future run.

3. Branch name = feature/<run-id> (supplied by ORCH in context.branch_name)

4. If the branch already exists from a prior aborted run:
   git branch -D feature/<run-id>

5. git checkout -b feature/<run-id>

6. Verify: git branch --show-current  ->  must equal feature/<run-id>

7. Push immediately (coordination signal):
   git push -u origin feature/<run-id>

8. -> complete-handoff(status: PASS,
     artifacts_out: ["branch: feature/<run-id>"],
     next_action: "ORCH routes to next step per active workflow")
```

## Acceptance criteria

- [ ] `git pull --ff-only` exited 0
- [ ] `git branch --show-current` outputs `feature/<run-id>`
- [ ] `git push -u origin feature/<run-id>` exited 0

## Worktree variant

Applies whenever this checkout is a secondary `git worktree` sharing one `.git` with a
primary checkout that holds local `master` — check with `git worktree list` before
starting.

Replace steps 1-2 with:

```
1w. git fetch origin master

2w. git checkout -b feature/<run-id> origin/master
```

Steps 3-8 are unchanged.
