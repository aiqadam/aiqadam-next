# AI Qadam Design System

> The canonical brand and design reference for AI Qadam — the AI community infrastructure for Central Asia (Uzbekistan, Kazakhstan, Kyrgyzstan, Tajikistan, and the broader Turkic world).

**Start here.** This readme is the primary reference for AI agents building, editing, or extending any AI Qadam product surface.

---

## Sources

| Source | Description |
|---|---|
| `https://brand.aiqadam.org/` | Canonical brand + design system docs |
| `https://brand.aiqadam.org/brand.html` | Pillar 1 — Brand: identity, voice, logo, colour, typography |
| `https://brand.aiqadam.org/system.html` | Pillar 2 — Design system: tokens, components, domain patterns, mockups |
| `https://github.com/aiqadam/brand.aiqadam.org` | Source repo (MIT code, custom brand license for assets) |
| `tokens/tokens.css` | OKLCH token definitions (light + dark), fonts, radii, shadows |
| `tokens/components.css` | CSS class definitions for all primitives |

---

## Products represented

**AI Qadam** is a practitioner-run AI community platform. *Qadam* means "step forward" in Turkic languages. Four streams share this design system:

1. **Events** — Country-specific meetup sites (`uz.aiqadam.com`, `kz.aiqadam.com`, …). The most fully specified surface. Event listings, event detail pages, speaker CFP, agenda, registration, check-in.
2. **People** — Member profiles, leaderboard, badge showcase, streaks, activity feed.
3. **Education** — Learning resources. Uses Events UI patterns.
4. **Accelerator** — Early-stage AI startups from the region.

Plus **Build** — the open-source infrastructure layer. Build projects carry the AI Qadam Build badge (footprint mark + "an AI Qadam Build project" in mono caps, links to `https://build.aiqadam.org`).

---

## Content fundamentals

### Voice & principles

Seven principles from the community manifesto — all copy and design decisions answer to these:

1. **Honesty over hype** — No promoting what doesn't exist or lacks expert backing.
2. **Practice over theory** — Speakers share what they did themselves. Real cases beat polished frameworks.
3. **Quality over reach** — 80 engaged people > 500 indifferent ones.
4. **The right to fail** — Failures discussed openly. Post-mortems teach more than success stories.
5. **Community, not channel** — Partners invest in people, not buy ad space.
6. **Multilingual by default** — Russian, Uzbek, Kazakh, Kyrgyz, Tajik, English — equal weight.
7. **People first** — Exists for participants, not to monetise them.

### Tone

Functional and operator-facing. Closer to a tool than a brand. No exclamation marks, no slogans, no "delight" copy, no mascots, no AI-generated clichés. Error messages are factual sentences. Empty states get a concrete CTA — never an illustration or a cheerful non-answer.

### Copy rules

**Name:**
- In prose: **AI Qadam** (Title case, two words, no hyphen)
- In lockup: **AI QADAM** (all-caps, inside SVG only — never in body copy)
- Hashtag: `#AIQadam` (one token, camel case)
- Don't: `AI-Qadam` · `AIQadam` · `ai qadam` · `AI Kadam`

**Casing:**
- Sentence case for buttons + menu items: *"Register for event"*, *"Save draft"*, *"Add to calendar"*
- Title Case for page titles that map to a domain noun: *"LLM Engineering in Production"*, *"Computer Vision Day"*
- UPPERCASE MONO for status labels: `UPCOMING` `LIVE` `PAST` `ONLINE` `HACKATHON`

**Tech tags:** `#LLM` `#RAG` `#MLOps` `#Computer-Vision` — `#`-prefixed, title-case, hyphenated for multi-word.

**Domain vocabulary (use verbatim):**
- *Event* (not "meetup" in formal contexts)
- *Chapter* — a city/country branch
- *Talk*, *Speaker*, *CFP*, *Agenda*, *Check-in*
- *Going* (attendee count label), *Watching* (live viewer count)

