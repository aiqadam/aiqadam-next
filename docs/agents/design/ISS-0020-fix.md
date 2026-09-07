# ISS-0020 fix — blocked-user notification gap in `staff.ts` (both call sites)

**Issue:** ISS-0020 (S10: "`blocked` users are skipped in both [transactional and
marketing] cases", `docs/agents/instructions/security-invariants.md`). Diagnosed by
ISSUE-FIXER at `handoffs/ISS-0020/step-01-issue-fixer.json`, verified independently below
against the current tree (branch `fix/ISS-0020`).

**Surface:** `apps/bot/**` only. No design tokens apply (bot text, same as every other
bot design in this pipeline). This is a **targeted bug fix** — scope is limited to the
two notification call sites named below and the one lookup function they share. No
refactor of `staff.ts`, no touching `domain/notification.ts`/`sendLedgeredNotification`/
the ledger.

---

## 0. Verification of the diagnosis (independent re-check, not trusted as-is)

Confirmed by direct reading, matching ISSUE-FIXER's finding exactly:

- `apps/bot/src/handlers/staff.ts` `makeStaffAddHandler` (line 98) and
  `makeStaffRemoveHandler` (line 168) both call `ctx.api.sendMessage(Number(targetUser.tgId), body)`
  directly, wrapped only in a `try/catch` that sets `notificationFailed` on ANY thrown
  error (network failure, bot-blocked-by-user Telegram error, etc.) — there is no
  proactive `blocked` check before either call.
- `apps/bot/src/domain/user.ts`'s `getUserByTgUsername` (lines 132-142) selects only
  `{ id, tgId, tgUsername }` — `users.blocked` is not in its projection at all, so
  neither handler has the data needed to check it.
- `getUserByTgUsername` has exactly two callers in `apps/bot/src/**`
  (`Grep` confirmed: `domain/user.ts` itself — the declaration — and `handlers/staff.ts`,
  both call sites in this same file). **No other caller exists**, so widening its
  projection to add `blocked` cannot break any other consumer — this rules out the
  "new overload instead" alternative as unnecessary ceremony.
- `handlers/withdraw.ts`'s once-cited precedent no longer contains an inline guard:
  REQ-025 rewrote `sendPromotionNotification` into a thin wrapper around
  `sendLedgeredNotification` (`domain/notification.ts`), which requires a
  `registrationId` (`SendNotificationInput.registrationId`, NOT NULL FK per
  `db/schema.ts`) and a closed `NotificationKind` union with no member that fits an
  `EventStaff` assignment/removal (no registration is involved at all). Routing
  `staff.ts` through the ledger is therefore **not available** without a schema/type
  extension — correctly out of scope for this bug fix, per ISSUE-FIXER's reasoning,
  confirmed here rather than re-trusted.
- **Correction to `docs/agents/design/REQ-023.md` §6.2** (not edited — out of scope):
  §6.2's framing ("no existing handler does this today" / treating
  `sendPromotionNotification`'s inline guard as *the* precedent to mirror) is now
  doubly inaccurate: (a) `staff.ts`'s two send sites predate REQ-023 (REQ-018) and were
  never covered by it, and (b) the guard shape REQ-023 itself describes in
  `withdraw.ts` no longer exists as literal code — REQ-025 replaced it with the ledgered
  path. This fix does not mirror either past shape; it mirrors
  `sendLedgeredNotification`'s current *skip semantics* (§2 below) applied locally,
  since the ledgered path itself is unavailable here.

---

## 1. `domain/user.ts` — extend `getUserByTgUsername`'s projection

**Chosen approach: extend in place** (not a new function/overload). Reasoning:
`getUserByTgUsername` has exactly one caller file (`staff.ts`, both handlers) and no
other consumer to protect from a widened shape — adding one more selected column changes
nothing for existing call sites (they already destructure only the fields they use;
TypeScript structural typing means an additional field on the returned interface is
purely additive, not a breaking change to any assignment currently made from this
function's result). This is also the simpler, REQ-023-precedent-consistent shape
ISSUE-FIXER named (§6.1 of REQ-023 did the same: widen `UserForNotification` to add
`blocked` rather than fork a second lookup).

**Interface, `UserWithTelegram` (currently at `domain/user.ts` lines 126-130) — one
field added:**

```
export interface UserWithTelegram {
  id: string;
  tgId: bigint | null;
  tgUsername: string | null;
  blocked: boolean;
}
```

**`getUserByTgUsername`'s signature is unchanged** (same parameters, same return type
name, same nullability) — only the object shape returned inside `UserWithTelegram`
gains `blocked: users.blocked` in its `select({...})` projection, alongside the three
already-selected columns (`id`, `tgId`, `tgUsername`). No new query, no new `WHERE`/join
condition, no change to the existing doc-comment's stated open question about
`tg_username` having no unique index (§6.3 of REQ-018, still applies unchanged).

