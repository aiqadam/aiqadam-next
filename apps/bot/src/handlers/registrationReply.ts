import type { DbClient } from "../db/client.js";
import { getEventByIdWithChapterTimezone } from "../domain/event.js";
import type { InviteRedemptionOutcome } from "../domain/inviteCode.js";
import { getWaitlistPosition, type AdmissionState } from "../domain/registration.js";
import { getVenueById } from "../domain/venue.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import { formatDateTimeInTimezone } from "../i18n/formatTimeInTimezone.js";

// docs/agents/design/REQ-038.md §5.3 -- shared by handlers/registration.ts's
// `/redeem` command AND handlers/start.ts's `i_` deep link, which converge on
// the exact same InviteRedemptionOutcome union `registerForEvent`'s own
// `register:<eventId>` callback (handlers/registration.ts) already produces
// a subset of. Extracted to its own module (rather than left file-private in
// handlers/registration.ts, where it originated as REQ-020's own
// composeRegistrationReply) so start.ts can reuse it too WITHOUT introducing
// a handlers/start.ts <-> handlers/registration.ts import cycle -- neither of
// those two files imports the other; both import only this one, which
// imports neither of them. A plumbing decision, not a business rule: the
// design's own instruction ("this is deliberately the identical composition
// function, not a second copy" / "BACKEND-DEV extends the existing function
// ... rather than duplicating") is honored by sharing the function, not by
// its specific file location.

// REQ-024 §4 -- re-exported (unchanged content/shape) so handlers/my.ts's
// existing `import { STATUS_CATALOG_KEY } from "./registration.js"` keeps
// working via registration.ts's own re-export, below.
export const STATUS_CATALOG_KEY: Record<AdmissionState, keyof ReturnType<typeof getCatalog>["registration"]> = {
  admitted: "statusAdmitted",
  waitlisted: "statusWaitlisted",
  requested: "statusRequested",
  rejected: "statusRejected",
  withdrawn: "statusWithdrawn",
};

// §7.2 (REQ-020) / §5.3 (REQ-038) — reply composition per outcome. Every
// non-invite-code kind is byte-for-byte what handlers/registration.ts's
// original composeRegistrationReply already produced, except
// "requires-invite" (REQ-038 §5.4 -- extended, not replaced: gains the new
// refusedRequiresInviteHint line plus the onward path, replacing REQ-020's
// placeholder with no onward path at all). The five new "invite-code-*"
// kinds each append the same onward-path line every other refusal in this
// function already appends (design §0 point 4).
export function composeRegistrationReply(
  outcome: InviteRedemptionOutcome,
  catalog: ReturnType<typeof getCatalog>,
  eventTitle: string,
  dateTimeText: string,
  waitlistPosition: number | null = null,
  registrationClosesAtText: string | null = null,
): string {
  switch (outcome.kind) {
    case "admitted":
      return [catalog.registration.confirmedPrefix, eventTitle, dateTimeText, catalog.registration.whatNext].join(
        "\n",
      );
    case "waitlisted": {
      // §3.2 — when a position is known, insert the position line and the
      // waitlisted-specific "what next" line; when null (§2.2's defensive
      // cases), the position line is omitted entirely (§6 open question 3).
      const lines = [catalog.registration.waitlistedPrefix, eventTitle, dateTimeText];
      if (waitlistPosition !== null) {
        lines.push(`${catalog.registration.waitlistedPositionPrefix} ${waitlistPosition}`);
      }
      lines.push(catalog.registration.waitlistedWhatNext);
      return lines.join("\n");
    }
    case "already-registered": {
      const statusKey = STATUS_CATALOG_KEY[outcome.admission];
      return [
        catalog.registration.alreadyRegisteredPrefix,
        catalog.registration[statusKey],
        eventTitle,
        dateTimeText,
      ].join("\n");
    }
    case "event-cancelled":
      return [catalog.registration.refusedCancelled, catalog.event.deepLinkSeeUpcoming].join("\n");
    case "event-finished":
      return [catalog.registration.refusedFinished, catalog.event.deepLinkSeeUpcoming].join("\n");
    case "registration-closed":
      return [catalog.registration.refusedClosed, catalog.event.deepLinkSeeUpcoming].join("\n");
    case "requires-invite":
      // docs/agents/design/REQ-038.md §5.4 — extended, not replaced: the
      // REQ-020 placeholder (no onward path) gains a hint line naming
      // /redeem plus the same onward path every other refusal appends.
      // Reachable only when hasPastCheckIn returned false -- a past
      // attendee never reaches this branch at all.
      return [
        catalog.registration.refusedRequiresInvite,
        catalog.registration.refusedRequiresInviteHint,
        catalog.event.deepLinkSeeUpcoming,
      ].join("\n");
    case "requested": {
      // docs/agents/design/REQ-034.md §3.2 — lines 4/4' are mutually
      // exclusive: the formatted registration_closes_at text when the event
      // has one, the fixed fallback string when it does not.
      const lines = [catalog.registration.requestedPrefix, eventTitle, dateTimeText];
      lines.push(
        registrationClosesAtText !== null
          ? `${catalog.registration.requestedDecisionByPrefix} ${registrationClosesAtText}`
          : catalog.registration.requestedDecisionByFallback,
      );
      lines.push(catalog.registration.requestedWhatNext);
      return lines.join("\n");
    }
    case "not-found":
      return [catalog.event.deepLinkNotAvailable, catalog.event.deepLinkSeeUpcoming].join("\n");
    // docs/agents/design/REQ-038.md §5.3 — the five new invite-code
    // refusals, each with its own stated reason plus the onward path.
    case "invite-code-not-found":
      return [catalog.registration.refusedInviteCodeNotFound, catalog.event.deepLinkSeeUpcoming].join("\n");
    case "invite-code-expired":
      return [catalog.registration.refusedInviteCodeExpired, catalog.event.deepLinkSeeUpcoming].join("\n");
    case "invite-code-spent":
      return [catalog.registration.refusedInviteCodeSpent, catalog.event.deepLinkSeeUpcoming].join("\n");
    case "invite-code-wrong-event":
      return [catalog.registration.refusedInviteCodeWrongEvent, catalog.event.deepLinkSeeUpcoming].join("\n");
    case "invite-code-not-yours":
      return [catalog.registration.refusedInviteCodeNotYours, catalog.event.deepLinkSeeUpcoming].join("\n");
  }
}