**Emoji:** never in product copy. Country flags (🇺🇿 🇰🇿 🇰🇬 🇹🇯) appear in leaderboard rows and country switcher only. Fire emoji (🔥) for streak badges is the one exception.

**Inline list-join render expressions must have an empty-value fallback** — `groups.join(', ')` inside a sentence silently produces a stray punctuation artefact when `groups` is `[]` (renders as `"You're being added as ."`). Any inline `array.join(...)` interpolated into a UI sentence must be wrapped with a fallback phrase (e.g. helper `groups.length > 0 ? groups.join(', ') : 'an operator'`); see `OnboardingForm.helpers.ts` in `apps/web/src/components/` for the canonical pattern (added by ISS-UAT-013-13 / wf-20260703-fix-065-onboarding-copy).

**Languages:** Russian and English are both first-class. Never assume English-only audience. Avoid US-centric idioms, slang, or references.

**Photography:** Documentary only — real speakers mid-sentence, real rooms, hands going up. No AI-generated humans, robots, glowing data orbs, circuit-brain graphics. No heavy filters, no watermarks, no staged corporate posing.

---

## Visual foundations

### Color system

**Brand teal** is the only color with brand identity meaning: `#3CA29E` / `oklch(0.58 0.10 192)` / Pantone 7716 C. Used for: primary buttons, focus rings, active/selected states, link accents. Everything else is neutral + four semantic colors.

**Rules:**
- Never use brand teal as a generic decoration
- Never add new color tokens — the palette is intentionally closed
- No gradients — none exist in the system
- Always use `var(--token-name)` — never raw hex in CSS (except inside SVG `<img>` fallbacks)

**Full token table:**

| Token | Light | Dark | Role |
|---|---|---|---|
| `--background` | `oklch(1 0 0)` | `oklch(0.145 0 0)` | Page background |
| `--foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | Primary text |
| `--card` | `oklch(0.99 0 0)` | `oklch(0.205 0 0)` | Card surface |
| `--card-foreground` | `oklch(0.145 0 0)` | `oklch(0.985 0 0)` | Text on cards |
| `--popover` | `oklch(1 0 0)` | `oklch(0.205 0 0)` | Dropdown/tooltip bg |
| `--muted` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` | Muted bg, tags, chips |
| `--muted-foreground` | `oklch(0.556 0 0)` | `oklch(0.708 0 0)` | Secondary/meta text |
| `--border` | `oklch(0.922 0 0)` | `oklch(0.269 0 0)` | Borders, dividers |
| `--input` | `oklch(0.922 0 0)` | `oklch(0.269 0 0)` | Input border |
| `--primary` | `oklch(0.58 0.10 192)` | `oklch(0.70 0.105 192)` | Brand teal |
| `--primary-foreground` | `oklch(0.985 0 0)` | `oklch(0.145 0 0)` | Text on primary |
| `--secondary` | `oklch(0.97 0 0)` | `oklch(0.269 0 0)` | Secondary button bg |
| `--success` | `oklch(0.696 0.17 162)` | `oklch(0.765 0.17 162)` | Checked-in, verified |
| `--warning` | `oklch(0.768 0.188 70)` | `oklch(0.823 0.188 70)` | Waitlisted, caution |
| `--destructive` | `oklch(0.577 0.245 27)` | `oklch(0.704 0.191 22)` | Cancelled, errors |
| `--ring` | same as `--primary` | same as `--primary` | Focus ring |

**Special tokens (theme-independent):**

| Token | Value | Usage |
|---|---|---|
| `--live-indicator` | `oklch(0.7 0.2 145)` | Live event green dot |
| `--badge-bronze` | `oklch(0.65 0.12 50)` | Bronze achievement tier |
| `--badge-silver` | `oklch(0.75 0.02 250)` | Silver achievement tier |
| `--badge-gold` | `oklch(0.82 0.15 85)` | Gold achievement tier |
| `--badge-special` | `oklch(0.65 0.23 295)` | Rare/special badges |
| `--streak` | `oklch(0.7 0.2 35)` | Streak fire indicator |

