# Test Spec — REQ-001b (landing copy extraction: 12 components → messages/ru.json, messages/uz.json)

Source requirement (from `handoffs/WF02-REQ-001b/step-03-test-designer.json`
`context.requirement_text.REQ-001b`):

> Extract remaining hardcoded copy from all 12 landing components into
> `messages/ru.json` and `messages/uz.json`, wire via next-intl
> `getTranslations`/`t.rich()`. 5 acceptance criteria: (1) every hardcoded Cyrillic
> string in the 12 components replaced with a translation call, none remaining outside
> the catalogs; (2) `messages/ru.json` and `messages/uz.json` have matching key sets
> (177 keys each, independently verified); (3) every new uz value non-empty (placeholder
> duplicate acceptable); (4) `npm run build` completes with no type/routing errors;
> (5) `/ru` and `/uz` both render all 12 sections with no missing-translation-key errors.

Scope test result: this requirement has real user-visible surface (rendered copy across
12 sections, in 2 locales, on the public landing page) — continuing to the full
procedure per WF-02 Step 3. Not routed to RELEASE-VALIDATOR directly.

Component under test has no light/dark theme split relevant to this requirement — this
requirement changes text content sourced from a translation catalog, not styling.
**Theme-checking does not apply to this spec.** No case below has a theme dimension.

Given the scale (12 components, 177 keys across two catalogs), this spec does **not**
enumerate one check per key. Per `docs/guides/qa_testing_guide.md` §3 and the handoff's
own instruction, it instead uses a small number of mechanically precise, comprehensive
checks: a regex sweep across all 12 component files, a key-set diff script across both
catalogs, a server-error sweep on both locale routes, a small number of spot checks
picked to span the different extraction patterns used (flat key, repeated-shape array,
Footer), and an explicit check that the two `t.rich()` emphasis call sites render real
`<em>` tags rather than escaped markup.

The 12 components in scope, confirmed by direct listing of `src/components/landing/`
(read via `getTranslations` search — 12 files match, `LocaleSwitcher.tsx` is the 13th
file in that directory but is **not** one of the 12 in REQ-001b's scope; it was already
extracted and wired by REQ-001a):

`Nav.tsx`, `Hero.tsx`, `Band.tsx`, `Creed.tsx`, `Metrics.tsx`, `Doors.tsx`, `Events.tsx`,
`MapSection.tsx`, `Streams.tsx`, `Partners.tsx`, `Team.tsx`, `Footer.tsx`.

All commands below assume the repo root as the working directory. AC5's routes assume
the app is running on `localhost:3100` (any free port works — `npm run build && npm run
start -- -p 3100`, or `npm run dev` on its default port with the port substituted into
each command); this spec was verified end-to-end on port 3100 and every command's
"Expected" output below is the actual output observed, not a guess.

---

## AC1 — Every hardcoded Cyrillic string in the 12 components replaced with a translation call; none remaining outside the catalogs

- Route: N/A (static source inspection)
- Viewport: N/A
- Theme: N/A
- Steps: run the following from the repo root:
  ```
  node -e "
  const fs = require('fs');
  const files = ['Nav','Hero','Band','Creed','Metrics','Doors','Events','MapSection','Streams','Partners','Team','Footer'].map(n => 'src/components/landing/'+n+'.tsx');
  const cyr = /[Ѐ-ӿ]/;
  let bad = [];
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf8');
    if (cyr.test(content)) bad.push(f);
  }
  console.log('files_scanned:', files.length);
  console.log('cyrillic_matches:', JSON.stringify(bad));
  "
  ```
  (`grep -P` with a Unicode range is not usable here — this shell's `grep` reports
  `grep: -P supports only unibyte and UTF-8 locales` and exits 2 on this environment, so
  the check is a `node` script instead, which reads each file as UTF-8 directly and is
  unaffected by locale.)
- Expected: output is exactly two lines:
  `files_scanned: 12`
  `cyrillic_matches: []`
  (`cyrillic_matches` non-empty — any file listed — is a FAIL: it names a component that
  still contains a raw Cyrillic string, meaning some copy was not routed through
  `t()`/`t.rich()`.)

