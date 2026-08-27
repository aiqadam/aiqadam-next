# 0002 — CONTENT-BA writes translation content directly into `messages/*.json`

**Date:** 2026-08-27
**Status:** Decided
**Context:** WF02-REQ-002 (writing real Uzbek translations for the i18n message catalogs
introduced by REQ-001a/REQ-001b)

## The ambiguity

`.claude/agents/content-ba.md` forbids CONTENT-BA from "implementing anything in `src/`
— that's FRONTEND-DEV's, even for a pure copy change." `.claude/agents/frontend-dev.md`
states FRONTEND-DEV owns `src/`, `public/`, and git setup/merge for every WF-02/WF-03
run. Neither role file says who writes into `messages/*.json` — a translation catalog
that is genuinely content (natural-language strings, not code), lives outside `src/`
and `public/`, but is nonetheless a file the built application reads at runtime.

Two options were considered:
1. CONTENT-BA writes `messages/uz.json` directly, gated by REVIEWER.
2. CONTENT-BA drafts translations into a content brief doc; FRONTEND-DEV copies them
   into the actual JSON file as an implementation step.

## Decision

**Option 1.** `messages/*.json` is treated as content data, the same category as
`docs/agents/requirements.yaml` (which CONTENT-BA already writes to directly per
`AGENT_SYSTEM.md` §4's roster table) — not as `src/`/`public/` application code.
CONTENT-BA writes translations directly into `messages/uz.json`. FRONTEND-DEV's
ownership is unaffected: it still does git setup (Step 00) and git merge (Step Final)
for the run, and remains the only role that touches `src/`/`public/`.

For a content-primary requirement with no new component/prop/structural design (as
REQ-002 is — it fills in existing keys established by REQ-001a/REQ-001b, no new UI),
Steps 1/1b (CODE-DESIGNER / CODE-DESIGN-VALIDATOR) are skipped as inapplicable, the
same way WF-02 Step 3's own scope test already skips Steps 3b/4 for a docs-only
requirement. CONTENT-BA's content-writing step is gated by REVIEWER instead — REVIEWER
already checks copy against the design system's casing/vocabulary/tone rules per its
existing checklist, so this isn't a new validator responsibility, just the existing one
applied without a preceding design-artefact step.

## Rationale

- `messages/*.json`'s content is exactly what CONTENT-BA is chartered to produce
  (natural-language copy following brand voice/casing/vocabulary rules) — routing it
  through FRONTEND-DEV as a copy-paste intermediary adds a mechanical step with no
  quality benefit and a transcription-error risk (174+ string values moved by hand
  between a brief and a JSON file).
- FRONTEND-DEV's `src/`/`public/` boundary is preserved exactly as written — a JSON
  data file consumed by `next-intl` at request time is not "implementing" anything in
  the sense the boundary is protecting against (component structure, business logic,
  build configuration).
- Keeps the same pattern already established for `docs/agents/requirements.yaml`: a
  role writes the content type it's chartered for, directly, rather than through a
  second role as a formality.

## Consequence for future work

Any future requirement that is pure-copy against an already-built structure (a content
correction, a new locale's translations, a copy-only A/B variant) should route its
content-writing step to CONTENT-BA writing directly into the relevant content/data file
(not `src/`/`public/`), gated by REVIEWER, with FRONTEND-DEV retained for git
setup/merge only and CODE-DESIGNER/CODE-DESIGN-VALIDATOR skipped as inapplicable when no
structural design decision exists. If a future requirement mixes new structure AND new
copy, the CODE-DESIGNER/CODE-DESIGN-VALIDATOR step still applies for the structural part
before content is written.
