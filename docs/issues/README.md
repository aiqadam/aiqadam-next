# Issue Registry

One `ISS-NNNN.yaml` file per issue, written per
[docs/agents/protocols/ISSUE_QUEUE.md](../agents/protocols/ISSUE_QUEUE.md). No entries
yet — this directory is empty until the first defect is filed.

## id allocation

No external queue service mediates this project (see
[docs/agents/AGENT_SYSTEM.md](../agents/AGENT_SYSTEM.md) §7 — deferred until multi-session
concurrent work is real). Ids are assigned by ORCH, sequentially, by checking the highest
existing `ISS-NNNN` across this directory before writing a new one. This is a real,
acknowledged race if two ORCH sessions ever file simultaneously — acceptable at
single-session scale; revisit (see letflow's `letflow-queue` atomic-allocation pattern)
if concurrent sessions become real.

## Schema

```yaml
id: ISS-NNNN
title: <one-line summary>
discovered_by: <AGENT_ID>
discovered_in_run: <RUN-ID>
discovered_at: <ISO8601-UTC>
severity: BLOCKER | MAJOR | MINOR
description: >
  <what's wrong, where, and why it matters>
affected_files:
  - <path>
status: open | in_progress | resolved | instrumented | no_defect
```

See ISSUE_QUEUE.md for the full status vocabulary and evidence requirements for each
terminal state.