// docs/agents/design/REQ-038.md §4.2 point 3 / §5.3 — the display-data
// resolution both the `i_` deep link (handlers/start.ts) and the `/redeem`
// command (handlers/registration.ts) need, factored out once rather than
// duplicated twice, mirroring handlers/registration.ts's own
// makeRegisterCallbackHandler resolution (left untouched -- that existing
// call site is not part of this requirement's file-change manifest).
// `eventId: null` (the bare i_<code> deep link before its target event is
// independently known) yields the all-empty/null defaults -- the same
// defensive shape §2.2's own null-event branches already produce.
export interface RegistrationOutcomeDisplayData {
  eventTitle: string;
  dateTimeText: string;
  waitlistPosition: number | null;
  registrationClosesAtText: string | null;
}

export async function resolveRegistrationOutcomeDisplayData(
  db: DbClient["db"],
  outcome: InviteRedemptionOutcome,
  eventId: string | null,
  lang: BotLang,
): Promise<RegistrationOutcomeDisplayData> {
  let eventTitle = "";
  let dateTimeText = "";
  let waitlistPosition: number | null = null;
  let registrationClosesAtText: string | null = null;

  const needsDisplay =
    outcome.kind === "admitted" ||
    outcome.kind === "waitlisted" ||
    outcome.kind === "already-registered" ||
    outcome.kind === "requested";

  if (eventId !== null && needsDisplay) {
    const event = await getEventByIdWithChapterTimezone(db, eventId);
    if (event !== null) {
      eventTitle = event.title;
      const startsAtText =
        event.startsAt !== null ? formatDateTimeInTimezone(event.startsAt, event.chapterTimezone, lang) : "";
      const endsAtText =
        event.endsAt !== null ? formatDateTimeInTimezone(event.endsAt, event.chapterTimezone, lang) : "";
      dateTimeText = `${startsAtText}–${endsAtText}`;
      if (event.venueId !== null) {
        await getVenueById(db, event.venueId);
      }
      if (outcome.kind === "requested") {
        registrationClosesAtText =
          event.registrationClosesAt !== null
            ? formatDateTimeInTimezone(event.registrationClosesAt, event.chapterTimezone, lang)
            : null;
      }
    }
    if (outcome.kind === "waitlisted" && "registrationId" in outcome && outcome.registrationId !== undefined) {
      waitlistPosition = await getWaitlistPosition(db, eventId, outcome.registrationId);
    }
  }

  return { eventTitle, dateTimeText, waitlistPosition, registrationClosesAtText };
}