- Companion check (confirms every one of the 12 files was actually wired to next-intl,
  not just emptied of Cyrillic by accident, e.g. by deleting copy instead of extracting
  it):
  ```
  grep -l "getTranslations" src/components/landing/Nav.tsx src/components/landing/Hero.tsx src/components/landing/Band.tsx src/components/landing/Creed.tsx src/components/landing/Metrics.tsx src/components/landing/Doors.tsx src/components/landing/Events.tsx src/components/landing/MapSection.tsx src/components/landing/Streams.tsx src/components/landing/Partners.tsx src/components/landing/Team.tsx src/components/landing/Footer.tsx | wc -l
  ```
- Expected: output is exactly `12` (every one of the 12 files imports/calls
  `getTranslations`; fewer than 12 is a FAIL — it means at least one component has no
  translation call at all, which combined with zero Cyrillic matches would indicate
  copy was deleted rather than extracted).

---

## AC2 — `messages/ru.json` and `messages/uz.json` have matching key sets (177 keys each, independently verified)

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
  console.log('ru_count:', rk.length);
  console.log('uz_count:', uk.length);
  console.log('key_sets_match:', JSON.stringify(rk)===JSON.stringify(uk));
  const inRuNotUz = rk.filter(k => !uk.includes(k));
  const inUzNotRu = uk.filter(k => !rk.includes(k));
  console.log('in_ru_not_uz:', JSON.stringify(inRuNotUz));
  console.log('in_uz_not_ru:', JSON.stringify(inUzNotRu));
  "
  ```
- Expected: output is exactly five lines:
  `ru_count: 177`
  `uz_count: 177`
  `key_sets_match: true`
  `in_ru_not_uz: []`
  `in_uz_not_ru: []`
  (177 counts every leaf string key in both files, including the 3 pre-existing
  `Metadata` keys from REQ-001a plus the 174 keys newly added across the 12 namespaces
  this requirement adds. Any count other than 177, `key_sets_match: false`, or a
  non-empty diff array is a FAIL.)

---

## AC3 — Every `messages/uz.json` key added by this requirement has a non-empty value (placeholder duplicate acceptable)

- Route: N/A (static file check)
- Viewport: N/A
- Theme: N/A
- Steps: run the following from the repo root:
  ```
  node -e "
  const uz = require('./messages/uz.json');
  function keys(obj, prefix=''){let out=[];for(const k in obj){const p=prefix?prefix+'.'+k:k; if(typeof obj[k]==='object'&&obj[k]!==null) out=out.concat(keys(obj[k],p)); else out.push(p);} return out;}
  const uk = keys(uz);
  const empty = uk.filter(k => {
    const v = k.split('.').reduce((o,p)=>o[p], uz);
    return typeof v !== 'string' || v.trim() === '';
  });
  console.log('uz_keys_total:', uk.length);
  console.log('empty_uz_values:', JSON.stringify(empty));
  "
  ```
- Expected: output is exactly two lines:
  `uz_keys_total: 177`
  `empty_uz_values: []`
  (A placeholder value in `uz.json` that duplicates the `ru.json` value verbatim for the
  same key — the current state of every key in this file — is acceptable and must NOT be
  flagged; only an empty string, a whitespace-only string, or a non-string value counts
  as a failure for `empty_uz_values`. Any non-empty `empty_uz_values` array is a FAIL.)

---

## AC4 — `npm run build` completes with no type/routing errors

- Route: N/A (build-time check, not a page)
- Viewport: N/A
- Theme: N/A
- Steps: run `npm run build` from the repo root.
- Expected: exits with status code `0`. Output includes `✓ Compiled successfully`,
  `Running TypeScript ...` followed by `Finished TypeScript in <N>s ...` with no
  intervening `Type error` or `Failed to compile` line, and ends with a route table that
  includes `ƒ /[locale]` and `ƒ  Proxy (Middleware)`. No line in the full output contains
  the case-insensitive substring `error` (grep check:
  `npm run build 2>&1 | grep -i error` must produce no output — exit code `1` from
  `grep`, confirming zero matching lines).

---

## AC5 — `/ru` and `/uz` both render all 12 sections with no missing-translation-key errors

This AC is checked in four parts: (a) a server-error sweep across both locales, (b) three
spot checks confirming specific real strings render correctly, spanning the three
extraction patterns used (flat key, repeated-shape array item, Footer literal), (c) the
two `t.rich()` emphasis cases render real `<em>` tags rather than escaped markup, and
(d) both locale pages actually 200 and contain all 12 sections.

With the app running on `localhost:3100` (`npm run build && npm run start -- -p 3100`):

### 5a — No next-intl error markers on either locale

- Route: `/ru`
- Steps: `curl -s http://localhost:3100/ru | grep -o -E "MISSING_MESSAGE|IntlError"`
- Expected: no output; the bare `grep` (not piped into anything else, so its own exit
  code is visible) exits `1` (no match found). Any printed `MISSING_MESSAGE` or
  `IntlError` substring, or exit code `0`, is a FAIL.

