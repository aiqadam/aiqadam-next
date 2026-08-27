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
