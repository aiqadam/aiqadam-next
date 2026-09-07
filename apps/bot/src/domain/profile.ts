import { eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { profiles } from "../db/schema.js";
import type { getCatalog } from "../i18n/catalog.js";

// REQ-019 §2 — profile field model, resumability derivation, validation,
// mutations. Framework-free (decisions/0004): no grammY import anywhere in
// this file. Every time-dependent write takes the evaluation/write time as an
// explicit parameter (decisions/0006) — this file never calls SQL now()
// inside a predicate (createdAt/updatedAt defaults are the exempted
// audit/bookkeeping case).

// ---------------------------------------------------------------------------
// §2.1 — fixed field order, exactly the requirement's own listed sequence.
// ---------------------------------------------------------------------------
export const REQUIRED_PROFILE_FIELDS = [
  "firstName",
  "lastName",
  "company",
  "position",
  "isStudent",
  "experienceLevel",
] as const;

export const OPTIONAL_PROFILE_FIELDS = [
  "phone",
  "email",
  "linksGithub",
  "linksLinkedin",
  "linksSite",
] as const;

export type RequiredProfileField = (typeof REQUIRED_PROFILE_FIELDS)[number];
export type OptionalProfileField = (typeof OPTIONAL_PROFILE_FIELDS)[number];
export type ProfileField = RequiredProfileField | OptionalProfileField;

// ---------------------------------------------------------------------------
// §2.2 — reading current state and deriving the next step.
// ---------------------------------------------------------------------------
export interface ProfileRecord {
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  position: string | null;
  isStudent: boolean | null;
  experienceLevel: string | null;
  phone: string | null;
  email: string | null;
  linksGithub: string | null;
  linksLinkedin: string | null;
  linksSite: string | null;
  phoneSkipped: boolean;
  emailSkipped: boolean;
  linksGithubSkipped: boolean;
  linksLinkedinSkipped: boolean;
  linksSiteSkipped: boolean;
}

const OPTIONAL_SKIPPED_KEY: Record<OptionalProfileField, keyof ProfileRecord> = {
  phone: "phoneSkipped",
  email: "emailSkipped",
  linksGithub: "linksGithubSkipped",
  linksLinkedin: "linksLinkedinSkipped",
  linksSite: "linksSiteSkipped",
};

export async function getProfileByUserId(
  db: DbClient["db"],
  userId: string,
): Promise<ProfileRecord | null> {
  const rows = await db
    .select({
      firstName: profiles.firstName,
      lastName: profiles.lastName,
      company: profiles.company,
      position: profiles.position,
      isStudent: profiles.isStudent,
      experienceLevel: profiles.experienceLevel,
      phone: profiles.phone,
      email: profiles.email,
      linksGithub: profiles.linksGithub,
      linksLinkedin: profiles.linksLinkedin,
      linksSite: profiles.linksSite,
      phoneSkipped: profiles.phoneSkipped,
      emailSkipped: profiles.emailSkipped,
      linksGithubSkipped: profiles.linksGithubSkipped,
      linksLinkedinSkipped: profiles.linksLinkedinSkipped,
      linksSiteSkipped: profiles.linksSiteSkipped,
    })
    .from(profiles)
    .where(eq(profiles.userId, userId))
    .limit(1);
  return rows[0] ?? null;
}

export type ProfileFieldStep = { kind: "field"; field: ProfileField } | { kind: "complete" };

// §2.2's rule table, stated exactly — never re-derived differently by a
// caller. Pure, no I/O beyond the ProfileRecord the caller already fetched.
export function determineNextProfileField(profile: ProfileRecord | null): ProfileFieldStep {
  for (const field of REQUIRED_PROFILE_FIELDS) {
    const value = profile === null ? null : profile[field];
    if (value === null || value === undefined) {
      return { kind: "field", field };
    }
  }

  for (const field of OPTIONAL_PROFILE_FIELDS) {
    // profile is guaranteed non-null here: the loop above already returned
    // for a null profile at its very first iteration (firstName is always
    // null on a null profile).
    const record = profile as ProfileRecord;
    const value = record[field];
    const skipped = record[OPTIONAL_SKIPPED_KEY[field]] as boolean;
    if ((value === null || value === undefined) && !skipped) {
      return { kind: "field", field };
    }
  }

  return { kind: "complete" };
}

// §2.2 — thin, separately named predicate for callers outside the
// step-progression flow. Never reimplements the rule independently.
export function isProfileComplete(profile: ProfileRecord | null): boolean {
  return determineNextProfileField(profile).kind === "complete";
}

// ---------------------------------------------------------------------------
// §2.3 — validation rules.
// ---------------------------------------------------------------------------
export function isNonBlank(value: string): boolean {
  return value.trim().length > 0;
}

// §2.3 — accepts a single conventional local-part@domain shape: a non-empty
// local part, an "@", and a domain containing at least one "." with a
// non-empty label on each side, no internal whitespace anywhere. Called only
// on an already-confirmed-non-blank answer (callers' own responsibility).
const EMAIL_FORMAT_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isValidEmailFormat(value: string): boolean {
  if (value.length === 0 || /\s/.test(value)) {
    return false;
  }
  return EMAIL_FORMAT_PATTERN.test(value);
}

export function isValidStudentAnswer(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "yes" || normalized === "no";
}

const EXPERIENCE_LEVELS = ["user", "builder", "advanced", "expert"] as const;
export type ExperienceLevel = (typeof EXPERIENCE_LEVELS)[number];

export function isValidExperienceLevelAnswer(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (EXPERIENCE_LEVELS as readonly string[]).includes(normalized);
}

// ---------------------------------------------------------------------------
// §2.4 — writing an answer: insert-if-absent, else update-one-column.
// ---------------------------------------------------------------------------
// §2.4 — the ONLY write path for a required field, whether the row exists yet
// or not, mirroring resolveOrCreateUser's insert-or-update shape
// (domain/user.ts §2.2) adapted to a single named column.
export async function writeRequiredProfileField(
  db: DbClient["db"],
  userId: string,
  field: RequiredProfileField,
  value: string | boolean,
  at: Date,
): Promise<void> {
  await db
    .insert(profiles)
    .values({ userId, [field]: value, updatedAt: at })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: { [field]: value, updatedAt: at } as Record<string, unknown>,
    });
}

