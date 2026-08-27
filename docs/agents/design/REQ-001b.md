# REQ-001b — landing component copy extraction design

Status: design for WF-02 Step 1. Scope: extract every hardcoded user-facing string from
the 12 `src/components/landing/*` components into `messages/ru.json` /
`messages/uz.json` (uz populated with ru values duplicated verbatim as placeholders,
per REQ-001a's precedent) and wire each component to next-intl. Translation quality is
REQ-002. See handoff `handoffs/WF02-REQ-001b/step-01-code-designer.json` for full
requirement text.

## 0. Current state verified directly (not taken on faith from the handoff)

**next-intl setup (REQ-001a, now on master), read directly:**

- `src/i18n/routing.ts` — `defineRouting({ locales: ["ru", "uz"], defaultLocale: "ru" })`.
- `src/i18n/request.ts` — `getRequestConfig` resolves `locale` (falls back to
  `routing.defaultLocale` if the requested locale isn't in `routing.locales`) and loads
  `messages/${locale}.json` dynamically.
- `src/i18n/navigation.ts` — `createNavigation(routing)` exports `Link`, `redirect`,
  `usePathname`, `useRouter`, `getPathname`.
- `src/app/[locale]/layout.tsx` — an **async Server Component**. Validates the locale
  with `hasLocale(routing.locales, locale)` (404s via `notFound()` if invalid), wraps
  `children` in `<NextIntlClientProvider>` with **no explicit `messages` prop** (so it
  relies on `next-intl`'s automatic pickup of `getRequestConfig`'s returned `messages` —
  confirmed this is the pattern already in use, not something this design introduces).
  `generateMetadata` uses `getTranslations({ locale, namespace: "Metadata" })` — the
  Server Component pattern this design's server components will replicate exactly, just
  with different namespaces.
- `messages/ru.json` / `messages/uz.json` — currently only the `Metadata` namespace
  (`title`, `description`, `ogLocale`) from REQ-001a. This design adds 12 sibling
  top-level namespaces, one per component, touching neither the shape nor values of
  `Metadata`.
- `src/components/landing/Nav.tsx` and the already-built `src/components/landing/
  LocaleSwitcher.tsx` (also merged from REQ-001a) establish the two working patterns
  this design reuses:
  - `LocaleSwitcher.tsx` is `"use client"`, calls `useLocale()` (from `next-intl`) and
    `usePathname()` (from `@/i18n/navigation`) — the Client Component pattern.
  - `Nav.tsx` itself has **no `"use client"` directive** — it is a Server Component
    today, but its two nav-copy areas (`nav-links` anchor labels, `brand` text) are
    still hardcoded Russian strings that REQ-001a's scope did not touch (REQ-001a only
    replaced the `.lang` switcher block). This design's `Nav` namespace covers exactly
    those remaining strings.

**All 12 landing components, read directly, in full:**

`Band.tsx`, `Creed.tsx`, `Doors.tsx`, `Events.tsx`, `Footer.tsx`, `Hero.tsx`,
`MapSection.tsx`, `Metrics.tsx`, `Nav.tsx`, `Partners.tsx`, `Streams.tsx`, `Team.tsx`.
**None of the 12 has a `"use client"` directive** — every one is a Server Component
today. (Confirmed by reading each file's first line; `LocaleSwitcher.tsx`, which does
have the directive, is not one of the 12 named in this requirement — it was already
extracted and wired by REQ-001a.)

Per-component string catalog is in §2. Dynamic-copy audit is in §3.

## 1. Namespace structure — one top-level key per component, named for the filename

Proposed shape: each of the 12 components gets its own top-level namespace object in
`messages/ru.json` / `messages/uz.json`, named identically to the component's filename
(`Band`, `Creed`, `Doors`, `Events`, `Footer`, `Hero`, `MapSection`, `Metrics`, `Nav`,
`Partners`, `Streams`, `Team`) — sibling to the existing `Metadata` namespace, not
nested under it or under each other.

**Reasoning:**

- This mirrors the precedent REQ-001a already set (`Metadata` = one namespace for
  `layout.tsx`'s copy) and the frontend guide's stated convention "one component per
  landing section" (`frontend_developer_guide.md` §3) — the file/namespace boundary the
  codebase already uses for structure is the same boundary that makes sense for copy
  ownership. A reviewer opening `messages/ru.json` can jump straight to the namespace
  matching the component they're editing, with no indirection table to maintain.
  Filenames are already unique and stable identifiers in this codebase (design tokens
  and CSS classes are file/section-scoped too — e.g. `.map-sect`, `.metrics`,
  `.partners-sect` following the same one-section-per-file pattern), so reusing them as
  namespace keys introduces no new naming scheme.
- A flat per-component namespace (not further split by, say, a shared `Common`
  namespace for repeated strings) is proposed because a scan of all 12 files' copy
  found no exact string repeated verbatim across components — `Nav`'s "События" label
  and `Events`'s section content are related but not identical strings, so introducing
  a shared namespace now would be speculative de-duplication with no current payoff.
  If REQ-002 or later work finds genuine duplication, splitting out a `Common`
  namespace at that point is a small, mechanical follow-up — not a reason to
  under-design now.
- Each namespace uses `getTranslations({ namespace: "<ComponentName>" })` (server) or
  `useTranslations("<ComponentName>")` (client) — see §2 per-component hook column —
  which is next-intl's documented recommended organization (one namespace per usage
  site), so this isn't a novel scheme invented for this project.

Repeated-shape copy inside a single component (arrays of talks/team members/chapters/
metrics/partners/streams — see §3) is **not** flattened into per-item keys (e.g. not
`Events.talks.0.who`, `Events.talks.1.who`, ...). Reasoning and the alternative
considered are in §3, since this interacts directly with the dynamic-content flag the
handoff asks for.

## 2. Per-component key structure, Client/Server status, and hook

All 12 components are **Server Components today** (no `"use client"` in any of them),
so the default recommendation per component is `getTranslations` from `next-intl/
server`, called inside the (currently sync, becoming async) default-export function —
mirroring the pattern already proven in `src/app/[locale]/layout.tsx`'s
`generateMetadata`. None of the 12 components currently receives props or reads
`params`/`searchParams`, so making each an `async function` and calling
`await getTranslations({ namespace: "<Name>" })` at the top (no explicit `locale`
argument needed — server-side `getTranslations` without a `locale` argument resolves it
from the request context set up by `src/i18n/request.ts`, the same mechanism
`NextIntlClientProvider` relies on) is the only structural change needed to reach the
copy; no component needs to become a Client Component for this requirement, and none of
the 12 has any interactivity (state, event handlers, browser-only APIs) that would
require one.

| Component | Client/Server today | Hook to use | Namespace | Keys (flat unless noted) |
|---|---|---|---|---|
| `Nav.tsx` | Server (no directive) | `getTranslations("Nav")` | `Nav` | `brand` ("AI Qadam" — see open question 1 in §4 on whether this is even in scope), `events`, `chapters`, `streams`, `join`, `team` (the 5 `nav-links` anchor labels: События/Чаптеры/Направления/Участвовать/Команда) |
| `Hero.tsx` | Server | `getTranslations("Hero")` | `Hero` | `eyebrow`, `title` (contains the `<em>вместе.</em>` emphasis — see open question 2 in §4), `subtitle`, `ctaPrimary`, `ctaSecondary`, `pillUzbekistan`, `pillKazakhstan`, `pillTajikistan`, `pillKyrgyzstan`, `nextEventLabel`, `nextEventWhen`, `nextEventWhatBold` ("Fail Stories #1"), `nextEventWhatRest` (" — честные истории провалов в AI и продукте · Bridge, Tashkent City" — see open question 2), `nextEventCta` |
| `Band.tsx` | Server | `getTranslations("Band")` | `Band` | `title`, `lede`, `ctaPrimary`, `ctaSecondary` |
| `Creed.tsx` | Server | `getTranslations("Creed")` | `Creed` | `eyebrow`, `title`, `lede`, `principle1Title`, `principle1Body`, `principle2Title`, `principle2Body`, `principle3Title`, `principle3Body`, `principle4Title`, `principle4Body`, `quote` (contains `<em>не про искусственный интеллект.</em>` — open question 2), `quoteMeta` |
| `Metrics.tsx` | Server | `getTranslations("Metrics")` | `Metrics` | Repeated-shape array of 5 items, each with `number`/`label`/`source` — key structure per §3 (`metric1Number`/`metric1Label`/`metric1Source` ... `metric5*`), plus `sourceNote` |
| `Doors.tsx` | Server | `getTranslations("Doors")` | `Doors` | `eyebrow`, `title`, `lede`, `door1Title`, `door1Body`, `door1LinkUzbekistan`, `door1LinkKazakhstan`, `door1Tag`, `door2Title`, `door2Body`, `door2Link`, `door2Tag`, `door3Title`, `door3Body`, `door3LinkProjects`, `door3LinkChat`, `door3Tag` |
| `Events.tsx` | Server | `getTranslations("Events")` | `Events` | `eyebrow`, `title`, `lede`, `tabMeetup1`, `tabMeetup2`, `tabFailStories`, repeated-shape `TALKS` array (4 items: `who`/`role`/`topic`/`desc` each) per §3, `sourceNote` |
| `MapSection.tsx` | Server | `getTranslations("MapSection")` | `MapSection` | `eyebrow`, `title`, `lede`, `svgAriaLabel` (see §3 — flagged, not array-derived), `nodeTashkentLabel`, `nodeTashkentSub`, `nodeAlmatyLabel`, `nodeAlmatySub`, `nodeDushanbeLabel`, `nodeDushanbeSub`, `nodeBishkekLabel`, `nodeBishkekSub`, `turkicWorldLabel`, repeated-shape `CHAPTERS` array (4 items: `name`/`desc`/`status` each) per §3, `ctaLaunchChapter` |
| `Streams.tsx` | Server | `getTranslations("Streams")` | `Streams` | `eyebrow`, `title`, `lede`, repeated-shape `STREAMS` array (4 items: `status`/`title`/`desc` each) per §3, `foundationTitle`, `foundationBody`, `foundationLink` |
| `Partners.tsx` | Server | `getTranslations("Partners")` | `Partners` | `eyebrow`, `title`, repeated-shape `PARTNERS` array (4 items: `name`/`kind`/`desc` each) per §3, `disclaimer`, `cta` |
| `Team.tsx` | Server | `getTranslations("Team")` | `Team` | `eyebrow`, `title`, `lede`, repeated-shape `TEAM` array (5 items: `name`/`role`/`desc` each) per §3 |
| `Footer.tsx` | Server | `getTranslations("Footer")` | `Footer` | `brand` (see open question 1), `about`, `communityHeading`, `communityChatUzbekistan`, `communityChatKazakhstan`, `communityChatContributors`, `ecosystemHeading`, `contactsHeading`, `contactsTelegram`, `hashtag`, `licenseCode`, `licenseContent`, `licenseBrand`, `prototypeLabel` |

Notes applying to the whole table:

- **Non-copy values are never extracted.** URLs (`href`s to `t.me/...`, `mailto:`,
  `tel:`, `build.aiqadam.org`, etc.), image `src` paths, CSS class names, ARIA roles,
  and the ecosystem-domain link *labels* that are literally the URL text itself
  (`build.aiqadam.org`, `flow.aiqadam.org`, `brand.aiqadam.org`, `github.com/aiqadam`,
  `binali.rustamov@aiqadam.org`, `+7 708 527 2322`) are left as literal strings in the
  `.tsx` files, not moved into the catalog — they are not "user-facing copy" in the
  translatable sense (a phone number or domain name doesn't change between `ru` and
  `uz`), matching REQ-001a's precedent of not extracting `siteUrl`/`metadataBase`.
  Flagged explicitly as this design's judgment call, not a silently-made assumption —
  see open question 3 in §4 for the one link where this is genuinely ambiguous
  (`RETURN_VOID_0`/Telegram handle in `Footer`/`Doors`, which is a proper noun handle,
  not a domain, but still not natural-language copy).
- **Semantic HTML structure around text is preserved**, only the string content moves.
  E.g. `Footer.tsx`'s `<h4>Сообщество</h4>` becomes `<h4>{t("communityHeading")}</h4>`;
  the `<h4>` element itself is unaffected by this requirement.
- **Status/label values used as both display text and a styling hook**
  (`MapSection`'s `c.status` — "активен"/"в планах" — and `Streams`'s `s.status` —
  "работает"/"в работе"/"в планах" — feeding both the visible text and the
  `statusClass` CSS class already computed as a separate, non-translated field) keep
  `statusClass` exactly as a literal string constant in the `.tsx` array (it's a CSS
  class name, not copy) while only the human-readable `status` value is sourced from
  the catalog per §3's repeated-shape key pattern.

## 3. Dynamic/templated copy — explicit audit against the "empty-array copy" pitfall

`content_ba_guide.md` §5 flags: *"Any inline `array.join(', ')` interpolated into a
sentence needs an empty-value fallback — an empty array silently renders as a stray
comma/period."*

**Checked every one of the 12 components for this pattern. Finding: none of them uses
`array.join()` or any array-to-sentence string interpolation.** The six components with
data arrays (`Events.TALKS`, `MapSection.CHAPTERS`, `Metrics.METRICS`,
`Partners.PARTNERS`, `Streams.STREAMS`, `Team.TEAM`) all render via `.map()` into
**one repeated DOM block per array item** (an `<article>`/`<div>` per talk/chapter/
metric/partner/stream/person) — never joined into a single sentence string. An empty
array in any of these would render zero repeated blocks (an empty section), not a
stray comma or malformed sentence — a materially different failure mode than the
guide's flagged pitfall, and not the "silent grammatical artifact" the pitfall
describes. So the literal pitfall does not apply to any of the 12 components. This is
stated as a checked-and-cleared finding, not a silent omission.

That said, these six arrays are still the closest thing to "dynamic/templated content"
in this batch, and how their catalog keys are shaped is a genuine open design point,
not something to gloss over:

- **These arrays are currently hardcoded as `.tsx` module-level constants** (data +
  copy fused together — e.g. `Events.TALKS` mixes `img` (data) with `who`/`role`/
  `topic`/`desc` (copy) in the same object). Fully "extracting" them into the message
  catalog would mean either (a) splitting each array into a non-translatable
  data-shape array (kept in `.tsx`, holding `img`, ordering, any `statusClass`) plus a
  flat set of per-index translation keys (`Events.talk1Who`, `Events.talk1Role`, ...,
  proposed in §2's table) that the component zips back together by array index at
  render time, or (b) keeping structured per-item objects *inside* the JSON catalog
  itself (e.g. `Events.talks: [{who, role, topic, desc}, ...]` as a JSON array value
  under the `Events` namespace) and only keeping `img`/ordering in the `.tsx` file,
  joined by index.
- **This design proposes (a) — flat indexed keys — not (b).** Reasoning: next-intl's
  `useTranslations`/`getTranslations` `t()` call resolves one string per key; consuming
  a JSON *array* value from inside a message namespace is not the typical next-intl
  usage pattern (its own docs model messages as nested string leaves, and ICU
  interpolation is per-key, not per-array-element) and mixing structured non-string
  data (arbitrary array length) into a translation JSON file this way is unproven in
  this codebase — REQ-001a's `Metadata` namespace has no array precedent to draw on
  either. Flat indexed keys keep every catalog value a plain string, matching what
  REQ-001a's `Metadata` namespace already established. The tradeoff — index-keyed key
  names like `talk1Who`, `talk2Who` are more verbose and order-coupled than a JSON
  array — is real but is a maintainability cost that FRONTEND-DEV/CODE-DESIGN-VALIDATOR
  should confirm is acceptable rather than this design silently picking (b) instead.
  **Flagged as open question 4 in §4.**
- Because array length is fixed and known at design time (4 talks, 4 chapters, 5
  metrics, 4 partners, 4 streams, 5 team members — verified by reading each array
  literal directly, not estimated) and every element's copy is being populated
  immediately by this same requirement (not left empty pending later content), there is
  no runtime empty-array state for any of these six arrays under this requirement's
  scope — unlike the guide's pitfall scenario, which describes a list that *can* arrive
  empty at runtime (e.g. a user's selected tags before they've picked any). No fallback
  string is designed for an empty-array case here because none of these six arrays is
  ever populated dynamically at runtime in the current codebase — they are static
  content lists edited by hand. If a future requirement makes any of them
  runtime-dynamic (e.g. metrics pulled from an API), that requirement must design the
  empty-state fallback at that time; not doing so now is this design's explicit
  judgment call, stated rather than silently assumed.
- **`MapSection.tsx`'s SVG `aria-label`** (`"Карта присутствия AI Qadam: Ташкент и
  Алматы активны, Душанбе и Бишкек в планах"`) is a separate, hand-authored sentence
  that *describes* the same four cities as the `CHAPTERS` array but is **not
  programmatically derived from it** (no `.map()`/`.join()` builds this string — it's a
  static literal). Extracting it as a single flat key (`MapSection.svgAriaLabel`, per
  §2) is straightforward and carries no array-interpolation risk, but it does mean a
  future edit to the `CHAPTERS` array (e.g. adding a fifth chapter) would silently
  desynchronize this hand-written label from the map data — flagged as open question 5
  in §4, since it's a latent content-consistency risk this requirement doesn't
  introduce but also doesn't fix.

## 4. Open questions (not silently resolved)

1. **`Nav.brand` / `Footer.brand` — is the literal "AI Qadam" brand text in scope for
   extraction at all?** `content_ba_guide.md` §4 states "AI Qadam" in prose is a fixed
   proper noun with no permitted variants ("Never AI-Qadam, AIQadam, ai qadam, or AI
   Kadam") — meaning it would be identical in the `ru` and `uz` catalogs regardless of
   translation, exactly like `Metadata.ogLocale`'s "not really translatable but still a
   hardcoded string" status in REQ-001a. This design lists it as extractable (§2) for
   consistency with acceptance criterion 1's literal wording ("every hardcoded
   user-facing string... replaced"), but CODE-DESIGN-VALIDATOR should confirm whether a
   fixed brand name that content_ba_guide.md explicitly forbids varying is meant to
   round-trip through the translation catalog at all, or whether it's acceptable to
   leave "AI Qadam" as a literal string in the two `.tsx` files (same treatment as the
   non-copy URLs in §2) since duplicating an invariant brand string into two JSON files
   adds catalog surface with zero translation value.
2. **`<em>`-wrapped emphasis fragments inside otherwise-flat sentences**
   (`Hero.title`'s "Инженеры, которые строят AI в Центральной Азии — <em>вместе.</em>",
   `Creed.quote`'s "...это <em>не про искусственный интеллект.</em> Это про людей.",
   `Hero`'s bold "Fail Stories #1" inside the nextev sentence). Two approaches exist:
   (a) one flat key per sentence containing raw HTML/JSX-unsafe markup that the
   component would need to render via `dangerouslySetInnerHTML` or an ICU/rich-text
   next-intl formatter (`t.rich()`), or (b) splitting each sentence into
   pre-emphasis/emphasized/post-emphasis key fragments (as tentatively proposed in
   §2's `Hero` row: `title` holding the whole sentence including markup vs. a
   `titlePre`/`titleEm` split) and reassembling with real `<em>`/`<b>` JSX at the call
   site. This design does **not** pick one — it requires knowing next-intl's `t.rich()`
   API shape and whether it's already a pattern this codebase should adopt, which is a
   judgment call best made by FRONTEND-DEV at implementation time (or flagged back to
   CODE-DESIGN-VALIDATOR if it's judged to need a design decision first). Listed
   explicitly as unresolved rather than picking a key shape and calling it final.
3. **`Doors`/`Footer`'s `@RETURN_VOID_0` Telegram handle display text** ("Telegram ·
   @RETURN_VOID_0" in `Footer`, "Подать доклад →" linking to the same handle in
   `Doors`) — the handle itself is a proper-noun identifier (like a domain name, per
   §2's non-copy-value rule) but it's embedded inside a display sentence alongside the
   literal word "Telegram," which *is* ordinary copy. Whether to extract the whole
   string as one key (duplicating the handle into both catalogs, harmless since it's
   invariant) or split "Telegram ·" and the handle apart is left to FRONTEND-DEV;
   this design's key list in §2 (`Footer.contactsTelegram`) assumes the whole string is
   one key, on the reasoning that splitting a two-word label for one invariant token is
   not worth the added key-count, but flags this as a minor unresolved judgment call.
4. **Flat indexed keys vs. JSON-array-valued catalog entries for the six repeated-shape
   arrays** (`Events.TALKS`, `MapSection.CHAPTERS`, `Metrics.METRICS`,
   `Partners.PARTNERS`, `Streams.STREAMS`, `Team.TEAM`) — see §3's full discussion.
   This design recommends flat indexed keys (option a) but flags it as needing
   CODE-DESIGN-VALIDATOR confirmation since it's a real design choice with a
   stated tradeoff, not a dictated requirement.
5. **`MapSection.svgAriaLabel` vs. `CHAPTERS` array desynchronization risk** — see §3,
   final bullet. Not a blocker for this requirement (the current four cities match
   between the two today), but flagged as a latent content-maintenance risk this
   requirement's extraction doesn't newly introduce but also doesn't resolve.
6. **Whether `Nav`'s in-page anchor targets (`#events`, `#map`, `#streams`, `#join`,
   `#team`) or any other `href` needs to change** as a side effect of copy extraction —
   they do not; per REQ-001a's precedent (anchors "out of scope, untouched by this
   requirement") and confirmed directly by reading `Nav.tsx`, this requirement changes
   only the visible label text inside each `<a>`, never the `href`.

## 5. Acceptance criteria mapping

| Acceptance criterion (from handoff `context.requirement_text`) | Design element |
|---|---|
| (1) Every hardcoded user-facing string in the 12 components replaced with a next-intl translation call; verified by grepping for remaining literal Cyrillic text outside the message catalogs | §2's per-component key tables enumerate every user-facing string found in each of the 12 files by direct reading (§0); §2's "non-copy values" note explicitly scopes out what is *not* expected to disappear from a Cyrillic grep (there is none — all Cyrillic content found is copy, not codes/IDs) |
| (2) `messages/ru.json` and `messages/uz.json` each contain a key for every extracted string, in addition to REQ-001a's `Metadata` keys, with matching key sets between the two catalogs | §1 (namespace structure, additive sibling to `Metadata`) + §2 (full per-component key enumeration) — both catalogs get identical key sets per REQ-001a's established pattern (ru = source values, uz = ru values duplicated as placeholders) |
| (3) Every `messages/uz.json` key added by this requirement has a non-empty value (placeholder duplicate acceptable) | §1 restates the REQ-001a placeholder rule (ru value duplicated verbatim into uz) applies identically to every new key from §2 — no key is designed to ever be empty |
| (4) `npm run build` completes with no type or routing errors after all 12 components are wired to next-intl hooks | §2's hook column names the correct next-intl API (`getTranslations`, all 12 being Server Components) matching the proven working pattern already in `src/app/[locale]/layout.tsx`'s `generateMetadata`; no new routing files or config changes are introduced by this design (routing/plugin config is REQ-001a's completed scope, unchanged here) |
| (5) `/ru` and `/uz` both render all 12 sections with no missing-key runtime errors or fallback warnings | §2 covers every string in every component with a catalog key (no partial extraction); §1 confirms both catalogs get matching key sets so no key exists in one locale and not the other |
| Every one of the 12 components has a corresponding message-catalog section named in the design | §1 + §2 table (all 12 filenames as namespace keys) |
| Client vs Server status stated per component, with the correct hook named | §2 table, columns 2–3 (all 12 are Server / `getTranslations`, confirmed via direct file reads in §0) |
| Dynamic/templated/array-interpolated copy flagged explicitly, not glossed over | §3 (full audit: pitfall checked and found not literally present; six repeated-shape arrays discussed with an explicit design choice and tradeoff; `MapSection` aria-label desync risk flagged) |
| No `.tsx` implementation code blocks present | This document contains only a file/key table, prose, and one inline pseudo-example key name list — no `.tsx` component bodies |
| Open questions listed explicitly if genuinely undetermined | §4 (6 open questions) |
