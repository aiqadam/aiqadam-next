import type { Catalog } from "./types.js";

// English catalog (REQ-013 §5 seed table). See ru.ts for the CONTENT-BA
// ownership note — same scope applies here.
export const en = {
  start: {
    greeting: "This is the AI Qadam Events bot.",
    noActiveChapters: "No chapters are available yet.",
  },
  chapter: {
    prompt: "Choose your chapter.",
  },
  // Placeholder/provisional wording (REQ-014 design §1) — carries an
  // explicit "(v1)" version identifier per AC4; not final legal copy.
  consent: {
    prompt:
      "The AI Qadam Events bot stores your Telegram ID, username and interface language to handle event registration and to reach you about it. This wording is a provisional placeholder (v1), pending review by the product owner.",
    agree: "I agree",
  },
  help: {
    body: "This bot is run by the AI Qadam community. For questions, contact the organizers of your chapter. (Placeholder: exact contact details and the community link are not yet defined.)",
  },
  lang: {
    prompt: "Choose your interface language.",
    confirmed: "Interface language: English.",
    noProfile: "No profile found. Language not saved — send /start to begin.",
  },
  // Placeholder/provisional wording (REQ-015 design §1-§6) — see ru.ts for
  // the CONTENT-BA ownership note; same scope applies here.
  venue: {
    notAuthorized: "You are not authorized to do this.",
    notFound: "Venue not found.",
    createUsage:
      "Send /venue_new followed on the next lines by:\nname: ...\naddress: ...\nyandex: ...\ngoogle: ...\ncapacity: ...\nlat: ... (optional)\nlon: ... (optional)\nnotes: ... (optional)",
    missingFieldsPrefix: "Missing required field(s):",
    createSuccessPrefix: "Venue created, id:",
    completeNudge:
      "Add coordinates later with /venue_edit <id> so the map link renders precisely.",
    editUsageNoId: "Provide the venue id: /venue_edit <id>",
    editCurrentPrefix: "Current values (send /venue_edit <id> plus the fields to change):",
    editSuccessPrefix: "Venue updated, changed field(s):",
    deleteUsageNoId: "Provide the venue id: /venue_delete <id>",
    deleteSuccessPrefix: "Venue deleted:",
    deleteRefusedFutureEvent:
      "This venue cannot be deleted: it has an upcoming event scheduled.",
    listEmpty: "No venues yet.",
    listHeader: "Venues in your chapter:",
  },
  // Placeholder/provisional wording (REQ-016 design §9) — see ru.ts for the
  // CONTENT-BA ownership note; same scope applies here.
  event: {
    notAuthorized: "You are not authorized to do this.",
    notFound: "Event not found.",
    createUsage:
      "Send /event_new followed on the next lines by:\ntitle: ...\ndescription: ...\nformat: meetup|fail_stories|workshop|hackathon\nvenue: ... (optional)\nstarts: ISO start time\nends: ISO end time\nregistration_closes: ... (optional)\ncapacity: ...\nrequires_invite: true|false (optional)\nrequires_approval: true|false (optional)\ncover_file_id: ... (optional)",
    missingFieldsPrefix: "Missing or invalid required field(s):",
    createSuccessPrefix: "Event created (draft), id:",
    editUsageNoId: "Provide the event id: /event_edit <id>",
    editCurrentPrefix: "Current values (send /event_edit <id> plus the fields to change):",
    editSuccessPrefix: "Event updated, changed field(s):",
    publishUsageNoId: "Provide the event id: /event_publish <id>",
    publishSuccessPrefix: "Event published:",
    publishRefusedNotDraft: "Only a draft event can be published.",
    publishRefusedMissingFields: "Publish refused. Missing/invalid:",
    capacityBelowAdmittedFloor: "Capacity cannot be set below the number already admitted:",
    cancelUsageNoId: "Provide the event id: /event_cancel <id>",
    cancelSuccessPrefix: "Event cancelled:",
    cancelRefusedNotPublished: "Only a published event can be cancelled.",
    agendaRefusedDoorsAfterStart: "The doors item cannot be later than the event start:",
    agendaRefusedItemAfterEnd: "An agenda item cannot be later than the event end:",
    agendaRefusedMultipleDoors: "Only one doors item is allowed in the agenda.",
    deepLinkNotAvailable: "This event isn't available right now.",
    deepLinkSeeUpcoming: "See what's coming up with /events",
    deepLinkPublishedPlaceholder: "Event:",
  },
  // NEW, REQ-017: /events upcoming list + event card copy.
  events: {
    listHeader: "Upcoming events:",
    listRowSeatsLeft: "Seats left:",
    listRowWaitlistOpen: "Waitlist open",
    followCityInvite:
      "No upcoming events in your chapter yet. Follow along — new events will show up here.",
    cardVenueLabel: "Venue:",
    cardMapYandex: "Yandex Maps:",
    cardMapGoogle: "Google Maps:",
    cardAgendaLabel: "Agenda:",
    cardSeatsLeft: "Seats left:",
    cardWaitlistOpen: "Waitlist open",
  },
  // Placeholder/provisional wording (REQ-018 design §5) — CONTENT-BA owns
  // final copy per decisions/0002.
  staff: {
    notAuthorized: "You are not authorized to do this.",
    usageNoArgs: "Send /staff_add <event_id> <tg_username> (or /staff_remove) with both arguments.",
    eventNotFound: "Event not found.",
    userNotFound: "User not found.",
    alreadyAssigned: "This user is already assigned as check-in staff for this event.",
    notAssigned: "This user is not assigned as check-in staff for this event.",
    addSuccessPrefix: "Assigned as check-in staff for event:",
    removeSuccessPrefix: "Removed as check-in staff for event:",
    notificationFailedNote: " (failed to notify the user)",
    assignmentNotificationBody:
      "You've been put on the check-in door for \"{event}\". At the door: greet the guest, ask their name, and confirm them in the list.",
    removalNotificationBody:
      "The organizer removed you as check-in staff for \"{event}\". Your check-in access for this event has ended.",
  },
  // Placeholder/provisional wording (REQ-018 design §5) — CONTENT-BA owns
  // final copy per decisions/0002. Authorization-only stub (design §0.3): no
  // check-in business logic exists yet (REQ-028/029's scope).
  checkin: {
    usageNoId: "Provide the event id: /checkin <event_id>",
    notFound: "Event not found.",
    notAuthorized: "You are not authorized to check people in for this event.",
    authorizedStub:
      "You're authorized to check people in for \"{event}\". Scanning/recording check-ins isn't built yet in this version of the bot.",
  },
  // Placeholder/provisional wording (REQ-019 design §5) — CONTENT-BA owns
  // final copy per decisions/0002.
  profile: {
    startFirst: "Send /start first.",
    editHint: "Edit: /profile_edit. Change chapter: /profile_chapter.",
    editRejectedPrefix: "Could not save, check these field(s):",
    invalidAnswerPrefix: "Could not understand that answer. ",
    invalidEmailFormat: "That doesn't look like a valid email. Try again, or tap Skip.",
    completedNotice: "Your profile is complete. Use /profile to view it.",
    chapterPrompt: "Choose your chapter.",
    chapterUpdatedPrefix: "Chapter changed to:",
    skipButton: "Skip",
    shareContactButton: "Share phone number",
    studentYes: "Yes",
    studentNo: "No",
    experienceUser: "User",
    experienceBuilder: "Builder",
    experienceAdvanced: "Advanced",
    experienceExpert: "Expert",
    promptFirstName: "What's your first name?",
    promptLastName: "What's your last name?",
    promptCompany: "Where do you work (company)?",
    promptPosition: "What's your position/role?",
    promptIsStudent: "Are you a student?",
    promptExperienceLevel: "Rate your experience level.",
    promptPhone: "Share your phone number (or tap Skip).",
    promptEmail: "What's your email? (or tap Skip)",
    promptGithub: "Your GitHub link? (or tap Skip)",
    promptLinkedin: "Your LinkedIn link? (or tap Skip)",
    promptSite: "Your website link? (or tap Skip)",
    labelFirstName: "First name:",
    labelLastName: "Last name:",
    labelCompany: "Company:",
    labelPosition: "Position:",
    labelIsStudent: "Student:",
    labelExperienceLevel: "Experience level:",
    labelPhone: "Phone:",
    labelEmail: "Email:",
    labelGithub: "GitHub:",
    labelLinkedin: "LinkedIn:",
    labelSite: "Site:",
    fieldNotSet: "not set",
    fieldSkipped: "skipped",
  },
  // Placeholder/provisional wording (REQ-020 design §8) — CONTENT-BA owns
  // final copy per decisions/0002.
  registration: {
    registerButton: "Register",
    confirmedPrefix: "You're in!",
    whatNext: "What happens next: you'll get a check-in code closer to the event.",
    waitlistedPrefix: "You're on the waitlist for:",
    waitlistedPositionPrefix: "Your position:",
    waitlistedWhatNext: "What happens next: you'll move up automatically as seats open.",
    alreadyRegisteredPrefix: "You're already registered for this event. Status:",
    statusAdmitted: "admitted",
    statusWaitlisted: "waitlisted",
    statusRequested: "requested",
    statusRejected: "rejected",
    statusWithdrawn: "withdrawn",
    refusedCancelled: "This event has been cancelled.",
    refusedFinished: "This event has already finished.",
    refusedClosed: "Registration for this event is closed.",
    refusedRequiresInvite: "This event is invite-only.",
    refusedRequiresApproval: "This event requires organizer approval to register.",
  },
  // NEW, REQ-022: /withdraw <event_id>. Placeholder/minimal functional copy
  // per decisions/0002 (CONTENT-BA owns final wording).
  withdraw: {
    usageNoId: "Provide the event id: /withdraw <event_id>",
    confirmPrompt: "Withdraw from this event?",
    confirmButton: "Yes, withdraw",
    cancelButton: "No, keep my spot",
    confirmedReply: "You've withdrawn. Your seat has been freed.",
    cancelledReply: "OK, your registration is unchanged.",
    refusedCheckedIn: "You've already checked in for this event -- attendance history can't be changed.",
    refusedNotEligible: "This registration has already been withdrawn or was rejected.",
    refusedNotFound: "Registration not found.",
  },
  // NEW, REQ-023: waitlist auto-promotion notification. Placeholder/minimal
  // functional copy per decisions/0002 (CONTENT-BA owns final wording).
  // NEW, REQ-024: /my registrations view. Placeholder/minimal functional
  // copy per decisions/0002 (CONTENT-BA owns final wording).
  my: {
    header: "Your registrations:",
    emptyState: "You have no registrations yet. Check /events to find one.",
    withdrawButton: "Withdraw",
  },
  promotion: {
    admittedPrefix: "A seat opened up — you're in!",
    whatNext: "What happens next: you'll get a check-in code closer to the event.",
    qrLabel: "Your check-in code:",
  },
} satisfies Catalog;