**Theme switching:** `data-theme="dark"` on `<html>` (or any ancestor) activates dark mode. Both themes are production-equal. The brand teal is intentionally slightly brighter in dark mode (`oklch(0.70)` vs `oklch(0.58)`) to maintain the same visual weight.

### Typography

Three families, one voice. Cyrillic and Latin must read equally well.

| Family | CSS var | Usage |
|---|---|---|
| **Geist** | `--font-display` | Display: headings, hero, section titles, brand names |
| **Inter** | `--font-sans` | Body: paragraphs, UI labels, descriptions, form text |
| **JetBrains Mono** | `--font-mono` | Meta: times, IDs, tags, status labels, code, coordinates |

Google Fonts import (include in every HTML file that uses this system):
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Inter:ital,wght@0,400;0,500;0,600;0,700;1,400&family=JetBrains+Mono:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
```

**Type scale:**

| Class | Size / Line-height | Typical usage |
|---|---|---|
| `text-6xl` | 60px / 64px | Hero display |
| `text-4xl` | 36px / 40px | Page titles |
| `text-3xl` | 30px / 36px | Section titles |
| `text-2xl` | 24px / 32px | Event titles, card headings |
| `text-xl` | 20px / 30px | Sub-headings, card titles |
| `text-lg` | 18px / 28px | Lead paragraph |
| `text-base` | 16px / 24px | Body default |
| `text-sm` | 14px / 20px | Secondary body, labels, badge text |
| `text-xs` | 12px / 16px | Captions, timestamps, metadata |
| `mono · 14` | 14px / 20px JetBrains | Times, IDs, tag text |

**Heading defaults:** `font-family: var(--font-display)`, `font-weight: 600–700`, `letter-spacing: -0.025em`. Body default: `font-family: var(--font-sans)`, `font-size: 14px`, `line-height: 1.5`. Mono labels: uppercase, `letter-spacing: 0.12em`, 11px, `font-family: var(--font-mono)`.

### Spacing

4px base unit. Ten canonical steps — use only these:

| Step | Value |
|---|---|
| `space-1` | 4px |
| `space-2` | 8px |
| `space-3` | 12px |
| `space-4` | 16px |
| `space-6` | 24px |
| `space-8` | 32px |
| `space-12` | 48px |
| `space-16` | 64px |
| `space-20` | 80px |
| `space-24` | 96px |

Card padding: 24px (`space-6`). Section gap: 48px (`space-12`). Component internal gap: 8–16px. No magic numbers.

### Radius

| Token | Value | Usage |
|---|---|---|
| `--radius-sm` | 6px | Small chips, inline badges |
| `--radius` | 8px | **Default** — inputs, buttons |
| `--radius-md` | 10px | — |
| `--radius-lg` | 12px | Cards |
| `--radius-xl` | 16px | Modals, dialogs |
| (full) | 9999px | Avatars, pill badges |

### Backgrounds & surfaces

Solid only. No gradients, no full-bleed images (unless user-uploaded event photos), no patterns, no textures, no illustrations. Cards sit on `var(--card)` with a `1px solid var(--border)` border — the border is the primary structural affordance, not shadow.

### Animation & motion

Fast and unobtrusive: 150ms for micro-interactions. Single easing: `cubic-bezier(0.4, 0, 0.2, 1)` (`--ease-out`). No spring physics, no bounces, no staggered reveals, no parallax. `prefers-reduced-motion` must be respected.

### Hover / Focus / Press

- **Buttons:** background darkens ~12% via `color-mix(in oklch, var(--primary) 88%, white)`
- **Inputs:** border transitions to `color-mix(in oklch, var(--primary) 40%, transparent)` on hover; 2px ring on focus
- **Interactive cards:** `border-color` tints toward primary + `translateY(-1px)`, 150ms ease-out
- **Focus:** `outline: 2px solid var(--ring); outline-offset: 2px` on all interactive elements
- **Disabled:** `opacity: 0.5`, `cursor: not-allowed`

### Cards

```css
background: var(--card);
border: 1px solid var(--border);
border-radius: var(--radius-lg); /* 12px */
padding: 24px;
```

Interactive cards add: `transition: border-color 150ms, transform 150ms` and `translateY(-1px)` on hover.

### Shadows

```
--shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05)
--shadow:    0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)
--shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)
--shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)
```

Use sparingly — cards rely on border, not shadow.

### Layout

Container: `max-width: 1280px`, centered, `padding: 24–64px` scaled by breakpoint. App header is fixed/sticky. No complex grids — flex + gap for most layouts. Dense information hierarchy like an ops tool, not a marketing page.

---

## Iconography

**Lucide** is the only icon library. `2px stroke`, `24×24 viewBox`, `stroke="currentColor"`.

CDN: `https://unpkg.com/lucide@latest/dist/umd/lucide.min.js`
Or: `import { CalendarDays, MapPin, Users } from 'lucide-react'`

