// Drizzle schema for REQ-010: Chapter, User, Profile.
//
// This file is pure schema — no domain logic, no handlers (decisions/0004). It
// translates docs/agents/design/REQ-010.md §7 into drizzle-orm/pg-core table
// definitions. `tg_id` is intentionally NOT a business key anywhere in this schema
// or elsewhere in the codebase (design §5.1) — every relationship below resolves to
// the internal `id` UUID column instead.
//
// Enum-like text columns (chapters.code, chapters.default_lang, users.lang,
// users.role, profiles.experience_level) are left as `text` per the design's §7
// note: the artefact does not mandate a Postgres ENUM vs. CHECK vs.
// application-level union, only that invalid values are rejected somewhere before
// storage. That validation is left to a later requirement that owns the handlers
// which write these columns.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const chapters = pgTable(
  "chapters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    code: text("code").notNull(),
    name: text("name").notNull(),
    timezone: text("timezone").notNull(),
    defaultLang: text("default_lang").notNull(),
    // REQ-014-schema.md §1: the "one active chapter" / "two active chapters"
    // predicate /start's chapter-assignment logic reads. Plain boolean (no
    // status enum — nothing in scope describes a third chapter state),
    // NOT NULL DEFAULT true so a freshly inserted chapter is immediately
    // usable by the silent-assignment branch with no extra write.
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("chapters_code_unique").on(table.code)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    // Never a business key (design §5.1) — nullable so an organizer can
    // pre-create a User row before the person's first /start. Telegram user
    // ids exceed the 32-bit int range, hence bigint (design §2).
    tgId: bigint("tg_id", { mode: "bigint" }),
    tgUsername: text("tg_username"),
    lang: text("lang"),
    role: text("role").notNull().default("member"),
    chapterId: uuid("chapter_id").references(() => chapters.id, {
      onDelete: "restrict",
    }),
    broadcastOptIn: boolean("broadcast_opt_in").notNull().default(false),
    consentPdAt: timestamp("consent_pd_at", { withTimezone: true }),
    // REQ-014-schema.md §10: which consent wording version this user
    // accepted, set together with consentPdAt by the same write (both null
    // until consent is accepted). Text, not an integer, since the eventual
    // product-owner-supplied wording's versioning scheme is not yet known
    // (§10's reasoning) — no schema-level constraint pairs the two columns;
    // that discipline lives in the handler write (domain/consent.ts).
    consentPdVersion: text("consent_pd_version"),
    blocked: boolean("blocked").notNull().default(false),
    // REQ-016-schema.md §3: the channel suffix (e.g. "linkedin") from the
    // most recently opened `?start=e_<event_id>__<channel>` deep link, held
    // against the user (not scoped to any one event, §2's decision) until
    // REQ-020 copies it into registrations.source and clears this back to
    // NULL. Nullable — the overwhelming majority of rows never set it.
    pendingSource: text("pending_source"),
    // REQ-031-schema.md §3: nullable timestamptz, set together with
    // broadcastOptIn (above) by the same write (domain/feedback.ts's
    // writeBroadcastOptInAnswer, the ONLY function that ever writes either
    // column). NULL means "never asked"; non-null means "asked, and
    // broadcastOptIn holds the answer that was given" — the global,
    // per-user "ask once" gate REQ-031's flow reads (never re-derived from
    // broadcastOptIn's own boolean value). Mirrors consentPdAt/
    // consentPdVersion's existing pairing convention; placed immediately
    // after broadcastOptIn per that same precedent.
    broadcastOptInAskedAt: timestamp("broadcast_opt_in_asked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("users_tg_id_unique").on(table.tgId)],
);

export const profiles = pgTable(
  "profiles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // REQ-019-schema.md §2: relaxed from NOT NULL — a partial-write resumable
    // form (REQ-019, PRD FR-3) must be able to insert a row holding only some
    // of these six required columns while the rest are still unanswered.
    // Completeness is now an application-level read (domain/profile.ts's
    // isProfileComplete), never a DB constraint (§2's stated reasoning).
    firstName: text("first_name"),
    lastName: text("last_name"),
    phone: text("phone"),
    email: text("email"),
    company: text("company"),
    position: text("position"),
    isStudent: boolean("is_student"),
    experienceLevel: text("experience_level"),
    linksGithub: text("links_github"),
    linksLinkedin: text("links_linkedin"),
    linksSite: text("links_site"),
    // REQ-019-schema.md §3: durable "explicitly skipped" marker per optional
    // field, distinct from "not yet reached" (both would otherwise read back
    // as plain NULL). NOT NULL DEFAULT false — a two-valued fact must not
    // admit a third, unspecified NULL state (§3.2).
    phoneSkipped: boolean("phone_skipped").notNull().default(false),
    emailSkipped: boolean("email_skipped").notNull().default(false),
    linksGithubSkipped: boolean("links_github_skipped").notNull().default(false),
    linksLinkedinSkipped: boolean("links_linkedin_skipped").notNull().default(false),
    linksSiteSkipped: boolean("links_site_skipped").notNull().default(false),
    publicBio: text("public_bio"),
    photoFileId: text("photo_file_id"),
    publishConsent: boolean("publish_consent").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("profiles_user_id_unique").on(table.userId)],
);

