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
    cardCta: "Reply here to register — registration through the bot isn't built yet.",
  },
} satisfies Catalog;