Sizes:
- Button icons: 16px
- Navigation / sidebar icons: 20px
- Card content icons: 24px
- Empty state icons: 48px

**Rules:**
- Never mix icon families — Lucide everywhere
- Never set explicit colors — always inherit `currentColor`
- The four-dot motif from the logo is off-limits as a standalone icon
- No PrimeIcons (`pi pi-*`), no Heroicons, no Phosphor

---

## Logo usage

Two lockups, one source SVG. **Never recolor, stretch, rotate, or add effects.**

| Asset | File | Usage |
|---|---|---|
| Mark only | `assets/logo-mark.svg` | Navbars, favicons, compact/small contexts |
| Full lockup | `assets/logo-full.svg` | Splash screens, hero blocks, OG images, printed merch |

Logo mark is always **brand teal** (`var(--primary)` / `#3CA29E`). Wordmark letters adapt to theme: dark on light, off-white on dark. For inline SVG use, the `--aiq-logo-dark` CSS variable drives the letter fill and picks up the active theme. For `<img>` use, the SVG hex fallbacks apply.

**Build badge:** footprint mark + "an AI Qadam Build project" in mono caps. Always link to `https://build.aiqadam.org`.

---

## Component catalog

All styles use CSS classes defined in `tokens/components.css`. Link `styles.css` to get everything.

### Primitives (`components/primitives/`)

| Component | File | Class basis |
|---|---|---|
| Button | `Button.jsx` | `.btn .btn-{variant} .btn-{size}` |
| Input | `Input.jsx` | `.input .input-wrap .label .helper` |
| Badge | `Badge.jsx` | `.badge .badge-{variant} .badge.mono` |
| Tag | `Tag.jsx` | `.tag` |
| Avatar | `Avatar.jsx` | `.avatar .avatar-{size} .avatar-group .avatar-wrap` |

**Button variants:** `primary` · `secondary` · `ghost` · `outline` · `destructive`
**Button sizes:** `sm` (32px) · `default` (40px) · `lg` (44px)
**Badge variants:** default · `primary` · `success` · `warning` · `destructive` + `.mono` modifier for status

### Domain patterns (`components/domain/`)

| Component | File | Description |
|---|---|---|
| EventCard | `EventCard.jsx` | Most reused pattern. 4 states: upcoming · live · past · online |
| SpeakerCard | `SpeakerCard.jsx` | Avatar (lg) · name · title @ company · tags · social row |
| StatCard | `StatCard.jsx` | Mono number · uppercase label · change text |
| LeaderboardRow | `LeaderboardRow.jsx` | Rank · avatar · username · country · points · streak · change |
| EmptyState | `EmptyState.jsx` | Centered icon · heading · body · concrete CTA button |
| ActivityFeedItem | `ActivityFeedItem.jsx` | Avatar · action text · timestamp · optional card preview |

**EventCard status states:**
- `upcoming` — default teal-accented badge, full opacity
- `live` — green `LIVE` badge with time range, pulsing dot
- `past` — muted `PAST` badge, opacity 0.7
- `online` — primary `ONLINE` badge, Zoom/virtual location format

