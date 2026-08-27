# REQ-001a — i18n mechanism (next-intl, ru/uz) design

Status: design for WF-02 Step 1. Scope: prove the i18n mechanism end-to-end using only
`src/app/layout.tsx`'s current strings as the seed catalog. Component copy extraction is
REQ-001b; translation quality is REQ-002. See handoff
`handoffs/WF02-REQ-001a/step-01-code-designer.json` for full requirement text.

## 0. Current state verified directly (not taken on faith from the handoff)

- `src/app/layout.tsx` (57 lines): imports `Geist`, `Inter`, `JetBrains_Mono` from
  `next/font/google`; defines `siteUrl`, `title`, `description` as module-level consts;
  builds `metadata: Metadata` from them (title, description, openGraph
  title/description/url/siteName/locale/type, twitter card/title/description); default
  export `RootLayout({ children }: LayoutProps<"/">)` renders
  `<html lang="ru" className="...">`  `<body>{children}</body>`.
- `src/app/page.tsx`: default export `Home()`, no props, composes 12 landing components
  + `ScrollReveal` in a fragment. No locale-dependent logic today.
- `src/components/landing/Nav.tsx` (24 lines): default export `Nav()`, no props. Renders
  `<header className="nav"><div className="nav-in">…</div></header>`. The switcher block
  is exactly:
  ```
  <div className="lang" title="Прототип: переключатель языка">
    <span className="on">RU</span>
    <span>UZ</span>
    <span>EN</span>
  </div>
  ```
  No click handlers, no hrefs, no state — purely static markup. Also present in the same
  file: nav links `#events` `#map` `#streams` `#join` `#team` (in-page anchors, not
  routes — out of scope, untouched by this requirement).
- `src/app/globals.css`: bespoke hex/oklab CSS variables in `:root` (`--bg`, `--fg`,
  `--primary`, etc. — lines 1–11), **not** the OKLCH design-system tokens from
  `docs/Design system for AI agents/tokens/tokens.css`. Relevant classes, exact lines:
  - `header.nav` — lines 36–40
  - `.nav-in` — line 41
  - `.brand`, `.brand img` — lines 42–44
  - `.nav-links`, `.nav-links a`, `.nav-links a:hover` — lines 45–47
  - `.lang` — lines 48–49 (`display:flex;gap:2px;font-family:var(--mono);font-size:11px;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:3px`)
  - `.lang span` — line 50 (`padding:2px 8px;border-radius:999px`)
  - `.lang .on` — line 51 (`background:var(--primary);color:#08100F;font-weight:700`)
  Decision (per handoff): switcher stays on these bespoke classes as-is. No new class,
  no migration to the documented design-system tokens.
- `next.config.ts`: `NextConfig` object, currently empty (`{ /* config options here */ }`).
- `package.json`: dependencies are `next@16.3.2`, `react@19.2.8`, `react-dom@19.2.8`
  only. **`next-intl` is not installed** — confirmed via `package.json` and an empty
  glob on `node_modules/next-intl`. It must be added as a new dependency.
- `src/app/health/route.ts`: plain `GET` liveness route returning
  `{status:"ok",service:"aiqadam-next"}`, used by the Docker healthcheck and CI
  post-deploy poll (`docs/guides/deploy_guide.md` §3–4, hits `/health` literally, no
  locale prefix). **Must not move under `[locale]`** and must be excluded from the
  proxy/middleware matcher — moving or gating it would break deploy health checks.
- No `middleware.ts` or `proxy.ts` exists in the project today (confirmed: only
  `src/app/health/route.ts` under `src/app`, no root-level or `src/`-level proxy file).
