# Test Spec — REQ-001a (i18n mechanism: dependency, routing, proxy, switcher)

Source requirement (from `handoffs/WF02-REQ-001a/step-03-test-designer.json`
`context.requirement_text.REQ-001a`):

> GitHub issue #2 ("Translate to UZ" / "Add localization") requires Uzbek localization
> of the AI Qadam landing site. This requirement is the first of two: it proves the i18n
> MECHANISM end-to-end (dependency, routing, middleware/proxy, a working switcher) using
> only `src/app/layout.tsx`'s strings as the seed catalog.

Scope test result: this requirement has real user-visible surface (a rendered page with
a working, clickable language switcher) — continuing to the full procedure per WF-02
Step 3. Not routed to RELEASE-VALIDATOR directly.

Component under test has no light/dark theme split — REVIEWER already confirmed
`src/app/globals.css` defines no `data-theme` rule for `.lang`/`.nav`/the switcher.
**Theme-checking does not apply to this spec.** No case below has a theme dimension, and
none should be added.

Viewports: this project's frontend guide (`docs/guides/frontend_developer_guide.md` §4)
requires checking "a mobile width and a desktop width." The actual CSS breakpoints in
`src/app/globals.css` are `@media (max-width:980px)` and `@media (max-width:620px)`
(confirmed via `grep -n "@media" src/app/globals.css`, lines 247 and 256). This spec uses:

- **Mobile: 600px** wide (inside both breakpoints — `.nav-links` hidden, `.wrap` padding
  reduced)
- **Desktop: 1024px** wide (outside both breakpoints — full nav visible)

Note for TEST-RUNNER: at both widths, `.lang` (the locale switcher) itself has no
`display:none` rule anywhere in `globals.css` — only `.nav-links` is hidden at
`max-width:980px` (line 254). So the switcher must remain visible and clickable at the
600px mobile width, not just at 1024px desktop. Case AC2 below checks this explicitly.

---

## AC1 — `/uz` renders `<html lang="uz">`; `/ru` (or `/`) renders `<html lang="ru">`

- Route: `/uz`
- Viewport: not relevant (server-rendered HTML attribute, not a layout concern) — check
  via HTTP response, no browser viewport needed
- Theme: not applicable (see header note)
- Steps: with the app running (`npm run dev` or `npm run start` on port 3000), run:
  `curl -s http://localhost:3000/uz | grep -o '<html lang="[a-z]*"'`
- Expected: output is exactly `<html lang="uz"`

- Route: `/ru`
- Steps: `curl -s http://localhost:3000/ru | grep -o '<html lang="[a-z]*"'`
- Expected: output is exactly `<html lang="ru"`

- Route: `/` (root, no locale segment)
- Steps: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://localhost:3000/`
- Expected: output is exactly `307 http://localhost:3000/ru` (root redirects to the
  default locale `/ru`)
- Follow-up step: `curl -sL http://localhost:3000/ | grep -o '<html lang="[a-z]*"'`
- Expected: output is exactly `<html lang="ru"` (root resolves to the `ru` page after
  following the redirect)

---

## AC2 — Clicking UZ on a `/ru/*` page navigates to the equivalent `/uz/*` page (anchors preserved); clicking RU on `/uz/*` navigates back to `/ru/*`

- Route: `/ru`
- Viewport: 600px (mobile)
- Theme: not applicable (see header note)
- Steps:
  1. Load `http://localhost:3000/ru` in a 600px-wide browser viewport.
  2. Confirm the locale switcher (`.lang` element in the header) is visible and not
     `display:none` (it must render without needing `.nav-links` to be visible — only
     `.nav-links` collapses at this width).
  3. Click the `UZ` control inside `.lang`.
- Expected: the browser navigates to `http://localhost:3000/uz` (URL bar shows `/uz`,
  no other path segments). Page reloads/re-renders with `<html lang="uz">` (verify via
  browser devtools or `document.documentElement.lang === "uz"`).

- Route: `/uz`
- Viewport: 1024px (desktop)
- Steps:
  1. Load `http://localhost:3000/uz` in a 1024px-wide browser viewport.
  2. Click the `RU` control inside `.lang`.
- Expected: the browser navigates to `http://localhost:3000/ru`. `document.documentElement.lang === "ru"`.

- Section-anchor preservation check (route: `/ru#events`, viewport: 1024px):
  1. Load `http://localhost:3000/ru#events` (note: because `LocaleSwitcher.tsx` builds
     its link from `usePathname()`, which returns only the path and not the hash, this
     step verifies the actual current behavior rather than assumed behavior).
  2. Inspect the rendered switcher markup: run
     `curl -s http://localhost:3000/ru | grep -o '<div class="lang">.*</div>'`
- Expected: output is exactly:
  `<div class="lang"><a class="on" href="/ru">RU</a><a hrefLang="uz" href="/uz">UZ</a></div>`
  — i.e. both switcher links target bare `/ru` and `/uz` (no query string, no hash
  fragment appended by the switcher itself). Since neither link carries a hash, clicking
  UZ from `/ru#events` lands on plain `/uz` (browser drops the fragment on navigation to
  a URL without one) — this is the actual, current, correct behavior for a single-page
  site where `#events` etc. are anchors on the one page that exists per locale, not
  separate pages requiring translation.
- Also run the mirror check on `/uz`:
  `curl -s http://localhost:3000/uz | grep -o '<div class="lang">.*</div>'`
- Expected: output is exactly:
  `<div class="lang"><a hrefLang="ru" href="/ru">RU</a><a class="on" href="/uz">UZ</a></div>`