---

## UI kits

- **`ui_kits/web/`** — Country homepage + event detail + user profile. Full interactive click-through. See `ui_kits/web/README.md`.

---

## File index

```
readme.md                              ← this file (primary AI agent reference)
SKILL.md                               ← Claude Code / agent skill definition
styles.css                             ← LINK THIS ONE FILE to get everything

tokens/
  tokens.css                           ← OKLCH color tokens, fonts, radii, shadows (light + dark)
  components.css                       ← CSS class library (btn, input, badge, avatar, card, …)

assets/
  logo-mark.svg                        ← footprint mark — navbars, favicons
  logo-full.svg                        ← footprint + AI QADAM wordmark — hero, splash, OG
  og-image.svg                         ← 1200×630 shared OG/Twitter Card image

guidelines/
  colors-surface.card.html             ← surface + neutral token swatches (light mode)
  colors-brand.card.html               ← brand teal · semantic · badge tier swatches
  colors-dark.card.html                ← full token set in dark mode
  typography-display.card.html         ← Geist display scale (60px → 24px)
  typography-body.card.html            ← Inter body scale with Cyrillic specimens
  typography-mono.card.html            ← JetBrains Mono usage patterns
  spacing.card.html                    ← spacing scale (4px base, 10 steps)
  radius-shadows.card.html             ← radius scale + shadow tiers

components/primitives/
  Button.jsx + .d.ts + .prompt.md      ← 5 variants, 3 sizes, icon support
  Input.jsx + .d.ts                    ← text / password / search / textarea + states
  Badge.jsx + .d.ts                    ← semantic + dot variants + mono modifier
  Tag.jsx + .d.ts                      ← topical mono tags (#LLM, #RAG, …)
  Avatar.jsx + .d.ts                   ← initials + 6 sizes + status dot + group
  buttons.card.html                    ← all button variants + sizes (Design System tab)
  inputs.card.html                     ← input states + types
  badges.card.html                     ← badge + tag variants
  avatars.card.html                    ← avatar sizes + groups
  controls.card.html                   ← checkbox / radio / switch

components/domain/
  EventCard.jsx + .d.ts + .prompt.md   ← 4 states (upcoming/live/past/online)
  SpeakerCard.jsx + .d.ts
  StatCard.jsx + .d.ts
  LeaderboardRow.jsx + .d.ts
  EmptyState.jsx + .d.ts
  ActivityFeedItem.jsx + .d.ts
  events.card.html                     ← EventCard 4 states
  people.card.html                     ← SpeakerCard + LeaderboardRow
  stats.card.html                      ← StatCard + ActivityFeedItem

ui_kits/web/
  README.md
  index.html                           ← interactive country homepage → event detail → profile
```

---

## Quick-start: building a new AI Qadam surface

1. Link `styles.css` — you get tokens + all component CSS classes
2. Add the Google Fonts `<link>` for Geist + Inter + JetBrains Mono
3. Set `data-theme="light"` or `data-theme="dark"` on `<html>` (or let the user toggle)
4. Use `var(--token-name)` for all colors — never raw hex
5. Use `.btn .btn-primary`, `.card`, `.badge`, `.avatar-md` etc. for components
6. For domain patterns: `EventCard`, `SpeakerCard`, `StatCard` are in `components/domain/`
7. Icons: Lucide only, `stroke="currentColor"`, 16/20/24/48px sizes
8. Copy: sentence case buttons, Title Case page headings, UPPERCASE MONO status labels

---

## Licensing

| Material | License |
|---|---|
| Code (CSS, HTML, scripts) | MIT |
| Brand assets (name, marks, wordmark, four-dot motif, brand teal as primary brand color) | © AI Qadam Community — see `BRAND-USE.md` |
| Editorial content | CC BY 4.0 |

Selling merch carrying AI Qadam identity is not permitted. Personal non-commercial merch is welcome with the brand intact.