- **Next.js version-specific finding, not in the handoff:** this project runs Next
  16.3.2, which **deprecates `middleware.ts`/`middleware.js` and renames the file
  convention to `proxy.ts`/`proxy.js`** (function renamed `middleware` → `proxy`).
  Source: `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/middleware.md`
  ("deprecated, renamed to proxy.js") and `.../proxy.md` ("the `middleware` file
  convention is deprecated and has been renamed to `proxy`"). Functionality is
  identical — same request/response API, same `matcher` config shape — only the
  filename and exported function name change. See §4 and §6 (open questions) for how
  this affects the next-intl setup.

## 1. New file/directory structure

```
messages/
  ru.json                      # NEW — default locale catalog
  uz.json                      # NEW — second locale catalog (RU strings duplicated verbatim as placeholders)

src/
  app/
    [locale]/                  # NEW — replaces the current unparameterized app/ root for the landing surface
      layout.tsx               # MOVED + edited from src/app/layout.tsx — see §5
      page.tsx                 # MOVED unchanged (aside from import paths, which are unaffected — uses "@/..." absolute alias) from src/app/page.tsx
    globals.css                 # UNCHANGED location — stays at src/app/globals.css, imported by src/app/[locale]/layout.tsx exactly as it is imported by the current src/app/layout.tsx
    health/
      route.ts                  # UNCHANGED — stays at src/app/health/route.ts, outside [locale], unlocalized
  components/
    landing/
      Nav.tsx                   # EDITED — switcher block replaced; see §3
      LocaleSwitcher.tsx         # NEW — extracted switcher subcomponent; see §3 for why it's split out
  i18n/                          # NEW — next-intl's conventional request-config location
    routing.ts                   # NEW — locale list + defaultLocale, shared by proxy and navigation helpers
    request.ts                   # NEW — next-intl's per-request config (locale resolution + message loading)
    navigation.ts                 # NEW — next-intl's locale-aware Link/useRouter/usePathname/redirect, created via createNavigation(routing)

proxy.ts  (or middleware.ts — see open question in §6)   # NEW — project root, next to package.json (sibling of src/), wraps next-intl's proxy/middleware factory over routing.ts

next.config.ts                  # EDITED — wrapped with next-intl's plugin, see §4
```

Rationale for `src/app/[locale]/` (not `src/[locale]/app/` or similar): next-intl's
App Router setup requires every route segment that needs the resolved locale to be
nested under the dynamic `[locale]` segment, matching the same pattern Next's own i18n
guide describes for `[lang]` (`node_modules/next/dist/docs/01-app/02-guides/internationalization.md`,
"Routing Overview" section: *"ensure all special files inside `app/` are nested under
`app/[lang]`"*). `globals.css` and `health/route.ts` are not per-route special files
requiring the locale param, so they stay where they are; `globals.css` is imported by
the layout wherever that layout lives, and `health/route.ts` is a sibling API route
outside the localized tree, matching current deploy expectations.

`i18n/` is placed at `src/i18n/` (not `src/app/i18n/`) because it is shared
infrastructure imported by both `proxy.ts` (at the project root, outside `src/app`) and
by Server Components inside `src/app/[locale]/`  — it is not itself a route.

## 2. Message catalog schema + exact seed keys/values

Both catalogs use a flat, single-namespace-per-page-surface shape (`Metadata` matches
what layout.tsx currently produces — no nesting is needed yet since this requirement
seeds only layout.tsx's strings; REQ-001b will add further top-level namespaces per
landing component, e.g. `Nav`, `Hero`, without touching the `Metadata` namespace).

Schema (structure/types, not implementation):

```
{
  "Metadata": {
    "title": string,
    "description": string,
    "ogLocale": string
  }
}
```

`messages/ru.json` — exact seed values, copied verbatim from `src/app/layout.tsx` lines
24–26 and line 37:

```json
{
  "Metadata": {
    "title": "AI Qadam — сообщество инженеров, которые строят AI в Центральной Азии",
    "description": "Не конференция и не курс. Федерация локальных сообществ под одним брендом: практики рассказывают, что они делали сами, а не что прочитали в отчёте.",
    "ogLocale": "ru_RU"
  }
}
```

`messages/uz.json` — every key populated with the Russian source string duplicated
verbatim as a placeholder, per the requirement text ("this requirement's acceptance
criteria are about the mechanism working end-to-end, not translation content"), **except**
`ogLocale`, which must be the literal `uz_UZ` (a locale-format code, not translatable
copy — duplicating `ru_RU` here would produce an incorrect OpenGraph locale tag
regardless of translation-quality scope, and the requirement text explicitly names
`uz_UZ` as the target value for this field):

```json
{
  "Metadata": {
    "title": "AI Qadam — сообщество инженеров, которые строят AI в Центральной Азии",
    "description": "Не конференция и не курс. Федерация локальных сообществ под одним брендом: практики рассказывают, что они делали сами, а не что прочитали в отчёте.",
    "ogLocale": "uz_UZ"
  }
}
```

Open question flagged explicitly rather than resolved silently: whether `ogLocale`
counts as "seeded ONLY with the hardcoded strings" (it's derived from the current
hardcoded `locale: "ru_RU"` field, so seeding it follows the same rule as title/
description) — see §6.

Twitter card title/description are **not separate keys**: `src/app/layout.tsx` line
40–44 shows the twitter block reuses the same `title`/`description` consts as the
top-level and OpenGraph metadata (`twitter: { card: "summary_large_image", title,
description }` — no distinct Twitter-only string exists today). So `Metadata.title`
and `Metadata.description` serve title/description/OpenGraph-title/OpenGraph-
description/Twitter-title/Twitter-description all at once, exactly mirroring current
behavior. No separate `twitterTitle`/`twitterDescription` keys are introduced.

## 3. Nav.tsx switcher — props/types (structure only, no .tsx code)

Split into two pieces:

**`Nav.tsx` (edited)** — remains a default-export, no-props Server Component exactly as
today, except the static `<div className="lang">...</div>` block is replaced with a
single `<LocaleSwitcher />` element. No new props on `Nav` itself.

**`LocaleSwitcher.tsx` (new)** — a Client Component (must be a client component: it
needs the active pathname via next-intl's `usePathname` hook and renders interactive
locale links).

- Component signature: `export default function LocaleSwitcher(): JSX.Element` — no
  props. It is fully self-contained: it reads the active locale via next-intl's
  `useLocale()` hook and the current pathname via next-intl's locale-aware
  `usePathname()` hook (both exported from the generated `src/i18n/navigation.ts`, see
  §1), rather than receiving them as props. This matches the "few lines of client code"
  characterization in the requirement text and avoids prop-drilling the locale through
  `Nav`, which otherwise stays a Server Component with zero props.
- Internal type (not a prop — a local constant): a locale list typed as the same
  `Locale` union next-intl derives from `routing.ts`'s `locales` tuple (`"ru" | "uz"`),
  used to map over exactly two entries, each rendered as one `<Link>` (next-intl's
  locale-aware `Link`, imported from `src/i18n/navigation.ts`) with:
  - `href`: the current pathname (so switching locale keeps the user on the equivalent
    page — this is next-intl's `Link`'s documented purpose, it swaps only the locale
    segment)
  - `locale`: the target locale (`"ru"` or `"uz"`) — the prop next-intl's `Link` uses to
    render the alternate-locale href
  - `className`: `"on"` when the mapped locale equals the active locale (from
    `useLocale()`), else no class — reproducing the existing `.lang .on` visual state
    with real active-state logic instead of the hardcoded `className="on"` on the first
    `<span>`
  - visible text: the locale's uppercase code (`"RU"` / `"UZ"`) — same visible label
    convention as today, EN option dropped per requirement text ("drop the non-
    functional EN option — no English locale is in scope")
- Outer wrapper stays a plain `<div className="lang">` (same class, same file-cited CSS
  rule at `src/app/globals.css` lines 48–49) wrapping the two `<Link>` elements in place
  of the two/three `<span>`s. The `title="Прототип: переключатель языка"` attribute is
  removed — it described a non-functional prototype, which is no longer true once the
  switcher navigates; no replacement `title` is specified here (open question, see §6:
  whether an accessible label e.g. `aria-label` should replace it is not decided by this
  design and is left for FRONTEND-DEV to resolve conservatively, i.e. omit rather than
  invent copy, unless CONTENT-BA input exists — none does for this requirement).
- CSS: `.lang` (globals.css lines 48–49) applies to the wrapper `<div>` unchanged;
  `.lang span` (line 50, `padding:2px 8px;border-radius:999px`) must instead apply to
  each `<Link>` — since `<Link>` renders an `<a>`, not a `<span>`, the CSS selector
  `.lang span` will no longer match. This requires either (a) changing the selector in
  globals.css from `.lang span` to `.lang a` (and `.lang .on` already targets a class,
  which still works unchanged on an `<a>`), or (b) the `<Link>` renders through some
  wrapper that keeps a `<span>` structurally inside a. Recommendation: **(a)** — rename
  the `.lang span` selector to `.lang a` in `src/app/globals.css` (a one-line selector
  change, not a new class, not a new value — same declaration block, same location).
  This is a required accompanying CSS edit, not a new visual pattern, and stays within
  "reuses only the existing `.lang`/`.lang span`/`.lang .on` classes" since it is a
  selector-target correction for the same rule, not the introduction of a new rule.
  Flagged explicitly in §6 as needing FRONTEND-DEV/REVIEWER confirmation since the
  requirement text names the selector as `.lang span` specifically.

## 4. next.config.ts — plugin wrapper needed: YES

next-intl's App Router integration (per the library's documented setup pattern —
`next-intl` is not installed in this repo so its own docs/types are not locally
inspectable; this is stated as this design's best-available basis, not verified against
the installed package, per §6) requires wrapping the Next config with a plugin factory,
conventionally:

```
import createNextIntlPlugin from 'next-intl/plugin';
const withNextIntl = createNextIntlPlugin();
export default withNextIntl(nextConfig);
```

Structurally, `next.config.ts` changes from a plain `export default nextConfig` to a
plugin-wrapped export, with the existing (currently empty) `NextConfig` object
unchanged in content — only the export statement changes shape. The plugin's default
lookup path for the request-config file is conventionally `src/i18n/request.ts` (or
`./i18n/request.ts` relative to `src/`), matching the `src/i18n/request.ts` location
proposed in §1; if the installed version of next-intl expects a different default path,
the factory accepts an explicit path argument, e.g.
`createNextIntlPlugin('./src/i18n/request.ts')` — exact default-vs-explicit-argument
behavior is an open question (§6) since the package isn't installed yet to confirm
against its actual shipped types/docs.

Per `docs/guides/frontend_developer_guide.md` §5, this `next.config.ts` change must be
sanity-checked against `docs/guides/deploy_guide.md` during implementation, since the
Docker build depends on Next's output shape — flagged for FRONTEND-DEV, not resolved
here.

## 5. src/app/[locale]/layout.tsx — metadata localization

Moved from `src/app/layout.tsx`, same font setup (`Geist`/`Inter`/`JetBrains_Mono`
consts, `variable` config) unchanged. Changes:

- Default export becomes an `async function RootLayout({ children, params }:
  LayoutProps<"/[locale]">)` (the generated `LayoutProps` helper parameterized to the
  new route shape, following the same `LayoutProps<...>` pattern already used today —
  see current file line 47 `LayoutProps<"/">`, just re-parameterized to the new
  segment). `params` is a promise resolving to `{ locale: string }` per Next 16's
  async-params convention (already implied by the existing codebase's use of the
  `LayoutProps` helper type).
- `<html lang={locale} className="...">` — `lang` becomes dynamic (`"ru"` or `"uz"`,
  resolved from `params`), replacing the hardcoded `lang="ru"` at current line 50.
- `metadata` construction: instead of `export const metadata: Metadata = {...}` as a
  static object (not possible once metadata depends on the resolved locale), this
  becomes `export async function generateMetadata({ params }): Promise<Metadata>` (the
  standard Next dynamic-metadata pattern for locale/param-dependent metadata), which
  reads the resolved locale's messages (via next-intl's `getTranslations` or an
  equivalent server-side message getter for the `Metadata` namespace defined in §2) and
  builds the same shape currently hardcoded at lines 28–45: `title`,
  `description`, `openGraph.{title,description,url,siteName,locale,type}`,
  `twitter.{card,title,description}` — with `title`/`description` sourced from
  `Metadata.title`/`Metadata.description` and `openGraph.locale` sourced from
  `Metadata.ogLocale` instead of the hardcoded `"ru_RU"`. `metadataBase`, `url`,
  `siteName`, `type`, and the twitter `card` value are locale-independent and stay as
  literal values exactly as today (`siteUrl = "https://aiqadam.org"`, `siteName: "AI
  Qadam"`, `type: "website"`, `card: "summary_large_image"`).
- `generateStaticParams` is not required by any acceptance criterion here and is left
  as an open question (§6) — Next's own i18n guide shows it as optional for static
  generation of locale routes; this requirement's scope is the mechanism, not
  build-time optimization.

`src/app/[locale]/page.tsx` moves from `src/app/page.tsx` with no logic changes — it
takes no params and needs none for this requirement (REQ-001b is where landing
components start consuming per-locale copy).

## 6. Root redirect behavior

Root `/` must redirect to `/ru` (the default locale), per next-intl's recommended
proxy/middleware config and the requirement text's explicit statement. Mechanism:
next-intl's proxy/middleware factory (`createMiddleware(routing)` in the library's
documented API, called from the project's `proxy.ts`/`middleware.ts` — see open
question below) handles this automatically once `routing.ts` declares
`defaultLocale: "ru"` — a request to `/` is internally rewritten/redirected to `/ru`
with no separate redirect rule needed in `next.config.ts`. The proxy/middleware
`matcher` must exclude `/health` (and the standard `_next`/static asset paths) so the
liveness route is never locale-processed — see §0's finding on `health/route.ts`.

`routing.ts` structural shape (types/fields, not implementation):

```
locales: readonly ["ru", "uz"]
defaultLocale: "ru"
```

Consumed by: the proxy/middleware factory, `src/i18n/request.ts` (locale validation/
notFound fallback), and `src/i18n/navigation.ts` (typed `Link`/`useRouter`/
`usePathname`/`redirect` helpers whose `locale` prop/param is typed to the `Locale`
union derived from this tuple).

## 7. Open questions (not silently resolved)

1. **`middleware.ts` vs `proxy.ts` filename.** This project runs Next 16.3.2, which
   deprecates `middleware.ts`/`middleware.js` in favor of `proxy.ts`/`proxy.js` (see
   §0). The handoff's task description asks "where middleware.ts should live" as if
   that's the target filename, but Next 16's own docs mark that convention deprecated.
   next-intl's own public setup docs (not locally inspectable — the package isn't
   installed) have, at various points, referenced `middleware.ts` exporting a
   `middleware` function wrapping `createMiddleware(routing)`; whether the specific
   next-intl version that gets installed already ships guidance/detection for Next 16's
   `proxy.ts` rename is unknown without installing it and checking. **Recommendation for
   FRONTEND-DEV:** create `proxy.ts` at the project root (sibling of `src/`, per
   Next 16's convention doc) exporting `export default proxy` (or `export function
   proxy`) wrapping whatever next-intl's factory returns — the function next-intl's
   factory returns is framework-signature-compatible (same `NextRequest` in, same
   `NextResponse`-shaped out) regardless of what next-intl's own docs call the export,
   since Next 16 only cares about the file name and export name, not which library
   produced the handler. If the installed next-intl version's own docs/typings
   explicitly reference a different required export name, that takes precedence — this
   is a verify-at-implementation-time item, not guessable here without the package
   installed.
2. **`createNextIntlPlugin`'s default request-config path.** Whether the installed
   next-intl version defaults to looking for `src/i18n/request.ts` with no argument, or
   requires an explicit path argument to `createNextIntlPlugin(...)`. Resolve by
   checking the installed package's own README/types at implementation time (FRONTEND-
   DEV, Step 2) rather than guessing the exact default here.
3. **Whether `ogLocale` is in-scope for "seeded ONLY with hardcoded strings currently in
   layout.tsx."** Resolved in this design as yes (§2) since it's the localized form of
   an already-hardcoded field (`locale: "ru_RU"`), and the requirement text separately
   names `ru_RU`/`uz_UZ` as the expected OpenGraph locale values — but the requirement's
   "seeded ONLY with X, Y, Z" list technically enumerates `title`/`description`/
   OpenGraph title-description-locale/Twitter title-description, so `ogLocale` is
   explicitly named there too. Flagging only because the exact JSON key name
   (`ogLocale` vs `og_locale` vs nesting it under an `openGraph` sub-object) is this
   design's own choice, not dictated by the requirement text — CODE-DESIGN-VALIDATOR
   should confirm the chosen flat shape is acceptable.
4. **`generateStaticParams` for `[locale]`.** Not required by any stated acceptance
   criterion; left unimplemented by this design. If REVIEWER or FRONTEND-DEV judges it
   necessary for correct static generation under Next 16's defaults, that's a build-
   behavior call to make at implementation time, not a design-level requirement here.
5. **Accessible label on the switcher wrapper** replacing the removed
   `title="Прототип: переключатель языка"` attribute. Not specified by this design
   (no CONTENT-BA copy exists for it); left to FRONTEND-DEV to either omit or add a
   minimal `aria-label` using existing vocabulary, not new copy invention.
6. **`.lang span` → `.lang a` selector rename** (§3). This is this design's
   recommendation, not a pre-existing decision — flagged for CODE-DESIGN-VALIDATOR and
   REVIEWER to confirm it still satisfies "reuses only the existing `.lang`/`.lang
   span`/`.lang .on` classes," since the requirement text names the selector literally.

## 8. Acceptance criteria mapping

| Acceptance criterion (from handoff `task.acceptance_criteria`) | Design element |
|---|---|
| Every acceptance criterion in REQ-001a's requirement_text maps to a concrete design element (routing restructure, message catalog schema, switcher props/behavior, layout.tsx metadata localization, root redirect) | Routing restructure → §1; message catalog schema → §2; switcher props/behavior → §3; layout.tsx metadata localization → §5; root redirect → §6. Dependency addition → §0/§4. |
| All new component props/types (switcher's, any new layout/page component's) specified with field-level detail — types, not prose descriptions | §3 (`LocaleSwitcher` signature, internal `Locale` type, `Link` props used); §5 (`RootLayout` signature, `LayoutProps<"/[locale]">`, `generateMetadata` signature); §6 (`routing.ts` field types) |
| Every CSS class referenced cited with exact real location — no invented class names, no design-system token path that doesn't exist in this project | §0 and §3 cite `src/app/globals.css` line numbers for every class (`header.nav` 36–40, `.nav-in` 41, `.brand`/`.brand img` 42–44, `.nav-links`* 45–47, `.lang` 48–49, `.lang span` 50, `.lang .on` 51). No design-system token path referenced. |
| No .tsx implementation code blocks present — structure, file tree, types, and prose only | This document contains a file tree, JSON catalog samples, a next.config.ts config-shape snippet (not component/page `.tsx` code), and prose/type descriptions only — no `.tsx` component bodies. |
| Open questions listed explicitly if genuinely undetermined, not guessed at silently | §7 (6 open questions) |

Each of the requirement text's five explicit scope bullets (dependency; routing
restructure; message catalogs; switcher; layout.tsx metadata; root redirect) is
addressed: dependency in §0/§4, routing restructure in §1, message catalogs in §2,
switcher in §3, layout.tsx metadata in §5, root redirect in §6.
