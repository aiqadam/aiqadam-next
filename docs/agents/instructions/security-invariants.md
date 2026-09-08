# Security & Privacy Invariants — AI Qadam Events Bot

**Audience:** `BACKEND-DEV` (must satisfy these), `SECURITY-REVIEWER` (must verify them),
`DATA-DESIGNER` (must not design them away).

**Status:** AUTHORITATIVE for the bot's security and privacy properties. Derived from the
Events Bot spec's PRD §10 (Privacy) and §12 (Invariants), plus the consent rule in its
README. Added by `docs/agents/decisions/0003-events-bot-subproject.md`.

**Scope:** `apps/bot/**`. The marketing site (`apps/web/**`) collects no personal data and
is outside this file; if that ever changes, this file's scope changes with it.

---

## How to use this file

Each item is a property with a **negative case** — the condition under which it would
fail. `core-directives.md` requires re-deriving a verdict under the conditions the
property is actually about: **verifying only the positive path is not verification.** For
each applicable item, SECURITY-REVIEWER states what it checked and how it constructed
the failing case.

An item that genuinely does not apply to a diff is marked N/A **with the reason**. A
silent skip is a FAIL of this file, not a pass of the item.

---

## S1 — Consent precedes storage

Nobody's details are stored before they have agreed, **including walk-ins added at the
door**. Three consents, one home each, never conflated:

| Consent | Stored as | Required? |
|---|---|---|
| Store my data | `User.consent_pd_at` | Yes — nothing is kept without it |
| Message me (non-transactional) | `User.broadcast_opt_in` | No — default off |
| Publish me | `Profile.publish_consent` | No — **default off**, gates speaker publication |

**Negative case:** a flow that writes a Profile row before consent is recorded; a walk-in
path that skips the consent step because it is "faster at the door"; a single boolean
serving two of the three consents.