// ---------------------------------------------------------------------------
// REQ-011: Venue, Event, Registration, EventStaff, AuditLog.
//
// Pure schema — no domain logic, no handlers (decisions/0004). Translates
// docs/agents/design/REQ-011.md into drizzle-orm/pg-core table definitions.
// Every person-referencing FK resolves to users.id, never tg_id (REQ-010
// §5.1, restated as binding here).
//
// `format`, `status` and `admission` are native Postgres ENUM types per the
// design's stated preference (REQ-011.md §2/§4/§8): they are the closed,
// safety-critical value sets PRD 6 states exhaustively, and the ALTER TYPE
// migration cost of ever adding a value is accepted deliberately in exchange
// for making an invalid sixth value structurally unrepresentable. The same
// choice is extended to `check_in_method` for consistency, even though the
// design leaves that one open (§4: "either implementation is fine").
//
// The computed-never-stored values (no_show, waitlist_position, seats_taken,
// registration_open, finished) have NO column anywhere in this file — see
// REQ-011.md §5 for their exact derivation expressions, each parameterized by
// an explicit $evaluation_time per decisions/0006 (never SQL now() inside a
// predicate).
// ---------------------------------------------------------------------------

export const eventFormat = pgEnum("event_format", [
  "meetup",
  "fail_stories",
  "workshop",
  "hackathon",
]);

export const eventStatus = pgEnum("event_status", [
  "draft",
  "published",
  "cancelled",
]);

export const admission = pgEnum("admission", [
  "requested",
  "waitlisted",
  "admitted",
  "rejected",
  "withdrawn",
]);

export const checkInMethod = pgEnum("check_in_method", ["qr", "manual"]);