- Route: `/uz`
- Steps: `curl -s http://localhost:3100/uz | grep -o -E "MISSING_MESSAGE|IntlError"`
- Expected: no output; `grep` exits `1`.

### 5b — Spot checks: one flat key (Hero), one repeated-shape array item (Team), one Footer literal

- Route: `/ru`
- Steps: `curl -s http://localhost:3100/ru | grep -o '<p class="eyebrow rv">[^<]*</p>'`
- Expected: exactly `<p class="eyebrow rv">AI Qadam · UZ · KZ · KG · TJ</p>`
  (`Hero.eyebrow` — a flat key, unchanged text between locales since it's a
  language-neutral tag line, per `messages/ru.json`/`messages/uz.json`'s current
  identical placeholder values).

- Route: `/uz`
- Steps: `curl -s http://localhost:3100/uz | grep -o '<p class="eyebrow rv">[^<]*</p>'`
- Expected: exactly `<p class="eyebrow rv">AI Qadam · UZ · KZ · KG · TJ</p>` (same string
  — confirms the key resolves on `/uz` too, not just `/ru`).

- Route: `/ru`
- Steps: `curl -s http://localhost:3100/ru | grep -o '<div class="nm">[^<]*</div>' | head -1`
- Expected: exactly `<div class="nm">Бинали Рустамов</div>` (`Team.team1Name`, the first
  item of `Team.tsx`'s repeated-shape `TEAM.map()` array, zipped by index from
  `team1Name`/`team1Role`/`team1Desc` keys — confirms the indexed-key pattern resolves
  correctly for at least the first array element).

- Route: `/uz`
- Steps: `curl -s http://localhost:3100/uz | grep -o '<div class="nm">[^<]*</div>' | head -1`
- Expected: exactly `<div class="nm">Бинали Рустамов</div>`.

- Route: `/ru`
- Steps: `curl -s http://localhost:3100/ru | grep -o '<span>#AIQadam</span>'`
- Expected: exactly `<span>#AIQadam</span>` (`Footer.hashtag`, a literal-string Footer
  value with no interpolation).

- Route: `/uz`
- Steps: `curl -s http://localhost:3100/uz | grep -o '<span>#AIQadam</span>'`
- Expected: exactly `<span>#AIQadam</span>`.

### 5c — `t.rich()` emphasis cases render real `<em>` tags, not escaped markup

- Route: `/ru`
- Steps:
  `curl -s http://localhost:3100/ru | grep -o '<h1 class="rv">.*вместе\.</em></h1>'`
- Expected: exactly
  `<h1 class="rv">Инженеры, которые строят AI в Центральной Азии — <em>вместе.</em></h1>`
  (`Hero.title`, rendered via `t.rich("title", { em: (chunks) => <em>{chunks}</em> })` in
  `src/components/landing/Hero.tsx` — the emphasized fragment must appear as a real
  `<em>...</em>` element in the HTML, not as `&lt;em&gt;`).

- Route: `/uz`
- Steps:
  `curl -s http://localhost:3100/uz | grep -o '<h1 class="rv">.*вместе\.</em></h1>'`
- Expected: exactly
  `<h1 class="rv">Инженеры, которые строят AI в Центральной Азии — <em>вместе.</em></h1>`

- Route: `/ru`
- Steps:
  `curl -s http://localhost:3100/ru | grep -o '<p>В конце концов.*Это про людей\.</p>'`
