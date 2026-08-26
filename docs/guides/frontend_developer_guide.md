# Frontend Developer Guide

Audience: FRONTEND-DEV, REVIEWER.

## 1. What you're working on

A Next.js 16 (App Router) site, React 19, TypeScript, plain CSS (no CSS-in-JS, no
Tailwind — see `src/app/globals.css` and the design system's `tokens.css`/
`components.css`). Single surface today: the AI Qadam landing page.

```
src/
  app/
    layout.tsx       root layout, fonts, metadata
    page.tsx          composes the landing page from src/components/landing/*
    globals.css        global styles, imports design tokens
    health/route.ts    liveness endpoint for deploy — see deploy_guide.md
  components/
    landing/           one file per landing-page section (Hero, Nav, Events, Team, ...)
    ScrollReveal.tsx    shared scroll-triggered reveal behavior
public/
  images/               static assets (speaker/team photos, hero image)
```

`docs/Design system for AI agents/` is the design source of truth — read its `readme.md`
in full before any visual work; it's also invocable as the `aiqadam-design` skill.

## 2. Running and checking it

| Command | Purpose |
|---|---|
| `npm run dev` | Dev server at `localhost:3000`, hot reload |
| `npm run build` | Production build — catches type errors and build-time issues `dev` won't |
| `npm run start` | Serve the production build locally |
| `npm run lint` | ESLint (`eslint-config-next` core-web-vitals + TypeScript rules) |

Run `lint` and `build` before considering any change done — `dev` alone doesn't catch
everything either checks for.

There is no automated test suite yet. Verification is manual, driven by TEST-DESIGNER's
spec and run by TEST-RUNNER — see [qa_testing_guide.md](qa_testing_guide.md). If a task
requires adding an automated framework, that's a system-extension trigger per
`docs/agents/AGENT_SYSTEM.md` §3/§7, not something to do silently as a side effect of an
unrelated change.

Implementation follows a design artefact under `docs/agents/design/` — see
`docs/agents/workflows/WF-02_requirement_implementation.md` Step 2. Don't freelance
structure the design didn't specify; if it's wrong or incomplete, report it rather than
silently improvising.

## 3. Conventions

- **One component per landing section**, named for the section (`Hero.tsx`, `Events.tsx`,
  `Team.tsx`). Follow this pattern for new sections rather than inlining markup in
  `page.tsx`.
- **Design tokens only** — `var(--primary)`, `var(--card)`, `var(--border)`, etc. Never a
  raw hex value in component or global CSS. Check the token table in the design system
  readme before introducing any new visual value — the palette and spacing scale are
  closed; don't add to them.
- **Component CSS classes** from `tokens/components.css` (`.btn`, `.card`, `.badge`,
  `.avatar-*`, etc.) for anything matching an existing pattern — don't hand-roll a button
  or card style that already exists in the system.
- **Lucide icons only**, `stroke="currentColor"`, no explicit fill, sized per the
  design system's icon-size table (16/20/24/48px by context).
- **Theme support**: every new visual element must work under both
  `data-theme="light"` and `data-theme="dark"` — test both, not just the default.
- **Copy**: sentence case for buttons/menu items, Title Case for page-level headings,
  UPPERCASE MONO for status labels — see the design system readme's copy rules in full.

## 4. Self-review checklist

Before handing off to REVIEWER, confirm:

- [ ] `npm run lint` passes with no new warnings
- [ ] `npm run build` succeeds
- [ ] No raw hex colors, only `var(--token-name)`
- [ ] No new spacing values outside the 4px-step scale
- [ ] Lucide icons only, correctly sized, `currentColor`
- [ ] Checked in both light and dark theme
- [ ] Checked at a mobile width and a desktop width
- [ ] Copy follows the casing/vocabulary rules in the design system
- [ ] No unrelated changes bundled in (scope matches what was asked)

## 5. Deploy-relevant files

`Dockerfile`, `deploy/`, and `src/app/health/route.ts` support the deployment pipeline —
see [deploy_guide.md](deploy_guide.md). Changing `next.config.ts` or anything affecting
the build output should be sanity-checked against that guide, since the Docker build
depends on Next's output shape.
