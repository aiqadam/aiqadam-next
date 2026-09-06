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

import {
  bigint,
  boolean,
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
