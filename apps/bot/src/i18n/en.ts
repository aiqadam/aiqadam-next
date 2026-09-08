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
    cancelledNotificationHeader: "This event has been cancelled:",
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
  // Placeholder/provisional wording (REQ-018 design §5, REQ-028 design §5) —
  // CONTENT-BA owns final copy per decisions/0002.
  checkin: {
    usageNoId: "Provide the event id: /checkin <event_id>",
    notFound: "Event not found.",
    notAuthorized: "You are not authorized to check people in for this event.",
    listHeader: "Event: {event}\nChecked in: {checkedIn} / {total}",
    listEmpty: "No admitted attendees for this event yet.",
    searchNoMatches: "No one matched that search.",
    searchHint: "To search for a guest, send /checkin <event_id> <name>.",
    searchTruncatedNote: "And {count} more. Refine your search to narrow the list.",
    checkedInGlyph: "✅",
    notCheckedInGlyph: "▫️",
    pageIndicator: "{current} / {total}",
    refusedNotAdmitted: "Can't check in: this attendee's status has changed.",
    noNameFallback: "No name on file",
  },
  // Placeholder/provisional wording (REQ-029 design §7) — CONTENT-BA owns
  // final copy per decisions/0002.
  checkinQr: {
    unknownToken: "This check-in code is not recognized.",
    eventEnded: "This event has already ended.",
    notStaff: "You are not authorized to check people in for this event.",
    alreadyCheckedIn: "Already checked in at {at} by {by}.",
    refusedWaitlisted: "Can't check in: this attendee is on the waitlist, not admitted.",
    refusedRequested: "Can't check in: this attendee's registration is still pending approval.",
    refusedWithdrawn: "Can't check in: this attendee withdrew their registration.",
    refusedRejected: "Can't check in: this attendee's registration was rejected.",
    overrideButtonLabel: "Override: admit and check in",
    overrideNotAuthorized: "Only an organizer can override this.",
    overrideNotApplicable: "This registration no longer needs an override.",
    overrideSuccess: "Admitted and checked in: {name}{company}. Checked in so far: {checkedIn}.",
    successHeader: "Checked in: {name}{company}. Checked in so far: {checkedIn}.",
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
    requestedPrefix: "Your request has been sent for:",
    requestedDecisionByPrefix: "You'll hear back by:",
    requestedDecisionByFallback: "You'll hear back before the event starts.",
    requestedWhatNext: "What happens next: if approved, you'll get a check-in code.",
    refusedRequiresInviteHint: "If you have an invite code, use /redeem <event_id> <code>.",
    refusedInviteCodeNotFound: "That invite code isn't recognized.",
    refusedInviteCodeExpired: "That invite code has expired.",
    refusedInviteCodeSpent: "That invite code has already been used up.",
    refusedInviteCodeWrongEvent: "That invite code is for a different event.",
    refusedInviteCodeNotYours: "That invite code was issued to someone else.",
    redeemUsage: "Usage: /redeem <event_id> <code>",
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
  // NEW, REQ-026: T-24h "Still coming?" reconfirmation and T-3h route/QR
  // reminders. Placeholder/minimal functional copy per decisions/0002
  // (CONTENT-BA owns final wording).
  reminder24h: {
    prompt: "Still coming to this event?",
    confirmButton: "I'll be there",
    declineButton: "Can't make it",
    reconfirmedReply: "Great, see you there!",
  },
  reminder3h: {
    header: "Getting close! Here's how to get there:",
    doorsLabel: "Doors open:",
    startLabel: "Starts:",
  },
  // NEW, REQ-030: walk-in registration at the door. Placeholder/minimal
  // functional copy per decisions/0002 (CONTENT-BA owns final wording).
  walkin: {
    usage: "Usage: /walkin <event_id> <name>|<company>|<phone>",
    eventNotFound: "Event not found.",
    notAuthorized: "You don't have organizer rights for this event.",
    missingName: "Please provide a name.",
    missingPhone: "Please provide a phone number.",
    consentStatement:
      "By registering this person, you confirm they have agreed to have their data stored.",
    staleMessage: "This message is stale. Please run /walkin again.",
    eventNotReady: "This event isn't ready for registration yet.",
    eventCancelled: "This event has been cancelled.",
    eventFinished: "This event has already finished.",
    alreadyCheckedIn: "This person has already checked in for this event.",
    success: "Done: {name}{company} is registered and checked in.",
    overridePrompt: "No seats left ({admittedCount}/{capacity}). Add anyway?",
    cancelled: "Cancelled, nothing was saved.",
    confirmButtonLabel: "Confirm",
    cancelButtonLabel: "Cancel",
    overrideConfirmButtonLabel: "Add anyway",
    overrideDismissButtonLabel: "Don't add",
  },
  feedback: {
    npsPrompt: "On a scale of 0-10, how likely are you to recommend this event to a friend?",
    reminderPrefix: "Reminder: ",
    likedPrompt: "What did you like most? (or reply \"skip\" to skip)",
    improvePrompt: "What should we improve? (or reply \"skip\" to skip)",
    topicVotesPrompt: "What topics would you like at future events? (or reply \"skip\" to skip)",
    skipButton: "skip",
    broadcastAskPrompt: "May we message you about future events?",
    broadcastYesLabel: "Yes",
    broadcastNoLabel: "No",
    completedNotice: "Thanks for your feedback!",
    staleMessage: "This message is stale.",
    notYourFeedback: "This isn't your feedback.",
    refLinePrefix: "Feedback ref: ",
    fieldLinePrefix: "Feedback field: ",
  },
  // Placeholder/provisional wording (REQ-032 design §5.1, AC7) — plain,
  // factual, blame-free copy, no framing that assigns fault. Provisional
  // pending the product owner; see this requirement's handoff result.issues.
  noShow: {
    prompt:
      "We noticed there's no check-in recorded for this event. Would you like to share what got in the way?",
    reasonWorkRanOver: "Work ran over",
    reasonIllness: "Got sick",
    reasonForgot: "Forgot about it",
    reasonTransport: "Transport issues",
    reasonLostInterest: "Lost interest in the topic",
    otherLabel: "Other",
    otherPrompt: "Tell us in your own words what got in the way.",
    thanksMessage: "Thanks, we've recorded your answer.",
    alreadyAnswered: "An answer for this event is already recorded.",
    staleMessage: "This message is stale.",
    notYours: "This message isn't addressed to you.",
    refLinePrefix: "No-show ref: ",
  },
  // Placeholder/provisional wording (REQ-035 design §7) -- CONTENT-BA owns
  // final copy per decisions/0002.
  organizerRequests: {
    usageNoId: "Provide the event id: /requests <event_id>",
    notAuthorized: "Only an organizer for this chapter can view requests.",
    eventNotFound: "Event not found.",
    listHeader: "Pending requests for {event} ({count})",
    listEmpty: "No pending requests.",
    searchNoMatches: "No one matched that search.",
    searchHint: "To search for a requester, send /requests <event_id> <name>.",
    noLongerPending: "This request has already been decided.",
    detailSourceLabel: "Source:",
    overrideConfirmPrompt: "{admittedCount}/{capacity} seats are already admitted. Approve anyway?",
    overrideConfirmButton: "Approve anyway",
    overrideCancelButton: "Cancel",
    overrideCancelledNote: "Cancelled -- no changes made.",
    approveButton: "Approve",
    rejectButton: "Reject",
    rejectReasonPrompt: "Enter a reason for rejecting this request:",
    approvedNotification: "You've been approved for {event}! Your check-in code is ready -- see /my.",
    approvedReplyToOrganizer: "Approved.",
    rejectedNotificationPrefix: "Your request for {event} was not approved this time.",
    rejectedNotificationReasonPrefix: "Reason:",
    rejectedReplyToOrganizer: "Rejected.",
    // Provisional/placeholder wording (REQ-036 design §5) -- product owner
    // owns final copy; recorded as provisional in this requirement's own
    // implementation handoff per REQ-014/REQ-032 precedent.
    urgentMarker: "[Urgent] ",
    urgentNotification:
      "A request for {event} is still pending 48 hours before it starts. Review it with /requests.",
  },
  // Provisional/placeholder wording (REQ-037 design §7) -- product owner and
  // CONTENT-BA own final copy; recorded as provisional in this requirement's
  // own implementation handoff per REQ-014/REQ-032/REQ-036 precedent.
  inviteCodes: {
    usageNoIdPersonal: "Usage: /invite_personal <event_id> <user_id> [expires_at]",
    usageNoIdBulk: "Usage: /invite_bulk <event_id> <max_uses> [expires_at]",
    usageNoIdCompanion: "Usage: /invite_companion <event_id> <host_user_id> [expires_at]",
    eventNotFound: "Event not found.",
    notAuthorized: "Only an organizer for this chapter can issue invite codes.",
    eventCancelled: "This event is cancelled -- no code can be issued.",
    eventFinished: "This event has already finished -- no code can be issued.",
    userNotFound: "No user with that id exists.",
    invalidMaxUses: "max_uses must be a whole number greater than 1.",
    invalidExpiresAt: "Could not read that expiry date/time.",
    issuedReply:
      "Code issued: {code}\nLink: {link}\nShare this yourself -- the bot cannot message someone who hasn't started it.",
    listHeader: "Invite codes for {event} ({count})",
    listEmpty: "No invite codes issued yet.",
    codeRowLabel: "{code} ({usedCount}/{maxUses})",
    detailHeader: "{code} -- {usedCount}/{maxUses} used",
    detailEmpty: "Not yet redeemed.",
    detailRedeemerLine: "{displayName} -- {company}",
    shapeLabelPersonal: "Personal",
    shapeLabelBulk: "Bulk",
    shapeLabelCompanion: "Companion",
  },
  // Provisional/placeholder wording (REQ-036 design §5) -- product owner
  // owns final copy. Plain, factual, blame-free: states that no decision
  // was reached in time, never that the person was judged and found
  // lacking.
  autoDecline: {
    notification:
      "Your request for {event} was not decided before registration closed, so it could not be approved. Nobody reviewed and declined it -- the window simply closed before a decision was made.",
  },
  // Provisional/placeholder wording (REQ-039 design §3.2/§4/§6) -- product
  // owner/CONTENT-BA owns final copy per decisions/0002.
  companion: {
    fieldsPrompt:
      "Reply to this message with your Name | Company | Phone to complete your registration for {event}.",
    missingName: "A name is required. Please reply again with Name | Company | Phone.",
    missingPhone: "A phone number is required. Please reply again with Name | Company | Phone.",
    confirmStatement: "By confirming, you agree to have this information stored for this registration.",
    staleMessage: "This confirmation is no longer valid. Please open the invite link again.",
    confirmButtonLabel: "Confirm & register",
    cancelButtonLabel: "Cancel",
    cancelled: "Cancelled -- nothing was saved.",
    hostNotification: "Your guest {name}{company} has registered using your companion invite.",
    refLinePrefix: "Companion code: ",
  },
  // Provisional/placeholder wording (REQ-040 design §4/§8 open question 2) --
  // product owner/CONTENT-BA owns final copy per decisions/0002.
  inviteList: {
    usageAddMissingEventId: "Usage: /invite_list_add <event_id> <name> | <company> | <position>",
    usageAddMissingName: "A name is required. Usage: /invite_list_add <event_id> <name> | <company> | <position>",
    eventNotFound: "Event not found.",
    notAuthorized: "Only an organizer for this chapter can manage the invitation list.",
    addedReply: "Added {name} to the list (user id: {userId}).",
    listHeader: "Invitation list for {event} ({count})",
    listEmpty: "No one on the list yet.",
    statusInvited: "invited",
    statusOpened: "opened",
    statusRegistered: "registered",
    statusAttended: "attended",
    entryRowLabel: "{name} -- {status}",
    issueButtonLabel: "Issue code",
    removeButtonLabel: "Remove",
    issuedReply:
      "Code issued: {code}\nLink: {link}\nShare this yourself -- the bot cannot message someone who hasn't started it.",
    removeConfirmPrompt: "Remove this person from the invitation list?",
    removeConfirmButtonLabel: "Remove",
    removeCancelButtonLabel: "Cancel",
    removedReply: "Removed from the list.",
    removeCancelledNote: "Cancelled -- nothing was removed.",
    entryNotFound: "That list entry no longer exists.",
  },
} satisfies Catalog;