---

## 2. `staff.ts` — the skip-check at both call sites

**REWORK NOTE (this revision):** §2's original shape (a guard clause that skipped
entering the `try` block entirely for a blocked target) was implemented, passed
REVIEWER, then **FAILed by SECURITY-REVIEWER**
(`handoffs/ISS-0020/step-03c-security-reviewer.json`, issue `ISS-0020-SEC-1`, MEDIUM):
it introduced a **timing side-channel** the pre-fix code did not have. Pre-fix, every
notification attempt — regardless of outcome — awaited both `resolveLangForTg` (a DB
read) and `ctx.api.sendMessage` (a Telegram network round-trip) before the organizer's
own reply was sent, so no timing asymmetry existed between outcomes. The FAILed shape
made the blocked branch return immediately, skipping both awaits, while the non-blocked
branch (including its own thrown-failure case) still performed both — making "this
target has blocked the bot" distinguishable from "the send failed for some other reason"
by the wall-clock latency of the organizer's own reply, even though the reply *text* is
identical. §3 below already states the design's intent not to leak that distinction;
this rework closes the gap SECURITY-REVIEWER found between that stated intent and the
implemented control flow. §2 is rewritten below to replace the FAILed shape; §0/§1/§3-§5
are otherwise unchanged from the prior revision (§4's AC table gains one row, §5 gains no
new open question).

