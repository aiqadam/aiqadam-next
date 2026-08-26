# QA / Verification Guide

Audience: TEST-DESIGNER, TEST-DESIGN-VALIDATOR, TEST-RUNNER, RELEASE-VALIDATOR,
FRONTEND-DEV, REVIEWER.

## 1. Current reality: manual verification, no automated framework

There is no unit/integration/e2e test suite in this project yet (no Jest, Vitest,
Playwright, etc. in `package.json`). Verification is manual, against the running app,
but it is not informal — it follows the same design→gate→execute→re-verify structure as
every other pipeline stage. This is a deliberate, tracked gap — see
`docs/agents/AGENT_SYSTEM.md` §7 — not an oversight. Adding a test framework is a
system-extension decision (per `docs/agents/ORCHESTRATOR.md` §7), not something to bolt
on silently inside an unrelated change.

## 2. The pipeline this guide supports

```
TEST-DESIGNER writes docs/agents/test-specs/<REQ-ID>.md
        │
        ▼ (gate)
TEST-DESIGN-VALIDATOR checks the spec is complete and precise
        │
        ▼
TEST-RUNNER executes it, writes test-reports/report-<date>-<run-id>.yaml
        │
        ▼ (independent re-check)
RELEASE-VALIDATOR re-verifies before the requirement is marked done
```

See `docs/agents/workflows/WF-02_requirement_implementation.md` Steps 3/3b/4/5 for the
full procedure each role follows.

## 3. Writing a verification spec (TEST-DESIGNER)

Each case in `docs/agents/test-specs/<REQ-ID>.md` must be precise enough to run without
judgment:

```markdown
## AC1 — <acceptance criterion text>

- Route: /
- Viewport: 375px (mobile), 1280px (desktop)
- Theme: light, dark
- Steps: <exact steps>
- Expected: <exact expected result — not "looks right">
```

A vague case ("check the hero looks good") fails TEST-DESIGN-VALIDATOR's gate — see
`.claude/agents/test-design-validator.md`.

## 4. What to run (TEST-RUNNER, RELEASE-VALIDATOR)

| Check | Command | Catches |
|---|---|---|
| Lint | `npm run lint` | Code-quality/convention issues (ESLint core-web-vitals + TS rules) |
| Build | `npm run build` | Type errors, build-time failures `dev` won't surface |
| Visual | `npm run dev`, open `localhost:3000` | Everything lint/build can't — actual rendering |

Automated checks are necessary but not sufficient — a change can lint and build cleanly
and still look wrong or misbehave. Always also follow the spec's cases.

**Run every check as a normal, blocking, foreground call.** Never background a build or
dev-server check expecting a later notification — see
`docs/agents/instructions/core-directives.md`'s "No Background Wait For A Cross-Turn
Notification." Subagents never receive that notification.

## 5. Manual verification checklist

For any case in a verification spec:

- [ ] Load the affected page/section per the spec's route
- [ ] Check `data-theme="light"` and `data-theme="dark"` as specified
- [ ] Check the mobile and desktop viewports as specified
- [ ] Confirm the change does what the case's "Expected" says — not just "does it look
      okay"
- [ ] For a WF-03 regression check: reproduce the exact pre-fix repro and confirm it no
      longer occurs
- [ ] Spot-check nothing adjacent visibly broke (scroll the full page)

## 6. Reporting

Write `test-reports/report-<date>-<run-id>.yaml`:

```yaml
run_id: <run-id>
date: <ISO8601-UTC>
lint: pass|fail
build: pass|fail
cases:
  - acceptance_criterion: AC1
    result: pass|fail
    notes: <what was actually observed>
```

**Pass** states plainly what was checked. **Fail** states exact repro: route, viewport,
theme, action sequence, expected vs. actual — enough that FRONTEND-DEV doesn't have to
ask follow-up questions.

## 7. When this guide gets rewritten

The moment a real test framework is introduced (unit tests, visual regression, e2e), this
guide is rewritten to document it, `docs/agents/AGENT_SYSTEM.md` §7's "no automated
framework" line is removed, and TEST-DESIGNER/TEST-RUNNER's procedures above are updated
to write and run real test code instead of manual specs. The roles themselves don't
change — only their mechanics do.
