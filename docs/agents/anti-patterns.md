# Anti-Patterns Log

A running record of concrete process mistakes made on this project and their fixes.
Every role checks this file when relevant to their step (REVIEWER always does). No
entries yet — this project has no history. Append an entry the first time an agent
catches itself, or is caught, repeating a mistake worth remembering.

**Do not pre-write hypothetical entries.** An anti-pattern earns its place here by
actually having happened — a speculative entry ("might do X wrong") teaches nothing and
clutters the file every future reader has to scan. See `core-directives.md`'s "No
Speculation" — the same principle applies to this log's own contents.

## result.status set to a handoff-status value instead of a legal result value

**Date:** 2026-08-27
**Where:** WF02-REQ-001b, step-01 (CODE-DESIGNER)

CODE-DESIGNER wrote `result.status: "COMPLETED"` instead of one of
`HANDOFF_PROTOCOL.md`'s legal `result.status` values (`PASS|FAIL|PARTIAL|BLOCKED|
SKIPPED`) — conflating the handoff-lifecycle `status` field ("COMPLETED", which was
correctly set) with the separate `result.status` field, which records the *verdict* on
the work, not the handoff's lifecycle state. ORCH caught it by re-reading the handoff
before routing to the next gate and corrected it directly (the underlying design work
was sound, so this was a mechanical fix, not a rework cycle). Downstream steps and gates
key off `result.status` to decide PASS/FAIL routing, so a wrong value here could silently
misroute a run if not checked. No new rule needed beyond what's already written — this
is a reminder to actually re-read a completed handoff's `result.status` against the
legal-values table before treating the step as gated-PASS, rather than assuming the
producer got the schema right.

## ORCH stamped dispatch timestamps by incrementing convention, not the clock

**Date:** 2026-08-27
**Where:** WF02-REQ-001a and WF02-REQ-001b (both runs, worsening over the session)

ORCH wrote `created_at`/`started_at` on every dispatched handoff by mentally
incrementing a plausible-looking offset from the previous step (e.g. "+5 minutes") in
its own written response, instead of actually reading the real clock
(`date -u +"%Y-%m-%dT%H:%M:%SZ"`) at the moment of each dispatch, per
`HANDOFF_PROTOCOL.md` §1.2 and §3 and `core-directives.md`'s "Timestamps come from the
clock, never from memory." Because a subagent's own turn can take much longer
wall-clock time than the polite-sounding offset ORCH guessed, the drift compounded
across a long run: by WF02-REQ-001b's step-05 and step-04, the dispatch `created_at`/
`started_at` ORCH wrote was later than the receiving agent's own real `completed_at`
(read correctly from the actual clock) — a `completed_at` preceding `started_at`,
which `core-directives.md` explicitly calls out as forbidden. DOC-UPDATER caught it on
step-06 by cross-checking its own `date -u` output against the handoff's `started_at`
before proceeding, rather than silently working around it. ORCH corrected the one instance flagged
(step-06's `started_at`) with a plausible clock-consistent value and is recording this
here rather than silently patching every other affected file, since the drift is
real but not safety-critical (ordering metadata, not the artefacts themselves) and a
blanket retroactive rewrite of a whole run's timestamps risks introducing new
fabricated values in place of old ones.

**Fix going forward:** ORCH must actually run a clock-read command immediately before
writing `created_at`/`started_at` on every dispatch, not compose a plausible-sounding
timestamp inline while drafting the handoff JSON — the same rule every other role
already follows for its own `completed_at`.

## Entry format

```markdown
## <short title naming the mistake, not the fix>

**Date:** YYYY-MM-DD
**Where:** <run-id, or "general">

<What happened, concretely. What the fix was. What rule/doc now prevents it —
link to the file/section that was added or changed as a result.>
```

Entries are never deleted or rewritten once landed — this file is itself an append-only
audit trail, same discipline as `docs/status/requirement_status.yaml`. If a documented
anti-pattern is later found to be wrong or superseded, add a note under the original
entry stating so; don't remove the original.