Both `makeStaffAddHandler` and `makeStaffRemoveHandler` already have an identical shape
immediately after resolving `targetUser`: a null-`tgId` guard (lines 71-76 / 145-148)
that replies `staff.userNotFound` and returns early, treating "can't be reached" the
same as "doesn't exist" from the organizer's point of view. **The blocked-check does NOT
reuse that same early-return shape** — it must run only at the notification step (after
the assignment/removal mutation has already been committed), not at the existence-check
step, because S10 only concerns whether the *notification* is skipped; the staff
assignment/removal itself must still happen for a blocked target exactly as it does
today (blocking the bot is not grounds to refuse an organizer's staff action).

### 2.1 Chosen mechanism: same `try` block, branch only on which Bot API call is made

Three options were weighed (see task framing in this rework's driving instruction):

1. **A fixed no-op delay** (`setTimeout`) standing in for the skipped round-trip. Rejected
   as the chosen mechanism: it is a magic number that has to be guessed and re-tuned
   against Telegram's actual latency distribution, it can never match a real round-trip
   (Telegram latency varies with load, region, and message size), and it adds a genuinely
   new kind of primitive (a timer) to a file that otherwise contains none — more moving
   parts than the fix needs.
2. **Restructure so the same awaits still occur, only `sendMessage` itself is skipped or
   replaced with a same-cost no-op network call.** This is the chosen direction, refined
   below — it targets the actual bottleneck (the network round-trip), not the DB read,
   and reuses a real Bot API call already available on the same `ctx.api` object instead
   of inventing a timer.
3. Other structural approaches (e.g., queuing the blocked case through a shared
   fire-and-forget delay pool, or moving the check earlier) were not pursued: this is a
   MEDIUM-severity, narrow-threat-model fix (an organizer who already has authorized
   staff-assignment access, timing replies to infer one specific user's internal
   `blocked` flag) — the proportional response is the simplest change that removes the
   *categorical* asymmetry (zero network calls vs. one), not an elaborate scheduling
   mechanism.

**Concrete shape, both handlers** — replaces the guard-clause `if (targetUser.blocked) {
notificationFailed = true; } else { try { ... } catch { ... } }` shape with a single
`try` block entered in **both** the blocked and not-blocked cases:

| Step (inside the one `try` block, unchanged position — §4.1 step 10 / §4.2 step 9) | Blocked (`targetUser.blocked === true`) | Not blocked (`=== false`, today's behavior) |
|---|---|---|
| 1. `await resolveLangForTg(...)` for `targetLang` | Performed — identical DB read, identical cost, in both cases | Performed (unchanged from today) |
| 2. Compose `body` via the catalog + `.replace("{event}", event.title)` | Performed (its result is simply unused on this path) — cheap, non-network, symmetry here is not what SECURITY-REVIEWER's finding was about, but keeping it removes any special-casing | Performed (unchanged from today) |
| 3. The one Telegram Bot API call | `await ctx.api.getMe()` — a read-only, side-effect-free, no-argument Bot API method that hits the same `api.telegram.org` host as `sendMessage`, incurring a comparable network round-trip, **discarding its result entirely** (never read, logged, or branched on) | `await ctx.api.sendMessage(Number(targetUser.tgId), body)` — unchanged from today |
| 4. Set `notificationFailed` | Set to `true` **unconditionally**, immediately after step 3's await settles — regardless of whether `getMe()` itself resolved or threw. (If it threw, the existing `catch` block also sets `notificationFailed = true`, so the outcome is identical either way — no new branch is needed to guarantee this.) | Not set (stays `false`) unless the existing `catch` block runs, exactly as today |
| `catch` (wraps the whole `try`, unchanged) | Sets `notificationFailed = true` — already true here per step 4, so this is a no-op re-assignment, not new behavior | Sets `notificationFailed = true` on a thrown send failure — unchanged from today |

Why `ctx.api.getMe()` specifically: it is already available on the same `ctx.api`
client used for `sendMessage` (no new import, no new client), it targets no user (it
returns the bot's own identity — nothing that could be construed as a message to or
about `targetUser`), it has no side effects (nothing is sent, nothing is written), and
because it is a genuine HTTPS round-trip to the same Telegram Bot API endpoint family,
it is in the same latency class as `sendMessage` rather than a guessed constant — closing
the *categorical* gap (network call vs. none) SECURITY-REVIEWER's finding turned on,
without claiming byte-for-byte timing equality (§2.2 below states this residual
explicitly rather than overclaiming it away).

This keeps the file's existing shape (`notificationFailed`, one `try`/`catch`, no new
variables) — the only change from the FAILed revision is *what* runs inside the `try`
block's body and *when* the blocked check is consulted (inside the block, at the point
of choosing which Bot API method to call, rather than as a guard before the block).

### 2.2 What this does and does not equalize (stated explicitly, not silently resolved)

- **Equalized:** the categorical asymmetry SECURITY-REVIEWER found — one branch
  performing zero awaits/zero network calls while the other always performs a DB read
  plus a network round-trip. Both branches now always perform the same DB read and
  always perform exactly one Telegram Bot API network round-trip before reaching
  `ctx.reply`.
- **Not claimed to be equalized, and out of scope for this fix's proportionality:**
  `getMe()`'s response payload size and exact server-side handling differ from
  `sendMessage`'s, so the two round-trips are not guaranteed to take *identical*
  microsecond-level time — a sufficiently patient attacker sampling many requests and
  averaging could in principle still detect a statistical difference. Closing that
  residual to a provable zero would require either padding `sendMessage` itself or a
  measured, continuously-recalibrated delay — disproportionate machinery for a
  MEDIUM-severity, narrow-threat-model bug fix per this task's own framing. This
  residual is named here as an open acknowledgment, not silently swept in with the
  "equalized" claim above.

Applies identically, with the file's own section-local names substituted, to:
- `makeStaffAddHandler`: the `try` block that composes/sends
  `staff.assignmentNotificationBody`.
- `makeStaffRemoveHandler`: the `try` block that composes/sends
  `staff.removalNotificationBody`.

No change to any other step in either handler (authorization, existence checks,
`addEventStaff`/`removeEventStaff` calls, or the final `ctx.reply`) — the mutation
happens exactly as it does today regardless of the target's blocked status.

---

## 3. Resolved decision — organizer-facing surfacing (ISSUE-FIXER's open question)

**Decision: surface it to the organizer, by reusing the existing `notificationFailedNote`
mechanism verbatim — do not introduce a new catalog key, and do not go fully silent.**

Reasoning, weighing the two candidates ISSUE-FIXER named:

- `sendLedgeredNotification`'s `skipped-blocked` outcome (`domain/notification.ts` step
  2) is fully silent to its caller in the sense that nothing in the current codebase
  reads a `SendOutcome` and turns it into organizer/admin-facing text — but that is
  because *none* of `sendLedgeredNotification`'s callers today are a synchronous,
  request-scoped admin action with a human waiting on a reply; they are scheduled/batch
  jobs and passive triggers (reminders, promotions) with no adjacent "acting user" to
  tell. `staff.ts` is structurally different: `makeStaffAddHandler`/`makeStaffRemoveHandler`
  are synchronous organizer commands that already have a "tell the organizer their
  intended notification didn't go through" mechanism (`notificationFailedNote`), used
  today for the mechanically different but user-facing-identical case of "the send threw
  for some other reason (e.g., the target never started the bot, or blocked it at the
  Telegram API level in a way that surfaces as a thrown error rather than as our own
  `blocked` column)."