export const venues = pgTable("venues", {
  id: uuid("id").primaryKey().defaultRandom(),
  chapterId: uuid("chapter_id")
    .notNull()
    .references(() => chapters.id, { onDelete: "restrict" }),
  name: text("name").notNull(),
  address: text("address").notNull(),
  lat: doublePrecision("lat"),
  lon: doublePrecision("lon"),
  yandexUrl: text("yandex_url"),
  googleUrl: text("google_url"),
  capacity: integer("capacity").notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  chapterId: uuid("chapter_id")
    .notNull()
    .references(() => chapters.id, { onDelete: "restrict" }),
  title: text("title").notNull(),
  description: text("description").notNull(),
  format: eventFormat("format").notNull(),
  venueId: uuid("venue_id").references(() => venues.id, {
    onDelete: "restrict",
  }),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
  registrationClosesAt: timestamp("registration_closes_at", {
    withTimezone: true,
  }),
  capacity: integer("capacity").notNull(),
  requiresInvite: boolean("requires_invite").notNull().default(false),
  requiresApproval: boolean("requires_approval").notNull().default(false),
  status: eventStatus("status").notNull().default("draft"),
  coverFileId: text("cover_file_id"),
  // Array of { kind, at, label } objects — non-talk agenda items only
  // (doors, networking, close). See REQ-011.md §3 for the doors-item query
  // shape and proof. No doors_at column exists anywhere (PRD 5).
  agenda: jsonb("agenda"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const registrations = pgTable(
  "registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    admission: admission("admission").notNull().default("requested"),
    // Attendance is NOT an admission state (PRD 6, S6) — a separate nullable
    // timestamp, enforced by the CHECK below to be settable only while
    // admission='admitted'.
    checkedInAt: timestamp("checked_in_at", { withTimezone: true }),
    checkedInBy: uuid("checked_in_by").references(() => users.id, {
      onDelete: "restrict",
    }),
    checkInMethod: checkInMethod("check_in_method"),
    reconfirmedAt: timestamp("reconfirmed_at", { withTimezone: true }),
    invitedByUserId: uuid("invited_by_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    source: text("source").notNull(),
    // REQ-033.md §3: real FK, closing REQ-011.md §11 open question 3. Still
    // nullable (unchanged) — most registrations are not invite-gated.
    // ON DELETE RESTRICT, matching every other person/event reference on
    // this table: a redeemed invite code is history and must not be
    // deletable out from under a registration.
    inviteCodeId: uuid("invite_code_id").references(() => inviteCodes.id, {
      onDelete: "restrict",
    }),
    qrToken: text("qr_token"),
    // A real stored column, sharply distinct from the derived (columnless)
    // no_show boolean — see REQ-011.md §5.
    noShowReason: text("no_show_reason"),
    // Load-bearing: waitlist position is computed by ranking created_at
    // among waitlisted rows for an event (REQ-011.md §4/§5).
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_registrations_event_user").on(
      table.eventId,
      table.userId,
    ),
    uniqueIndex("registrations_qr_token_unique").on(table.qrToken),
    // Partial index for the waitlist-ranking query (REQ-011.md §4,
    // DATA-DESIGNER's recommended shape over a plain composite index).
    index("registrations_waitlist_order_idx")
      .on(table.eventId, table.createdAt)
      .where(sql`${table.admission} = 'waitlisted'`),
    // Belt-and-suspenders DB enforcement of S6, recommended in
    // REQ-011.md §4/§11 open question 6.
    check(
      "chk_registrations_checked_in_only_if_admitted",
      sql`${table.checkedInAt} IS NULL OR ${table.admission} = 'admitted'`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// REQ-033: invite_codes, and closing registrations.invite_code_id's FK.
//
// Pure schema — no domain logic, no handlers (decisions/0004). Translates
// docs/agents/design/REQ-033.md into drizzle-orm/pg-core table definitions.
// PERSONAL/BULK/COMPANION are compositions of issuedToUserId/
// grantsCompanionOf/maxUses (design §2), not a `type` enum — no CHECK
// constraint enforces the legal combinations (design §2's own reasoning,
// mirroring REQ-011 §3's agenda doors-item precedent). Every person-
// referencing FK resolves to users.id, never tg_id (REQ-010 §5.1).
//
// usedCount is a real stored counter, not a computed-never-stored violation
// (design §1's dedicated note) — its atomic increment is REQ-038's problem,
// not this file's.
// ---------------------------------------------------------------------------

export const inviteCodes = pgTable(
  "invite_codes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    code: text("code").notNull(),
    // Nullable: null is the BULK-code shape; non-null is the PERSONAL-code
    // shape (design §2). Never users.tg_id.
    issuedToUserId: uuid("issued_to_user_id").references(() => users.id, {
      onDelete: "restrict",
    }),
    // Nullable: non-null marks the COMPANION-code shape (design §2). Never
    // users.tg_id.
    grantsCompanionOf: uuid("grants_companion_of").references(() => users.id, {
      onDelete: "restrict",
    }),
    maxUses: integer("max_uses").notNull(),
    usedCount: integer("used_count").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("invite_codes_code_unique").on(table.code)],
);

export const eventStaff = pgTable(
  "event_staff",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_event_staff_event_user").on(table.eventId, table.userId),
  ],
);

// ---------------------------------------------------------------------------
// REQ-025: notification_ledger — the send-once idempotency guard.
//
// Pure schema (decisions/0004). See docs/agents/design/REQ-025-schema.md for
// the full reasoning. This table's only job is the `UNIQUE(registration_id,
// kind)` constraint `sendLedgeredNotification` (domain/notification.ts)
// depends on to detect "already sent" after a crash/restart — it is not an
// audit trail (audit_log already owns that, S8) and carries no actor column.
//
// `kind` is deliberately `text`, not a `pgEnum` (REQ-025-schema.md §2): the
// value set grows roughly once per near-term requirement (reminder_24h/
// reminder_3h, event_cancelled, two more Release-3 marketing kinds already
// named), unlike admission/event_status's genuinely fixed sets — validated at
// the application level against the `NotificationKind` union in
// domain/notification.ts, the same precedent as audit_log.action/entity.
//
// `created_at`/`updated_at` are `DEFAULT now()` (REQ-025-schema.md §3): a
// write-time fact recording when this row was inserted, never read back into
// a decisions/0006 time-dependent predicate — not the caller-supplied-Date
// case that discipline governs.
// ---------------------------------------------------------------------------

export const notificationLedger = pgTable(
  "notification_ledger",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => registrations.id, { onDelete: "restrict" }),
    kind: text("kind").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_notification_ledger_registration_kind").on(
      table.registrationId,
      table.kind,
    ),
  ],
);

