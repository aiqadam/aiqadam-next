// Catalog shape (REQ-013 §1.2). Every locale catalog (ru.ts, en.ts) must
// satisfy this interface — a missing/extra/misnamed key is a compile error
// at `npm run build -w apps/bot` time, in addition to catalogs.test.ts's
// runtime parity check (§4). Two levels: top-level key = the command/flow
// the string belongs to, second level = the specific string within that
// flow (§1.2's stated rationale for nesting over a flat key list).
//
// Pure data shape — no grammY import, no I/O (decisions/0004).

export interface Catalog {
  start: {
    greeting: string;
    // NEW, REQ-014: zero-active-chapters edge case (design §2.3) — shown
    // instead of a chapter assignment, /start continues to the consent step.
    noActiveChapters: string;
  };
  // NEW, REQ-014: shown only when >=2 active chapters exist (design §2.3).
  chapter: {
    prompt: string;
  };
  // NEW, REQ-014: the personal-data consent prompt (design §2.4). The
  // wording carries its own "(v1)" version tag inline; the version actually
  // recorded on acceptance comes from the server-side CONSENT_WORDING_VERSION
  // constant (domain/consent.ts), never from this string.
  consent: {
    prompt: string;
    agree: string;
  };
  // NEW, REQ-014: /help's entire visible response (design §4) — one lookup,
  // no string concatenation.
  help: {
    body: string;
  };
  lang: {
    prompt: string;
    confirmed: string;
    noProfile: string;
  };
  // NEW, REQ-015: venue CRUD for organizers, chapter-scoped (design §1-§6).
  // `notAuthorized` is a single generic refusal string per §1 — the reason
  // (no-user / not-organizer / wrong-chapter) is never disclosed to the
  // caller. The `*Prefix` keys are plain reply-composition prefixes the
  // handler concatenates with dynamic data (a venue id, a list of missing
  // field names, a list of changed field names) — this is reply composition
  // per §2.4's own precedent, not domain logic. Placeholder/minimal
  // functional copy (CONTENT-BA owns final wording per decisions/0002, same
  // provisional-copy precedent as REQ-014's consent.prompt).
  venue: {
    notAuthorized: string;
    notFound: string;
    createUsage: string;
    missingFieldsPrefix: string;
    createSuccessPrefix: string;
    completeNudge: string;
    editUsageNoId: string;
    editCurrentPrefix: string;
    editSuccessPrefix: string;
    deleteUsageNoId: string;
    deleteSuccessPrefix: string;
    deleteRefusedFutureEvent: string;
    listEmpty: string;
    listHeader: string;
  };
  // NEW, REQ-016: event CRUD, draft/published/cancelled transitions, publish
  // validation, e_ deep links (design §9). Same placeholder/minimal-copy
  // precedent as venue.* (CONTENT-BA owns final wording per decisions/0002).
  event: {
    notAuthorized: string;
    notFound: string;
    createUsage: string;
    missingFieldsPrefix: string;
    createSuccessPrefix: string;
    editUsageNoId: string;
    editCurrentPrefix: string;
    editSuccessPrefix: string;
    publishUsageNoId: string;
    publishSuccessPrefix: string;
    publishRefusedNotDraft: string;
    publishRefusedMissingFields: string;
    capacityBelowAdmittedFloor: string;
    cancelUsageNoId: string;
    cancelSuccessPrefix: string;
    cancelRefusedNotPublished: string;
    agendaRefusedDoorsAfterStart: string;
    agendaRefusedItemAfterEnd: string;
    agendaRefusedMultipleDoors: string;
    // NEW, REQ-027: registrant-facing cancellation notification header line.
    // Onward path reuses deepLinkSeeUpcoming below unchanged (no new key).
    cancelledNotificationHeader: string;
    deepLinkNotAvailable: string;
    deepLinkSeeUpcoming: string;
    deepLinkPublishedPlaceholder: string;
  };
  // NEW, REQ-017: /events upcoming list + event card copy. Top-level key
  // "events" (plural), distinct from "event" above — /events is its own
  // command. Placeholder/minimal functional copy per decisions/0002
  // (CONTENT-BA owns final wording).
  events: {
    listHeader: string;
    listRowSeatsLeft: string;
    listRowWaitlistOpen: string;
    followCityInvite: string;
    cardVenueLabel: string;
    cardMapYandex: string;
    cardMapGoogle: string;
    cardAgendaLabel: string;
    cardSeatsLeft: string;
    cardWaitlistOpen: string;
  };
  // NEW, REQ-018: EventStaff assign/remove by organizers (design §5).
  // `notAuthorized` is a single generic refusal string covering both the
  // organizer-only assign/remove gate's own refusal shape (checkOrganizerForChapter's
  // pre-existing string set is separate; this key is used by staff.ts's own
  // reply composition per the design). Placeholder/minimal functional copy
  // per decisions/0002 (CONTENT-BA owns final wording).
  staff: {
    notAuthorized: string;
    usageNoArgs: string;
    eventNotFound: string;
    userNotFound: string;
    alreadyAssigned: string;
    notAssigned: string;
    addSuccessPrefix: string;
    removeSuccessPrefix: string;
    notificationFailedNote: string;
    // Sent to the VOLUNTEER, never to the organizer. Interpolated with the
    // event title.
    assignmentNotificationBody: string;
    // Sent to the VOLUNTEER on removal. Interpolated with the event title.
    removalNotificationBody: string;
  };
  // NEW, REQ-018: /checkin <event_id> — authorization gate (design §0.3,
  // §4.3). NEW, REQ-028 (docs/agents/design/REQ-028.md §5): the manual
  // check-in list, its toggle, pagination, and search. `authorizedStub`
  // removed -- no caller once REQ-028's list render replaces the stub.
  checkin: {
    usageNoId: string;
    notFound: string;
    notAuthorized: string;
    // Header template. Interpolated with {event}, {checkedIn}, {total}.
    listHeader: string;
    // Shown instead of any keyboard rows when the event has zero 'admitted'
    // registrations.
    listEmpty: string;
    // Shown instead of any keyboard rows when a search query matched
    // nothing.
    searchNoMatches: string;
    // Footer line on every render, restating "/checkin <event_id> <name>"
    // (design §1.6).
    searchHint: string;
    // Interpolated with {count}, the not-shown count when search results
    // exceed SEARCH_RESULT_LIMIT (design §1.4).
    searchTruncatedNote: string;
    // Fixed prefix glyphs for a checked-in vs. not-yet-checked-in row
    // (design §4.4). Plain characters -- Telegram buttons render text only.
    checkedInGlyph: string;
    notCheckedInGlyph: string;
    // Interpolated "{current} / {total}" page-position label (design §4.4).
    pageIndicator: string;
    // The AC1 refusal alert shown when a toggle is pressed against a
    // registration whose admission is no longer 'admitted' at write time
    // (design §3.2 step 3, §4.2 step 5). Also reused for the re-authorization
    // refusal on a toggle/page callback (design §3.3, §4.2 step 3, §4.3).
    refusedNotAdmitted: string;
    // Fallback display name when a registrant has neither a name nor a
    // tg_username on file (design §2.1's displayName table, last row).
    noNameFallback: string;
  };
  // NEW, REQ-029 (docs/agents/design/REQ-029.md §7): the ci_<qr_token>
  // check-in deep link -- scan-side refusals/success and the organizer
  // override. Kept as its own top-level key, parallel to (not merged with)
  // `checkin` above -- a different flow with different reasons, on a
  // different entry point (a QR scan via /start, not the /checkin command).
  checkinQr: {
    // AC4 -- no registration matches the scanned token (also reused for the
    // token-currency recheck's own "unknown-token" outcome).
    unknownToken: string;
    // AC4 -- the event's ends_at is already in the past.
    eventEnded: string;
    // AC1 -- the scanner is not EventStaff for this event (also covers the
    // defensive "no-user" authorization reason).
    notStaff: string;
    // AC2 -- interpolated with {at} (the existing checked_in_at, formatted
    // in the event's chapter timezone) and {by} (the checking staff
    // member's display name).
    alreadyCheckedIn: string;
    // AC3 -- per-admission refusal reasons, each shown with the override
    // offer attached.
    refusedWaitlisted: string;
    refusedRequested: string;
    refusedWithdrawn: string;
    refusedRejected: string;
    // The inline button label offered alongside every refused* reply above.
    overrideButtonLabel: string;
    // The override tap's own organizer-only refusal.
    overrideNotAuthorized: string;
    // Defensive: tapped override on an already-admitted or since-vanished
    // registration.
    overrideNotApplicable: string;
    // AC6 -- the override's own success screen. Interpolated with {name},
    // {company} (may be empty, see successHeader), and {checkedIn} -- the
    // live countCheckedIn counter (design §11), reused as-is, not a
    // checked-in/total ratio.
    overrideSuccess: string;
    // AC1/AC5 -- the QR scan's own success screen. Interpolated with {name},
    // {company} (omitted with its separator when null, same rule REQ-028's
    // row label already uses), and {checkedIn} (the live counter). Never
    // phone/email.
    successHeader: string;
  };
  // NEW, REQ-019: profile capture as a resumable step-by-step form, the
  // consent gate, and the optional-field rule (design §5). Placeholder/
  // minimal functional copy per decisions/0002 (CONTENT-BA owns final
  // wording).
  profile: {
    startFirst: string;
    editHint: string;
    editRejectedPrefix: string;
    invalidAnswerPrefix: string;
    invalidEmailFormat: string;
    completedNotice: string;
    chapterPrompt: string;
    chapterUpdatedPrefix: string;
    skipButton: string;
    shareContactButton: string;
    studentYes: string;
    studentNo: string;
    experienceUser: string;
    experienceBuilder: string;
    experienceAdvanced: string;
    experienceExpert: string;
    promptFirstName: string;
    promptLastName: string;
    promptCompany: string;
    promptPosition: string;
    promptIsStudent: string;
    promptExperienceLevel: string;
    promptPhone: string;
    promptEmail: string;
    promptGithub: string;
    promptLinkedin: string;
    promptSite: string;
    labelFirstName: string;
    labelLastName: string;
    labelCompany: string;
    labelPosition: string;
    labelIsStudent: string;
    labelExperienceLevel: string;
    labelPhone: string;
    labelEmail: string;
    labelGithub: string;
    labelLinkedin: string;
    labelSite: string;
    fieldNotSet: string;
    fieldSkipped: string;
  };
  // NEW, REQ-020: registration for an open event -- the Register button, the
  // confirmed/waitlisted/already-registered/refusal reply shapes (design
  // §7.2). Placeholder/minimal functional copy per decisions/0002 (CONTENT-BA
  // owns final wording).
  registration: {
    registerButton: string;
    confirmedPrefix: string;
    whatNext: string;
    waitlistedPrefix: string;
    waitlistedPositionPrefix: string;
    waitlistedWhatNext: string;
    alreadyRegisteredPrefix: string;
    statusAdmitted: string;
    statusWaitlisted: string;
    statusRequested: string;
    statusRejected: string;
    statusWithdrawn: string;
    refusedCancelled: string;
    refusedFinished: string;
    refusedClosed: string;
    refusedRequiresInvite: string;
    refusedRequiresApproval: string;
  };
  // NEW, REQ-022: /withdraw <event_id> -- the two-step confirm/cancel UX
  // (design §4) and its refusal copy (design §2.1). Placeholder/minimal
  // functional copy per decisions/0002 (CONTENT-BA owns final wording).
  withdraw: {
    usageNoId: string;
    // Interpolated with the event title.
    confirmPrompt: string;
    confirmButton: string;
    cancelButton: string;
    confirmedReply: string;
    cancelledReply: string;
    refusedCheckedIn: string;
    refusedNotEligible: string;
    refusedNotFound: string;
  };
  // NEW, REQ-023: waitlist auto-promotion notification, sent to the promoted
  // person when a withdrawal frees their seat (design §6.3). Placeholder/
  // minimal functional copy per decisions/0002 (CONTENT-BA owns final
  // wording). Ignores broadcast_opt_in entirely (S10: transactional).
  promotion: {
    admittedPrefix: string;
    whatNext: string;
    qrLabel: string;
  };
  // NEW, REQ-024: /my registrations view (design §4). Reuses
  // catalog.registration.* status keys directly (no second, parallel set of
  // status strings). Placeholder/minimal functional copy per decisions/0002
  // (CONTENT-BA owns final wording).
  my: {
    header: string;
    emptyState: string;
    withdrawButton: string;
  };
  // NEW, REQ-026: T-24h "Still coming?" reconfirmation and T-3h route/QR
  // reminder jobs (design §6). Placeholder/minimal functional copy per
  // decisions/0002 (CONTENT-BA owns final wording).
  reminder24h: {
    prompt: string;
    confirmButton: string;
    declineButton: string;
    reconfirmedReply: string;
  };
  reminder3h: {
    header: string;
    doorsLabel: string;
    startLabel: string;
  };
  // NEW, REQ-030 (docs/agents/design/REQ-030.md §9): walk-in registration at
  // the door -- /walkin command, the confirm/cancel/override messages
  // (state carried in the message text itself, §1.1), and the success/
  // refusal copy. Placeholder/minimal functional copy per decisions/0002
  // (CONTENT-BA owns final wording).
  walkin: {
    usage: string;
    eventNotFound: string;
    notAuthorized: string;
    missingName: string;
    missingPhone: string;
    // Appended to the confirm message (§7.2) -- the door-specific consent
    // wording (STORY-DETAILS C5).
    consentStatement: string;
    // parseWalkinMessageFields failed (§8.2 step 5).
    staleMessage: string;
    eventNotReady: string;
    eventCancelled: string;
    eventFinished: string;
    alreadyCheckedIn: string;
    // AC2 -- interpolated with name, company (never phone -- AC5).
    success: string;
    // AC3 -- interpolated with {admittedCount}, {capacity}.
    overridePrompt: string;
    // Shown after Cancel/Dismiss (§8.4).
    cancelled: string;
    confirmButtonLabel: string;
    cancelButtonLabel: string;
    overrideConfirmButtonLabel: string;
    overrideDismissButtonLabel: string;
  };
}