- Practically, an organizer running `/staff_add`/`/staff_remove` is "arguably more
  entitled to know" (per this task's own framing) that the target can't be reached than
  a passive scheduled job's silent audience — they may want to follow up with that
  person out-of-band, or know the assignment "landed" administratively but the person
  hasn't been told yet.
- Reusing the **same** `notificationFailedNote` string (not a new, more specific
  "this person has blocked the bot" message) is the conservative choice: it does not
  invent new copy, does not require `CONTENT-BA` involvement for a one-line internal bug
  fix, and — importantly — does not leak the distinction "this specific person has
  blocked us" vs. "some other delivery failure occurred" to the organizer, which is a
  reasonable privacy-adjacent default absent any requirement asking for that
  granularity. This mirrors the file's own existing precedent of collapsing distinct
  underlying reasons (`tgId === null` vs. a thrown send error) into the same
  organizer-facing message shape.

No new i18n catalog key, no new function, no new flag — `notificationFailed` (existing
variable, both handlers) is the single mechanism carrying this outcome through to the
existing `if (notificationFailed) { reply += ...notificationFailedNote }` block, unchanged.

---

## 4. Acceptance criteria → design element map

| AC (ISS-0020's fix scope) | Design element |
|---|---|
| A blocked target assigned as staff receives no Telegram send | §2's guard clause — `ctx.api.sendMessage` is never called when `targetUser.blocked === true`, in `makeStaffAddHandler` |
| A blocked target removed from staff receives no Telegram send | §2's guard clause, identical shape, in `makeStaffRemoveHandler` |
| The staff assignment/removal itself still succeeds for a blocked target (S10 concerns notification delivery only, not authorization to act) | §2's closing note — the guard sits only at the notification step, after `addEventStaff`/`removeEventStaff` have already committed; no change to any earlier step |
| The organizer is told their action's notification did not reach the target | §3 — `notificationFailed` set `true` on the blocked path, surfaced via the existing `notificationFailedNote` reply-suffix, identically to the pre-existing thrown-error path |
| No other caller of `getUserByTgUsername` is broken by the widened projection | §0's `Grep` confirmation (two occurrences total: the declaration and the two `staff.ts` call sites) — §1's interface change is purely additive |
| Ledger/`sendLedgeredNotification` system is untouched | §0's confirmation that ledgered routing is structurally unavailable to `staff.ts` (no `registrationId`, no fitting `NotificationKind`) — not attempted here, per this task's scope boundary |
| The blocked-vs-other-failure distinction is not leaked via reply latency, not just reply text (SECURITY-REVIEWER `ISS-0020-SEC-1`) | §2.1 — both branches enter the same `try` block, perform the same `resolveLangForTg` DB read, and perform exactly one Telegram Bot API network round-trip (`getMe()` vs. `sendMessage()`) before `notificationFailed` is resolved and `ctx.reply` is reached; §2.2 states the residual (non-network-call) timing difference that is knowingly not eliminated, and why |

---

## 5. Open questions (not silently resolved)

1. **Whether a future requirement should give `staff.ts` a ledgered/idempotent send
   path** (e.g., extending the ledger schema to allow a nullable `registrationId` for
   non-registration notification kinds) is out of scope here, per ISSUE-FIXER's own
   scope recommendation and this task's explicit instruction not to touch the ledger
   system. Flagged as a possible future issue, not acted on.
2. **`REQ-023.md` §6.2's inaccuracy** (§0 above) is noted here as a correction but
   `REQ-023.md` itself is not edited, per this task's explicit instruction.
3. **§2.2's named residual** (sub-network-round-trip-level timing difference between
   `getMe()` and `sendMessage()`) is knowingly not eliminated in this revision, per the
   proportionality reasoning in §2.1 option 3. If a future requirement raises this
   threat model's priority (e.g., a stricter timing-side-channel policy is adopted
   project-wide), closing that residual is a follow-up, not implied as done by this fix.
