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
  // NEW, REQ-018: /checkin <event_id> — authorization-only stub (design §0.3,
  // §4.3). Performs no check-in business logic; REQ-028/029's scope.
  checkin: {
    usageNoId: string;
    notFound: string;
    notAuthorized: string;
    // Interpolated with the event title.
    authorizedStub: string;
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
}