// §2.4 — same upsert shape, additionally clearing that field's *Skipped flag
// back to false in the same statement (answering after having skipped
// un-skips — there is no "answered AND skipped" state).
export async function writeOptionalProfileField(
  db: DbClient["db"],
  userId: string,
  field: OptionalProfileField,
  value: string,
  at: Date,
): Promise<void> {
  const skippedKey = OPTIONAL_SKIPPED_KEY[field] as string;
  await db
    .insert(profiles)
    .values({ userId, [field]: value, [skippedKey]: false, updatedAt: at })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: { [field]: value, [skippedKey]: false, updatedAt: at } as Record<string, unknown>,
    });
}

// §2.4 — INSERT-if-absent / UPDATE the field's *Skipped flag to true. Never
// touches the field's own value column — a skip leaves it NULL, distinguished
// from "not yet reached" purely by this flag.
export async function markOptionalProfileFieldSkipped(
  db: DbClient["db"],
  userId: string,
  field: OptionalProfileField,
  at: Date,
): Promise<void> {
  const skippedKey = OPTIONAL_SKIPPED_KEY[field] as string;
  await db
    .insert(profiles)
    .values({ userId, [skippedKey]: true, updatedAt: at })
    .onConflictDoUpdate({
      target: profiles.userId,
      set: { [skippedKey]: true, updatedAt: at } as Record<string, unknown>,
    });
}

// ---------------------------------------------------------------------------
// §4.2 — parseProfileEditFields / validateProfileEditInput (moved here from
// the handler file per §4.2's own note: this domain's own parser).
// ---------------------------------------------------------------------------
export function parseProfileEditFields(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const separatorIndex = line.indexOf(":");
    if (separatorIndex === -1) {
      continue;
    }
    const label = line.slice(0, separatorIndex).trim().toLowerCase();
    const value = line.slice(separatorIndex + 1).trim();
    if (label.length === 0) {
      continue;
    }
    result[label] = value;
  }
  return result;
}

export type ProfileEditValidation =
  | { ok: true; updates: Partial<Record<ProfileField, string | boolean | "skip">> }
  | { ok: false; invalid: string[] };

const REQUIRED_LABEL_FIELD: Record<string, RequiredProfileField> = {
  first_name: "firstName",
  last_name: "lastName",
  company: "company",
  position: "position",
  student: "isStudent",
  experience: "experienceLevel",
};