// ---------------------------------------------------------------------------
// REQ-031: feedback — 1:1 with a Registration, created only on the NPS
// answer (domain/feedback.ts's writeFeedbackNps is the sole INSERT path).
//
// Pure schema (decisions/0004). See docs/agents/design/REQ-031-schema.md for
// the full reasoning. `registrationId`'s UNIQUE index is the entire
// mechanism behind AC2 ("a second feedback row for the same registration
// fails on a database constraint") — it must hold as a database object a raw
// duplicate INSERT collides with, independent of any application code.
// `nps NOT NULL` is what makes "skipping NPS saves nothing" a schema fact:
// since no row can exist without an NPS value, "no row" and "no NPS answer"
// are the same fact, with nothing else needed to keep them in sync.
// ---------------------------------------------------------------------------

export const feedback = pgTable(
  "feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    registrationId: uuid("registration_id")
      .notNull()
      .references(() => registrations.id, { onDelete: "restrict" }),
    nps: integer("nps").notNull(),
    liked: text("liked"),
    improve: text("improve"),
    topicVotes: text("topic_votes").array(),
    likedSkipped: boolean("liked_skipped").notNull().default(false),
    improveSkipped: boolean("improve_skipped").notNull().default(false),
    topicVotesSkipped: boolean("topic_votes_skipped").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_feedback_registration_id").on(table.registrationId),
    check("chk_feedback_nps_range", sql`${table.nps} >= 0 AND ${table.nps} <= 10`),
  ],
);

// ---------------------------------------------------------------------------
// REQ-040: invite_list_entries — the named-invitation-list membership table.
//
// Pure schema — no domain logic, no handlers (decisions/0004). Translates
// docs/agents/design/REQ-040-schema.md §1 into a drizzle-orm/pg-core table
// definition. Every person-referencing FK resolves to users.id, never
// tg_id (REQ-010 §5.1). `ON DELETE RESTRICT` on every FK, matching this
// schema's uniform posture (REQ-040-schema.md §0) — no CASCADE, no SET NULL
// anywhere in this file.
//
// `registered`/`attended` are DERIVED (REQ-040.md §3.3, REQ-040-schema.md
// §6) — no column here for either. `added_at` is this table's own
// `created_at` (REQ-040-schema.md §1.1) — no separate column. Remove is a
// hard DELETE (REQ-040-schema.md §3) — no `removed_at`/`active` marker.
// ---------------------------------------------------------------------------

export const inviteListEntries = pgTable(
  "invite_list_entries",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "restrict" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // Nullable — issuing a code is a separate step from adding the entry
    // (REQ-040.md §3.1, STORY-DETAILS F9 step 2). Never a business key.
    inviteCodeId: uuid("invite_code_id").references(() => inviteCodes.id, {
      onDelete: "restrict",
    }),
    addedBy: uuid("added_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    // First-open timestamp for this entry's personal code deep link, written
    // once, guarded `IS NULL` (REQ-040.md §3.2) — a genuinely
    // unrecordable-otherwise event, justified against PRD 5 there.
    openedAt: timestamp("opened_at", { withTimezone: true }),
    // Guest business-card fields (REQ-040.md §3.4, REQ-040-schema.md §1.3) —
    // organizer's own independently-known data, per-entry, not per-person.
    // `name` is belt-and-suspenders NOT NULL (the handler already refuses a
    // blank name before the INSERT); `company`/`position` are optional, `""`
    // translated to NULL at the application level (createWalkinProfile's own
    // convention, REQ-040-schema.md §1.2).
    name: text("name").notNull(),
    company: text("company"),
    position: text("position"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("uq_invite_list_entries_event_user").on(
      table.eventId,
      table.userId,
    ),
  ],
);

export const auditLog = pgTable("audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Nullable: a genuinely system-initiated action (e.g. a scheduled job) has
  // no human actor to attribute (REQ-011.md §7).
  actorUserId: uuid("actor_user_id").references(() => users.id, {
    onDelete: "restrict",
  }),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  // Polymorphic — deliberately not a FK (REQ-011.md §7): a single column
  // cannot reference more than one target table.
  entityId: uuid("entity_id").notNull(),
  // MUST NEVER carry plaintext phone or email (S11) — application-level
  // discipline this JSONB column's type cannot itself enforce.
  payload: jsonb("payload"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