---

## AC3 — next-intl is a dependency; `npm run build` completes with no type/routing errors

- Route: N/A (build-time check, not a page)
- Viewport: N/A
- Theme: N/A
- Steps:
  1. Run `npm pkg get dependencies.next-intl` from the repo root.
  2. Run `npm run build` from the repo root.
- Expected:
  1. Command 1 outputs a non-empty version string (e.g. `"^4.13.7"`) — not `{}` or an
     error. `next-intl` must appear under `dependencies`, not only `devDependencies`.
  2. Command 2 exits with status code `0` and prints `✓ Compiled successfully` and
     `Finalizing page optimization` with no lines containing `Failed to compile`,
     `Type error`, or `error` (case-insensitive) referencing routing, `[locale]`, or
     `next-intl`. The route listing printed must include `ƒ /[locale]` and
     `ƒ Proxy (Middleware)`.

---

## AC4 — `messages/ru.json` and `messages/uz.json` have matching key sets; every `uz` value is non-empty

- Route: N/A (static file check)
- Viewport: N/A
- Theme: N/A
- Steps: run the following from the repo root:
  ```
  node -e "
  const ru = require('./messages/ru.json');
  const uz = require('./messages/uz.json');
  function keys(obj, prefix=''){let out=[];for(const k in obj){const p=prefix?prefix+'.'+k:k; if(typeof obj[k]==='object'&&obj[k]!==null) out=out.concat(keys(obj[k],p)); else out.push(p);} return out;}
  const rk = keys(ru).sort(); const uk = keys(uz).sort();
  console.log('match:', JSON.stringify(rk)===JSON.stringify(uk));
  console.log('empty_uz_values:', uk.filter(k => {
    const v = k.split('.').reduce((o,p)=>o[p], uz);
    return typeof v !== 'string' || v.trim() === '';
  }));
  "
  ```
- Expected: output is exactly two lines:
  `match: true`
  `empty_uz_values: []`
  (A placeholder value in `uz.json` that duplicates the `ru.json` value for the same key
  is acceptable and must NOT be flagged — only an empty string, whitespace-only string,
  or non-string value counts as a failure for `empty_uz_values`.)

---

## AC5 — Nav.tsx switcher offers exactly two options, RU and UZ (no EN); only existing `.lang`/`.lang a`/`.lang .on` classes; no new hex/spacing values

- Route: `/ru`
- Viewport: 600px (mobile) and 1024px (desktop) — both required since the switcher is
  visible at both widths (see header note)
- Theme: not applicable (see header note)
- Steps:
  1. Run `curl -s http://localhost:3000/ru | grep -o '<div class="lang">.*</div>'`.
- Expected: output contains exactly two `<a>` elements inside the `.lang` div, with
  visible text content `RU` and `UZ` only — no third option, no `EN` substring anywhere
  in the matched output. Exact expected string:
  `<div class="lang"><a class="on" href="/ru">RU</a><a hrefLang="uz" href="/uz">UZ</a></div>`

- Steps:
  2. Run `curl -s http://localhost:3000/uz | grep -o '<div class="lang">.*</div>'`.
- Expected: exact string:
  `<div class="lang"><a hrefLang="ru" href="/ru">RU</a><a class="on" href="/uz">UZ</a></div>`

- Class-usage check (static source inspection, not runtime):
  3. Run `grep -n "className" src/components/landing/LocaleSwitcher.tsx`.
- Expected: the only className values present are `"lang"` (on the wrapping `div`) and
  the conditional expression producing `"on"` or `undefined` (on each `Link`) — no other
  className string literal appears in the file.
  4. Run `grep -n "^\.lang" src/app/globals.css`.
- Expected: exactly 3 matching rules, using only these existing selectors —
  `.lang{...}`, `.lang a{...}`, `.lang .on{...}` — confirming no new selector was added
  for this component.
  5. Run `git show 59596fc -- src/app/globals.css` (the REQ-001a implementation commit;
     confirm this is still the correct SHA by checking it appears in
     `git log --oneline -- src/app/globals.css` first — if REQ-001a's implementation
     commit has a different SHA in the branch under test, use that SHA instead).
- Expected: the diff touches only the `.lang` block (around the pre-existing lines
  47–51) and contains exactly one changed line: the selector `.lang span` renamed to
  `.lang a` (i.e. `-.lang span{padding:2px 8px;border-radius:999px}` /
  `+.lang a{padding:2px 8px;border-radius:999px}`). No hex color, no `px`/`em`/`rem`
  numeric literal, and no new selector is added or removed by this diff — the only
  change is the tag-name part of one existing selector, needed because the switcher now
  renders real `<a>` links instead of static `<span>`s. Any other change to this file in
  that commit (a new hex value, a new spacing value, a new selector) is a FAIL for AC5.

---

## Summary of routes/commands used

| AC | Route(s) | Viewport | Theme |
|---|---|---|---|
| AC1 | `/uz`, `/ru`, `/` | N/A (HTTP-level) | N/A |
| AC2 | `/ru`, `/uz`, `/ru#events` | 600px, 1024px | N/A |
| AC3 | N/A (build) | N/A | N/A |
| AC4 | N/A (file check) | N/A | N/A |
| AC5 | `/ru`, `/uz` | 600px, 1024px | N/A |

Theme-checking (`data-theme="light"` / `data-theme="dark"`) is intentionally omitted
from every case above — REVIEWER confirmed this component has no theme split.