const OPTIONAL_LABEL_FIELD: Record<string, OptionalProfileField> = {
  phone: "phone",
  email: "email",
  github: "linksGithub",
  linkedin: "linksLinkedin",
  site: "linksSite",
};

// §4.2's table — unrecognized labels ignored (forward-compatible, matching
// parseVenueFields'/parseEventFields' own precedent); a label absent from the
// text leaves that field untouched (partial update, not a full replace).
export function validateProfileEditInput(fields: Record<string, string>): ProfileEditValidation {
  const invalid: string[] = [];
  const updates: Partial<Record<ProfileField, string | boolean | "skip">> = {};

  for (const [label, rawValue] of Object.entries(fields)) {
    const requiredField = REQUIRED_LABEL_FIELD[label];
    if (requiredField !== undefined) {
      if (requiredField === "isStudent") {
        if (!isValidStudentAnswer(rawValue)) {
          invalid.push(label);
        } else {
          updates[requiredField] = rawValue.trim().toLowerCase() === "yes";
        }
      } else if (requiredField === "experienceLevel") {
        if (!isValidExperienceLevelAnswer(rawValue)) {
          invalid.push(label);
        } else {
          updates[requiredField] = rawValue.trim().toLowerCase();
        }
      } else if (!isNonBlank(rawValue)) {
        invalid.push(label);
      } else {
        updates[requiredField] = rawValue.trim();
      }
      continue;
    }

    const optionalField = OPTIONAL_LABEL_FIELD[label];
    if (optionalField !== undefined) {
      if (rawValue.trim().toLowerCase() === "skip") {
        updates[optionalField] = "skip";
        continue;
      }
      if (!isNonBlank(rawValue)) {
        invalid.push(label);
        continue;
      }
      if (optionalField === "email" && !isValidEmailFormat(rawValue.trim())) {
        invalid.push(label);
        continue;
      }
      updates[optionalField] = rawValue.trim();
    }
    // Unrecognized label: ignored per §4.2's forward-compatibility rule.
  }

  if (invalid.length > 0) {
    return { ok: false, invalid };
  }
  return { ok: true, updates };
}

// ---------------------------------------------------------------------------
// §2.5 — formatProfileDump, the view surface. S11's redaction rule does NOT
// apply here — this is a direct reply to the same person whose data it is
// (§2.5's own stated exception), never a log line, error message, or audit
// payload.
// ---------------------------------------------------------------------------
type ProfileCatalog = ReturnType<typeof getCatalog>["profile"];

function formatOptionalLine(
  label: string,
  value: string | null,
  skipped: boolean,
  catalog: ProfileCatalog,
): string {
  if (skipped) {
    return `${label} ${catalog.fieldSkipped}`;
  }
  if (value === null) {
    return `${label} ${catalog.fieldNotSet}`;
  }
  return `${label} ${value}`;
}

export function formatProfileDump(
  profile: ProfileRecord,
  catalog: ReturnType<typeof getCatalog>,
): string {
  const p = catalog.profile;
  const lines: string[] = [
    `${p.labelFirstName} ${profile.firstName ?? p.fieldNotSet}`,
    `${p.labelLastName} ${profile.lastName ?? p.fieldNotSet}`,
    `${p.labelCompany} ${profile.company ?? p.fieldNotSet}`,
    `${p.labelPosition} ${profile.position ?? p.fieldNotSet}`,
    `${p.labelIsStudent} ${
      profile.isStudent === null ? p.fieldNotSet : profile.isStudent ? p.studentYes : p.studentNo
    }`,
    `${p.labelExperienceLevel} ${profile.experienceLevel ?? p.fieldNotSet}`,
    formatOptionalLine(p.labelPhone, profile.phone, profile.phoneSkipped, p),
    formatOptionalLine(p.labelEmail, profile.email, profile.emailSkipped, p),
    formatOptionalLine(p.labelGithub, profile.linksGithub, profile.linksGithubSkipped, p),
    formatOptionalLine(p.labelLinkedin, profile.linksLinkedin, profile.linksLinkedinSkipped, p),
    formatOptionalLine(p.labelSite, profile.linksSite, profile.linksSiteSkipped, p),
  ];
  return lines.join("\n");
}