- Expected: exactly
  `<p>В конце концов, AI Qadam — это <em>не про искусственный интеллект.</em> Это про людей.</p>`
  (`Creed.quote`, rendered via `t.rich("quote", { em: (chunks) => <em>{chunks}</em> })`
  in `src/components/landing/Creed.tsx`).

- Route: `/uz`
- Steps:
  `curl -s http://localhost:3100/uz | grep -o '<p>В конце концов.*Это про людей\.</p>'`
- Expected: exactly
  `<p>В конце концов, AI Qadam — это <em>не про искусственный интеллект.</em> Это про людей.</p>`

- Negative check (confirms no `t.rich()` output anywhere on the page is HTML-escaped):
  `curl -s http://localhost:3100/ru | grep -o "&lt;em&gt;"`
- Expected: no output; `grep` exits `1`. Any match (an escaped `<em>` literally printed
  as text) is a FAIL — it means the emphasis markup leaked as visible text instead of
  being rendered as a real element, which is the standard next-intl `t.rich()` failure
  mode when a raw string key is rendered with `t()` instead of `t.rich()`.

### 5d — Both locale pages return 200 and render all 12 sections

- Route: `/ru`
- Steps:
  `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/ru`
- Expected: exactly `200`.

- Route: `/uz`
- Steps:
  `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/uz`
- Expected: exactly `200`.

- Section-presence check (route: `/ru`): confirms all 12 sections are present in the
  response, by checking each section's distinguishing `id`/class landmark from its
  component:
  ```
  curl -s http://localhost:3100/ru | grep -o -E 'id="top"|class="nav"|id="about"|id="events"|id="map"|id="team"' | sort -u
  ```
- Expected: output is the 6 distinct landmarks each on their own line (sorted):
  ```
  class="nav"
  id="about"
  id="events"
  id="map"
  id="team"
  id="top"
  ```
  (These 6 correspond to `Nav` (`class="nav"`), `Hero` (`id="top"`), `Creed`
  (`id="about"`), `Events` (`id="events"`), `MapSection` (`id="map"`), `Team`
  (`id="team"`) — the 6 of the 12 components that have a stable `id`/root-class landmark
  in their JSX; `Band`, `Metrics`, `Doors`, `Streams`, `Partners`, `Footer` render without
  a unique root landmark and are covered instead by their spot-checked strings above and
  the section-count check below.) Fewer than all 6 lines present, or any repeated line
  (`sort -u` collapsing a real duplicate), is a FAIL.
- Repeat the same command against `/uz` — expected output is identical (the same 6
  lines), since `id`/class landmarks are not translated content.

- Section-count check (confirms no section silently failed to render — e.g. a thrown
  `MISSING_MESSAGE` error inside one Server Component aborting only that section):
  `curl -s http://localhost:3100/ru | grep -o "<section" | wc -l`
- Expected: exactly `10` — one `<section>` element per component that renders one:
  `Hero`, `Band`, `Creed`, `Metrics`, `Doors`, `Events`, `MapSection`, `Streams`,
  `Partners`, `Team` (confirmed directly: `grep -c "<section"
  src/components/landing/*.tsx` shows exactly these 10 files each containing one
  `<section` occurrence; `Nav` renders a `<header>` and `Footer` renders a `<footer>`,
  accounting for the other 2 of the 12 components). Run the same command against `/uz`
  — expected output is also exactly `10`, matching `/ru`. Any count other than `10` on
  either locale, or a mismatch between the two locales' counts, is a FAIL.

---

## Summary of routes/commands used

| AC | Route(s) | Viewport | Theme |
|---|---|---|---|
| AC1 | N/A (source inspection) | N/A | N/A |
| AC2 | N/A (file check) | N/A | N/A |
| AC3 | N/A (file check) | N/A | N/A |
| AC4 | N/A (build) | N/A | N/A |
| AC5 | `/ru`, `/uz` | N/A (server-rendered HTML, no layout concern) | N/A |

Theme-checking (`data-theme="light"` / `data-theme="dark"`) is intentionally omitted from
every case above — this requirement changes translated text content, not styling, and
introduces no theme-conditional rendering.
