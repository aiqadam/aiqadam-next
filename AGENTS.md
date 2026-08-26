<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Agent system

This project runs a full producer/validator agent pipeline — every producing step
(design, implementation, requirement drafting, test design) is gated by an independent
validating step before the pipeline advances, and work moves via committed handoff files
under `handoffs/`. Before doing any non-trivial task, read
[docs/agents/AGENT_SYSTEM.md](docs/agents/AGENT_SYSTEM.md) — it names the full roster
(`.claude/agents/`), the workflows (`docs/agents/workflows/`), and the role guides
(`docs/guides/`), and states the standing rule that the system must be extended (new
role/workflow/guide) whenever the project gains a genuinely new domain of work, rather
than force-fitting new kinds of work into existing roles.

Default entry point: `docs/agents/ORCHESTRATOR.md`. Cross-cutting rules binding every
role (humanless operation, instruction precedence, no speculation, no background waits):
`docs/agents/instructions/core-directives.md`. Handoff mechanics:
`docs/agents/shared/HANDOFF_PROTOCOL.md`. Brand/visual reference for any frontend work:
[docs/Design system for AI agents/readme.md](docs/Design%20system%20for%20AI%20agents/readme.md).
Why this scale was chosen: [docs/agents/decisions/0001-full-pipeline-adopted.md](docs/agents/decisions/0001-full-pipeline-adopted.md).
