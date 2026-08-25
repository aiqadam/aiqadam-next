---
name: aiqadam-design
description: Use this skill to generate well-branded interfaces and assets for AI Qadam — the practitioner AI community for Central Asia. Contains essential design guidelines, OKLCH color tokens, typography (Geist / Inter / JetBrains Mono), CSS component classes, brand assets, and UI kit screens for the Events, People, and Build product surfaces.
user-invocable: true
---

Read the README.md file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, production screens), copy assets out and create static HTML files. Link `styles.css` as the single CSS entry point — it imports all tokens and components. Use `data-theme="dark"` on `<html>` to activate the dark theme.

If working on production code, read the token table in README.md, use CSS custom properties (`var(--primary)`, `var(--card)`, etc.), and reference the component CSS classes from `tokens/components.css`.

If the user invokes this skill without other guidance, ask what they want to build or design, ask focused questions about the surface (events page? profile? leaderboard?), and act as an expert designer who outputs either HTML artifacts or production code depending on the need.

## Key design decisions to always enforce

- **Brand teal only for brand** — `var(--primary)` / `#3CA29E` / `oklch(0.58 0.10 192)`. Never use it as a generic accent. No other brand colors.
- **No gradients** — solid surfaces only. Not even a subtle teal gradient.
- **Lucide icons only** — 2px stroke, 24×24, `stroke="currentColor"`. Never fill explicitly.
- **Three font families** — Geist (display), Inter (body), JetBrains Mono (meta/tags/times). No others.
- **OKLCH token names** — `var(--background)`, `var(--foreground)`, `var(--card)`, `var(--muted)`, `var(--border)`, `var(--primary)`, `var(--success)`, `var(--warning)`, `var(--destructive)`. Exact names from tokens/tokens.css.
- **Copy rules** — "AI Qadam" in prose (never hyphenated). Sentence case buttons. Title Case page headings. UPPERCASE MONO status labels.
- **No illustrations, no AI imagery** — documentary photography only, or no imagery.
- **Dense, functional tone** — no exclamation marks, no "delight" copy, no mascots. Enterprise tool aesthetics, not consumer SaaS.

## Event domain vocabulary

Status badges (mono, uppercase): `UPCOMING` · `LIVE` · `PAST` · `ONLINE` · `HACKATHON`
Attendee count label: `142 going` · `89 watching` (live) · `178 attended` (past)
Location format: `City · Venue name`
Time format: `18:30 · Tashkent · IT Park`
Speaker avatar initials: color-mixed backgrounds, no photos in mock data

## File locations

- CSS entry point: `styles.css` (imports tokens + components)
- Color tokens: `tokens/tokens.css`
- Component CSS classes: `tokens/components.css`
- Logo mark: `assets/logo-mark.svg`
- Full lockup: `assets/logo-full.svg`
- Component JSX: `components/primitives/*.jsx` and `components/domain/*.jsx`
- UI kit demo: `ui_kits/web/index.html`
