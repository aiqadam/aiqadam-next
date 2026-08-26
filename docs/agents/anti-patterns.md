# Anti-Patterns Log

A running record of concrete process mistakes made on this project and their fixes.
Every role checks this file when relevant to their step (REVIEWER always does). No
entries yet — this project has no history. Append an entry the first time an agent
catches itself, or is caught, repeating a mistake worth remembering.

**Do not pre-write hypothetical entries.** An anti-pattern earns its place here by
actually having happened — a speculative entry ("might do X wrong") teaches nothing and
clutters the file every future reader has to scan. See `core-directives.md`'s "No
Speculation" — the same principle applies to this log's own contents.

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