**Carve-out — organizer's own independently-known contact data (added at REQ-040's
Step 2c sign-off, SECURITY-REVIEWER).** S1 governs data a person gives *to the bot/
organization through it*. It does not extend to a business-card fact (`name`,
`company`, `position` — never `phone`/`email`) an organizer already independently
possesses about someone who has never contacted the bot, entered on the organizer's own
operational record (e.g. REQ-040's `invite_list_entries`), structurally distinct from
`Profile` (S1's own subject-consented record) and never merged into it. Conditions for
this carve-out to apply, all required:

1. The field set is limited to what a business card/rolodex would carry — never phone,
   email, or any field `Profile` itself gates behind consent.
2. The record lives on a table structurally separate from `Profile`, with no runtime
   path that copies it there — a schema-level guarantee (no `phone`/`email` column to
   begin with), not a filter that could be bypassed (S3's discipline, reused for S1).
3. The subject is never contacted using this record without their own action first (no
   "send" path targets them — S6 of the introducing requirement's own design, or
   equivalent).
4. The record is removable by the organizer at any time and does not survive as a
   second identity once the subject's real account is known (REQ-040 §2.4's relink is
   the reference case: the placeholder is retired, never merged).

This is a narrow exception, not a general "organizer knowledge is exempt" principle — it
does not license storing anything beyond the limited business-card set above, and does
not touch `Profile`, `broadcast_opt_in`, or `publish_consent` in any way.

## S2 — Authorization is checked on the action, and the negative path is proven

Roles mean *what you may do*: `member` (own data only), `organizer` (their chapter),
`owner` (all chapters + role assignment). `EventStaff(event_id, user_id)` grants
check-in rights **for that one event and nothing else** — staff see only check-in
screens.

**Speaker is not a role.** It is derived from having an accepted Talk and grants no
permissions. A permission check that reads a "speaker" flag is a defect.

**Negative case:** an organizer of chapter A acting on chapter B's event; an `EventStaff`
member for event 1 reaching event 2's check-in or any non-check-in screen; a member
reading another member's Profile (PRD §12.6); a role check present on the menu that
renders a button but absent on the handler that performs the action.

## S3 — A member reads only their own Profile

Stated separately from S2 because it is the invariant most easily lost through a list
view, a search result, an error message, or a broadcast preview rather than through a
missing handler check.

**Negative case:** a registration list, export, or check-in screen that surfaces another
person's phone, email, or employer to someone without organizer rights.

## S4 — Tokens are unguessable and single-purpose

`qr_token` carries **≥128 bits** from a cryptographically secure source
(`crypto.randomBytes` or equivalent — never `Math.random`, never a sequential id, never a
hash of the user id). Same bar for `InviteCode` values.

A `qr_token` authorizes exactly one thing: identifying one registration at check-in. It
is not an authentication credential for anything else.

**Negative case:** a token derived from predictable input; a token that remains valid
after the event ends; a code accepted past `expires_at` or beyond `max_uses`.

## S5 — Check-in refuses correctly, and refusals are logged

| Case | Required result |
|---|---|
| Valid token, scanner is staff for that event, `admission = admitted` | Check in; set `checked_in_at`, `check_in_method = qr` |
| Already checked in | Report the existing check-in — **never a duplicate write** |
| `waitlisted` / `withdrawn` / `requested` | Refuse with reason; organizer override possible |
| Unknown token, or now past `ends_at` | Refuse |
| **Scanner is not staff** | Refuse **and write an `AuditLog` row** |

**Negative case:** the non-staff refusal that returns an error but writes no audit row —
the one case where the log matters most is an attempted unauthorized scan.

## S6 — `checked_in_at` is settable only while `admission = 'admitted'`

PRD §12.3. Attendance is not an admission state; it is a timestamp, and it may not be set
on a registration that is waitlisted, withdrawn, requested, or rejected.

**Negative case:** the manual check-in list toggling someone whose admission changed
between the list being rendered and the toggle being pressed.

## S7 — Capacity holds, and every override is logged

`seats_taken = count(admission = 'admitted')`. It exceeds `capacity` **only** via an
explicit organizer override that writes an `AuditLog` row (PRD §12.2).

**Negative case:** two concurrent registrations for the last seat both admitted — the
check and the write must be atomic, not read-then-write.

## S8 — Every status change writes exactly one `AuditLog` row

PRD §12.7. Actor, action, entity, entity id, payload, timestamp. One row — not zero, not
one per retry.

**Negative case:** a status changed through a bulk/admin path that bypasses the
audit-writing code path used by the normal path.

## S9 — Notifications are idempotent per `(registration, kind)`

PRD §12.8 and §9. A process restart, a retry, or a duplicated job run sends nothing
twice. This is a security-adjacent property because the failure mode is messaging a real
person repeatedly.

**Negative case:** the scheduler restarted mid-batch; idempotency enforced by an
in-memory set that a restart clears.

## S10 — Marketing and transactional sends are distinguished

**Transactional** (admission result, waitlist promotion, reminders, feedback request,
event cancelled) is always sent, ignoring `broadcast_opt_in`.
**Marketing** (new-event announcements, wishlist matches) requires `broadcast_opt_in` and
is capped at **2 per user per week**. `blocked` users are skipped in both cases.

**Negative case:** a broadcast segment that reaches an opted-out user because the segment
query filtered on the wrong flag, or a "programme announcement" classified as
transactional to bypass the cap.

## S11 — PII never appears in plaintext logs

Phone and email are never logged in plaintext (PRD §10). This covers application logs,
error traces, audit payloads, and anything echoed into a Telegram message to a third
party.

**Negative case:** an exception handler that logs the whole request/profile object; an
`AuditLog.payload` that captures a full profile diff including the phone.

## S12 — Exports are role-gated and audited

CSV export of registrations is available to organizers/owners only, scoped to their
chapter, and each export writes an `AuditLog` row.

**Negative case:** an export endpoint reachable by an `EventStaff` member or a plain
member; an export that ignores the chapter scope.

## S13 — Deletion anonymizes and preserves aggregates

`/profile → delete my data` anonymizes the person while keeping aggregate counts intact
(PRD §10) — show-rate and attendance history must not silently change because someone
exercised deletion.

**Negative case:** a hard delete that cascades away `Registration` rows and retroactively
alters a past event's published figures; or an "anonymization" that leaves the phone,
email, or `tg_username` recoverable.

## S14 — Publication requires explicit consent, default off

Nothing about a speaker is published without `Profile.publish_consent`. Without it the
lineup slot reads "Speaker TBA". Materials are never published without consent.

**Negative case:** a lineup rendering that falls back to showing the name when the
headline or photo is missing; consent defaulting to true for a speaker an organizer
pre-created.

---

## Relationship to REVIEWER

`REVIEWER` gates design-system compliance, code quality, and scope — it does not run this
file. `SECURITY-REVIEWER` runs this file and nothing else. A change can pass REVIEWER and
fail here; both gates must be green before the change proceeds.
