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
}
