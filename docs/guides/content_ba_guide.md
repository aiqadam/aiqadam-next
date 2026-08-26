# Content & Requirements (BA) Guide

Audience: CONTENT-BA, FRONTEND-DEV.

## 1. What this role covers

Drafting and validating copy, section briefs, and content changes before they're built —
checking them against the AI Qadam brand voice, not just correctness. For this project's
current size (one landing page, no CMS, no multi-stakeholder requirement pipeline), this
role also stands in for a formal BA/requirements function: a "brief" here is whatever a
requirement doc would be in a larger system.

Full source of truth for everything in this guide: the "Content fundamentals" section of
the [design system readme](../Design%20system%20for%20AI%20agents/readme.md) — this
guide summarizes it for quick reference; that file is canonical if they ever diverge.

## 2. The seven voice principles

All copy answers to these (from the community manifesto):

1. Honesty over hype — never promote what doesn't exist or lacks expert backing.
2. Practice over theory — real cases, not polished frameworks.
3. Quality over reach — depth over vanity metrics.
4. The right to fail — failures can be discussed openly, not hidden.
5. Community, not channel — partners invest in people, not ad space.
6. Multilingual by default — Russian, Uzbek, Kazakh, Kyrgyz, Tajik, English, equal weight.
7. People first — copy serves participants, not monetization.

## 3. Tone

Functional, operator-facing — closer to a tool than a consumer brand. No exclamation
marks, no slogans, no "delight" copy, no mascots, no AI-generated-sounding clichés. Error
messages are factual sentences. Empty states get a concrete call-to-action, never a
cheerful non-answer or decorative illustration.

## 4. Mechanical copy rules (check every draft against these)

- **Name**: "AI Qadam" in prose (Title case, two words, no hyphen). "AI QADAM" only
  inside SVG lockups. Never "AI-Qadam," "AIQadam," "ai qadam," or "AI Kadam."
- **Casing**: sentence case for buttons/menu items ("Register for event"); Title Case for
  page titles mapping to a domain noun ("Computer Vision Day"); UPPERCASE MONO for status
  labels (`UPCOMING`, `LIVE`, `PAST`).
- **Domain vocabulary** (use verbatim, don't invent synonyms): Event, Chapter, Talk,
  Speaker, CFP, Agenda, Check-in, Going, Watching.
- **Tech tags**: `#`-prefixed, title-case, hyphenated for multi-word (`#LLM`, `#RAG`,
  `#Computer-Vision`).
- **Emoji**: none in product copy, except country flags in leaderboard/country-switcher
  contexts and 🔥 for streak badges specifically.
- **Languages**: draft with Russian and English both in mind — don't write
  English-only copy and treat translation as an afterthought; avoid US-centric idioms.

## 5. Known pitfall: empty-array copy

Any inline `array.join(', ')` interpolated into a sentence needs an empty-value
fallback — an empty array silently renders as a stray comma/period (e.g. "You're being
added as ."). Wrap with a fallback phrase when briefing dynamic/templated copy that
depends on a list that could be empty — see the design system readme's copy rules for
the pattern.

## 6. Handing off to CODE-DESIGNER / FRONTEND-DEV

A ready brief states: the section/page it's for, the actual copy (not a description of
what the copy should convey), any images/data needed and where they come from, and which
of the four product streams (Events / People / Education / Accelerator) or Build it
belongs to if relevant to tone. Vague direction ("make the hero more exciting") isn't a
brief — turn it into actual copy before handing off.

## 7. Drafting a requirement (acting as REQ-ANALYST)

For a content-primary requirement, draft it directly into
`docs/agents/requirements.yaml` per
`docs/agents/workflows/WF-01_requirement_development.md` Step 1 — same schema and gate
(REQ-VALIDATOR) as any other requirement. Content-primary means the work is fundamentally
about copy/messaging, not new component structure; a requirement needing both gets
drafted with `owner: FRONTEND-DEV` and this guide informs the content parts of its
acceptance criteria.
