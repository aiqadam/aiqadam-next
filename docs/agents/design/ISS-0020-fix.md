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

Both `makeStaffAddHandler` and `makeStaffRemoveHandler` already have an identical shape
immediately after resolving `targetUser`: a null-`tgId` guard (lines 71-76 / 145-148)
that replies `staff.userNotFound` and returns early, treating "can't be reached" the
same as "doesn't exist" from the organizer's point of view. **The new blocked-check does
NOT reuse that same early-return shape** — it must run only at the notification step
(after the assignment/removal mutation has already been committed), not at the
existence-check step, because S10 only concerns whether the *notification* is skipped;
the staff assignment/removal itself must still happen for a blocked target exactly as it
does today (blocking the bot is not grounds to refuse an organizer's staff action).

**Rule, stated in prose (never as an executable comparison), per this role's
zero-implementation-code constraint:**

At each of the two notification steps (§4.1 step 10 / §4.2 step 9 in the file's own
section labels), immediately before the existing `try { ... await ctx.api.sendMessage(...) }`
block:

| Condition on `targetUser.blocked` | Action |
|---|---|
| `true` | Do not call `ctx.api.sendMessage` at all (the `try` block's body is not entered). Treat this outcome identically to how the existing `catch` block treats a thrown send failure: set the same `notificationFailed` flag to `true`. No new flag/variable is introduced. |
| `false` | Proceed exactly as today — enter the existing `try` block, resolve `targetLang`, compose `body`, call `ctx.api.sendMessage`. |

This is a **guard clause that skips entering the existing `try` block**, not a new
`if`/`else` around the whole handler and not a new early `return` — the function must
still reach its final `ctx.reply(reply)` (with or without `notificationFailedNote`
appended) in both the blocked and not-blocked cases, exactly as it does today for the
already-existing send-failure path. The shape is: "add one more way `notificationFailed`
can become `true`, alongside the existing `catch` path" — no new control-flow branch
beyond that single boolean's assignment.

Applies identically, with the file's own section-local names substituted, to:
- `makeStaffAddHandler`: `targetUser.blocked` checked before the `try` block that sends
  `staff.assignmentNotificationBody`.
- `makeStaffRemoveHandler`: `targetUser.blocked` checked before the `try` block that
  sends `staff.removalNotificationBody`.

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

---

## 5. Open questions (not silently resolved)

1. **Whether a future requirement should give `staff.ts` a ledgered/idempotent send
   path** (e.g., extending the ledger schema to allow a nullable `registrationId` for
   non-registration notification kinds) is out of scope here, per ISSUE-FIXER's own
   scope recommendation and this task's explicit instruction not to touch the ledger
   system. Flagged as a possible future issue, not acted on.
2. **`REQ-023.md` §6.2's inaccuracy** (§0 above) is noted here as a correction but
   `REQ-023.md` itself is not edited, per this task's explicit instruction.
