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
    blocked: boolean("blocked").notNull().default(false),
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
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    phone: text("phone"),
    email: text("email"),
    company: text("company").notNull(),
    position: text("position").notNull(),
    isStudent: boolean("is_student").notNull(),
    experienceLevel: text("experience_level").notNull(),
    linksGithub: text("links_github"),
    linksLinkedin: text("links_linkedin"),
    linksSite: text("links_site"),
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
    // No FK: no InviteCode table exists in this requirement's scope
    // (REQ-011.md §11 open question 3). A future requirement adds the FK.
    inviteCodeId: uuid("invite_code_id"),
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
