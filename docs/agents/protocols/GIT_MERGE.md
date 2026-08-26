# GIT_MERGE Protocol

**Read by:** `FRONTEND-DEV`
**Used in:** WF-02 Step Final, WF-03 Step Final

## Purpose

Rebases the feature branch onto current `master`, opens a PR, merges it, and cleans up —
unconditionally, with no human review step, because every pipeline gate (lint, build,
REVIEWER, RELEASE-VALIDATOR) has already passed before this step runs. Per
`docs/agents/decisions/0001-full-pipeline-adopted.md`, this is by design.

## Precondition

CI must be green for this protocol's PR-checks step to mean anything. See
[.github/workflows/ci-cd.yml](../../../.github/workflows/ci-cd.yml) — the `build` job
runs `npm run lint` and `npm run build` on every push/PR. **This project has no
standing set of pre-existing lint/build failures** (unlike a large legacy codebase) —
"green" here should mean genuinely zero failures on the `build` job, not "zero
failures attributable to this branch." If you find a pre-existing failure on `master`
itself, that is a real regression to fix or file, not a baseline to tolerate around.

## Procedure

```
1. Verify current branch:
   git branch --show-current
   Must equal feature/<run-id>. If not: STOP; report FAIL to ORCH.

2. Stage any remaining uncommitted files (test reports, handoffs written by downstream
   agents since the implementing agent's own commit) by explicit filename -- never
   `git add -A`:
   git status
   git add <file1> <file2> ...
   If `git status` shows a clean tree, skip to step 4.

3. Commit remaining artifacts:
   git commit -m "feat(<run-id>): finalize artifacts -- test reports, status

   Requirements: <comma-separated requirement IDs>
   Handoff: <run-id>"

   For WF-03 fix branches use prefix "fix" instead of "feat".

4. Sync with remote:
   git fetch origin master

5. Rebase onto origin/master:
   git rebase origin/master

   -- CONFLICT HANDLING --
   a. Count conflicted files:
      git diff --name-only --diff-filter=U | wc -l

      If count > 5:
        git rebase --abort
        -> complete-handoff(status: FAIL,
            issues: [{severity: BLOCKER,
                      description: "merge conflict too complex for inline resolution: <files>"}],
            next_action: "ORCH escalates to CODE-DESIGNER for conflict resolution")
        STOP

   b. For each conflicted file (<=5 files):
      - Read HEAD version and incoming version
      - Apply the correct resolution (preserve valid changes from both sides)
      - git add <file>

      Note: `git checkout --ours`/`--theirs` is INVERTED during `git rebase` compared to
      `git merge`. During rebase, `--ours` = the commit you're rebasing ONTO (master),
      `--theirs` = your own commit being replayed -- opposite of merge's meaning. Read the
      actual conflict markers and hand-resolve rather than reaching for either flag from
      merge-trained habit.

      SEMANTIC conflicts: a textual conflict marker means git couldn't merge two
      overlapping edits automatically. A semantic conflict is different in kind -- both
      sides may have rewritten the SAME component/function in incompatible ways with no
      textual overlap at all. Recognize it by asking, for every component/function
      changed on either side: did the OTHER side also touch this one's contract, even
      without a textual marker? If yes, compose both intents into one correct
      implementation rather than picking a side, then verify by re-running lint/build
      and visually checking the merged result under the specific condition that would
      expose a wrong resolution.

   c. git rebase --continue

   d. Verify the build still passes:
      npm run lint
      If FAIL: fix, git add <file>, git rebase --continue
      npm run build
      If FAIL: fix build errors, git add <file>, git rebase --continue

      If FAIL and not fixable within this step:
        -> complete-handoff(status: FAIL,
            issues: [{severity: BLOCKER, description: "lint/build failed after rebase"}])
        ORCH routes to ISSUE-FIXER; after PASS, return to step 5
   -- END CONFLICT HANDLING --

6. Push branch to remote:
   git push origin feature/<run-id>

   Non-fast-forward here is the NORMAL case whenever step 5's rebase actually replayed
   at least one commit -- GIT_SETUP.md step 7 already pushed the pre-rebase tip, and the
   rebase rewrote every commit since. Don't force pre-emptively -- try the plain push
   first and only act on an actual rejection.

   If rejected: git push --force-with-lease origin feature/<run-id> -- never bare
   --force. This covers ONLY the run's own feature/<run-id> branch, never master.

7. Create PR:
   gh pr create \
     --title "feat: <one-line summary> [<run-id>]" \
     --body "## Summary
<last-agent result.summary>

## Requirements
<comma-separated requirement IDs>

## Validation
- npm run lint: PASS
- npm run build: PASS
- Manual verification: <pass/fail summary, per test-reports/report-<date>-<run-id>.yaml>
- REVIEWER: PASS
- RELEASE-VALIDATOR: PASS

## Handoffs
handoffs/<run-id>/" \
     --base master \
     --head feature/<run-id>

   For WF-03 branches use --title "fix: <one-line summary> [<run-id>]"

   If `gh` is unavailable (no auth, no network): record git_evidence.pr_create_error,
   skip to step 9 with the branch left pushed but unmerged, and set result.status =
   PARTIAL -- ORCH must not treat this as silent success.

8. Wait for CI, then merge PR (all gates already passed):
   gh pr checks <PR> --watch
   gh pr merge --squash --delete-branch

9. Local cleanup -- return to master (MANDATORY):
   git checkout master
   git pull --ff-only origin master
   git branch -d feature/<run-id>

   Verify:
   git branch --show-current   # must output: master
   git log --oneline -1        # must show the squash-merge commit from step 8
   git status                  # must show a clean working tree

   If any check fails: report as FAIL with details.

10. -> complete-handoff(status: PASS,
      artifacts_out: ["branch: feature/<run-id> (squash-merged into master, branch deleted)"],
      next_action: "ORCH marks run COMPLETED")
```

## Acceptance criteria

- [ ] `gh pr merge` exited 0 (or PARTIAL was correctly reported if `gh` unavailable)
- [ ] `git branch --show-current` is `master`
- [ ] `git pull --ff-only` on master after merge exited 0
- [ ] `git log --oneline -1` shows the squash-merge commit
- [ ] `git status` shows a clean working tree

## Worktree variant

Applies whenever this checkout is a secondary `git worktree` — `git worktree list` shows
more than one entry.

**Step 8**: `gh pr merge --squash --delete-branch` partially fails by design here — the
GitHub-side merge succeeds via the API, then `gh`'s local side effect of switching this
checkout to `master` errors. Verify before treating this as FAIL:

```
gh pr view <n> --json state,mergedAt
```

If `"state":"MERGED"`, the merge landed — ignore the local checkout error, continue, then
delete both refs explicitly:

```
gh api -X DELETE repos/{owner}/{repo}/git/refs/heads/feature/<run-id>
git branch -d feature/<run-id>
```

**Step 9**: replace with:

```
9w. git fetch origin master --prune
    git checkout --detach origin/master
```

Verify instead with:

```
git rev-parse HEAD                # must equal:
git rev-parse origin/master        # (HEAD at the fetched merge commit)
git log --oneline -1               # must show the squash-merge commit
git status                         # clean working tree, "HEAD detached" expected
```

## Conflict escalation

When this step FAILs due to a complex conflict (>5 files), ORCH routes to CODE-DESIGNER
to produce the correct merged content for each conflicting file, then FRONTEND-DEV
applies it and re-attempts from step 5. `rework_count` applies; `max_rework = 3` before
ESCALATED.
