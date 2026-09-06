import { and, eq } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { events, registrations, users } from "../db/schema.js";
import { writeAuditLog } from "./auditLog.js";

// REQ-016 §2-§7 — event CRUD domain logic. Framework-free (decisions/0004):
// no grammY import anywhere in this file. Every time-dependent predicate
// takes the evaluation time as an explicit parameter (decisions/0006) — this
// file never calls SQL now()/current_timestamp inside a predicate.

const EVENT_FORMATS = ["meetup", "fail_stories", "workshop", "hackathon"] as const;
type EventFormat = (typeof EVENT_FORMATS)[number];

function isEventFormat(value: string): value is EventFormat {
  return (EVENT_FORMATS as readonly string[]).includes(value);
}

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

// ---------------------------------------------------------------------------
// §2.1 — parseEventFields: identical shape to REQ-015's parseVenueFields.
// ---------------------------------------------------------------------------
export function parseEventFields(text: string): Record<string, string> {
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

// ---------------------------------------------------------------------------
// §7 — agenda item shape and validation.
// ---------------------------------------------------------------------------
export interface AgendaItem {
  kind: string;
  at: string; // ISO timestamp
  label: string;
}

export type AgendaValidation =
  | { ok: true }
  | { ok: false; reason: "doors-after-start"; item: AgendaItem }
  | { ok: false; reason: "item-after-end"; item: AgendaItem }
  | { ok: false; reason: "multiple-doors" };

// §7.1 — pure predicate over the full candidate replacement array. No I/O,
// unit-testable without a DB. Logic stated exactly per design §7.1 so it
// cannot be reinterpreted:
// 1. More than one `kind === "doors"` item -> refuse "multiple-doors",
//    checked first, independent of timing.
// 2. Walk in order: a "doors" item later than startsAt -> "doors-after-start";
//    ANY item (doors included) later than endsAt -> "item-after-end".
// 3. No lower bound whatsoever.
export function validateAgenda(
  candidateAgenda: AgendaItem[],
  startsAt: Date,
  endsAt: Date,
): AgendaValidation {
  const doorsCount = candidateAgenda.filter((item) => item.kind === "doors").length;
  if (doorsCount > 1) {
    return { ok: false, reason: "multiple-doors" };
  }

  for (const item of candidateAgenda) {
    const at = new Date(item.at);
    if (item.kind === "doors" && at.getTime() > startsAt.getTime()) {
      return { ok: false, reason: "doors-after-start", item };
    }
    if (at.getTime() > endsAt.getTime()) {
      return { ok: false, reason: "item-after-end", item };
    }
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// §2.2 — validateEventCreateInput: the DB-NOT-NULL floor, not the publish
// gate. Collects every missing/invalid field into `missing`.
// ---------------------------------------------------------------------------
export interface EventCreateInput {
  title: string;
  description: string;
  format: EventFormat;
  venueId: string | null;
  startsAt: Date;
  endsAt: Date;
  registrationClosesAt: Date | null;
  capacity: number;
  requiresInvite: boolean;
  requiresApproval: boolean;
  coverFileId: string | null;
}

export type EventCreateValidation =
  | { ok: true; value: EventCreateInput }
  | { ok: false; missing: string[] };

export function validateEventCreateInput(
  fields: Record<string, string>,
): EventCreateValidation {
  const missing: string[] = [];

  const rawTitle = fields["title"];
  const rawDescription = fields["description"];
  const rawFormat = fields["format"];
  const rawVenue = fields["venue"];
  const rawStarts = fields["starts"];
  const rawEnds = fields["ends"];
  const rawRegistrationCloses = fields["registration_closes"];
  const rawCapacity = fields["capacity"];
  const rawRequiresInvite = fields["requires_invite"];
  const rawRequiresApproval = fields["requires_approval"];
  const rawCoverFileId = fields["cover_file_id"];

  if (isBlank(rawTitle)) missing.push("title");
  if (isBlank(rawDescription)) missing.push("description");

  let format: EventFormat = "meetup";
  if (isBlank(rawFormat)) {
    missing.push("format");
  } else if (!isEventFormat(rawFormat as string)) {
    missing.push("format");
  } else {
    format = rawFormat as EventFormat;
  }

  let startsAt: Date | null = null;
  if (isBlank(rawStarts)) {
    missing.push("starts_at");
  } else {
    const parsed = new Date(rawStarts as string);
    if (Number.isNaN(parsed.getTime())) {
      missing.push("starts_at");
    } else {
      startsAt = parsed;
    }
  }

  let endsAt: Date | null = null;
  if (isBlank(rawEnds)) {
    missing.push("ends_at");
  } else {
    const parsed = new Date(rawEnds as string);
    if (Number.isNaN(parsed.getTime())) {
      missing.push("ends_at");
    } else {
      endsAt = parsed;
    }
  }

  if (startsAt !== null && endsAt !== null && endsAt.getTime() <= startsAt.getTime()) {
    // §2.2's table: ends_at must be after starts_at — a malformed pair, not
    // a "missing field," but refused here with the same dedicated name.
    missing.push("ends_at_before_starts_at");
  }

  let capacity = 0;
  if (isBlank(rawCapacity)) {
    missing.push("capacity");
  } else {
    const parsed = Number(rawCapacity);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      missing.push("capacity");
    } else {
      capacity = parsed;
    }
  }

  const venueId = isBlank(rawVenue) ? null : (rawVenue as string).trim();
  const registrationClosesAt = isBlank(rawRegistrationCloses)
    ? null
    : new Date(rawRegistrationCloses as string);
  const coverFileId = isBlank(rawCoverFileId) ? null : (rawCoverFileId as string).trim();

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    value: {
      title: (rawTitle as string).trim(),
      description: (rawDescription as string).trim(),
      format,
      venueId,
      startsAt: startsAt as Date,
      endsAt: endsAt as Date,
      registrationClosesAt,
      capacity,
      requiresInvite: (rawRequiresInvite ?? "").trim().toLowerCase() === "true",
      requiresApproval: (rawRequiresApproval ?? "").trim().toLowerCase() === "true",
      coverFileId,
    },
  };
}

// ---------------------------------------------------------------------------
// §4 — validateEventUpdateInput: partial update, only supplied fields
// checked/changed. title/description/format/starts_at/ends_at/capacity
// cannot be cleared to blank (present-but-blank refused, naming the field);
// venue_id/registration_closes_at/cover_file_id may be explicitly cleared.
// capacity's floor check (§3.4) is NOT run inside this pure function — it
// needs a DB read (countAdmittedRegistrations) and is therefore composed by
// the caller (updateEvent's call site in the handler), consistent with this
// module's split between pure validation and I/O-performing composition.
// ---------------------------------------------------------------------------
export type EventUpdateField =
  | "title"
  | "description"
  | "format"
  | "venueId"
  | "startsAt"
  | "endsAt"
  | "registrationClosesAt"
  | "capacity"
  | "requiresInvite"
  | "requiresApproval"
  | "coverFileId"
  | "agenda";

export interface EventUpdateChanges {
  title?: string;
  description?: string;
  format?: EventFormat;
  venueId?: string | null;
  startsAt?: Date;
  endsAt?: Date;
  registrationClosesAt?: Date | null;
  capacity?: number;
  requiresInvite?: boolean;
  requiresApproval?: boolean;
  coverFileId?: string | null;
  agenda?: AgendaItem[];
}

export type EventUpdateValidation =
  | { ok: true; changes: EventUpdateChanges; changedFields: EventUpdateField[] }
  | { ok: false; missing: string[] };

export function validateEventUpdateInput(
  fields: Record<string, string>,
): EventUpdateValidation {
  const missing: string[] = [];
  const changes: EventUpdateChanges = {};
  const changedFields: EventUpdateField[] = [];

  if ("title" in fields) {
    if (isBlank(fields["title"])) {
      missing.push("title");
    } else {
      changes.title = (fields["title"] as string).trim();
      changedFields.push("title");
    }
  }

  if ("description" in fields) {
    if (isBlank(fields["description"])) {
      missing.push("description");
    } else {
      changes.description = (fields["description"] as string).trim();
      changedFields.push("description");
    }
  }

  if ("format" in fields) {
    const raw = fields["format"];
    if (isBlank(raw) || !isEventFormat((raw as string).trim())) {
      missing.push("format");
    } else {
      changes.format = (raw as string).trim() as EventFormat;
      changedFields.push("format");
    }
  }

  if ("venue" in fields) {
    const raw = fields["venue"];
    changes.venueId = isBlank(raw) ? null : (raw as string).trim();
    changedFields.push("venueId");
  }

  if ("starts" in fields) {
    const raw = fields["starts"];
    if (isBlank(raw)) {
      missing.push("starts_at");
    } else {
      const parsed = new Date(raw as string);
      if (Number.isNaN(parsed.getTime())) {
        missing.push("starts_at");
      } else {
        changes.startsAt = parsed;
        changedFields.push("startsAt");
      }
    }
  }

  if ("ends" in fields) {
    const raw = fields["ends"];
    if (isBlank(raw)) {
      missing.push("ends_at");
    } else {
      const parsed = new Date(raw as string);
      if (Number.isNaN(parsed.getTime())) {
        missing.push("ends_at");
      } else {
        changes.endsAt = parsed;
        changedFields.push("endsAt");
      }
    }
  }

  if ("registration_closes" in fields) {
    const raw = fields["registration_closes"];
    changes.registrationClosesAt = isBlank(raw) ? null : new Date(raw as string);
    changedFields.push("registrationClosesAt");
  }

  if ("capacity" in fields) {
    const raw = fields["capacity"];
    const parsed = isBlank(raw) ? Number.NaN : Number(raw);
    if (isBlank(raw) || !Number.isInteger(parsed) || parsed <= 0) {
      missing.push("capacity");
    } else {
      changes.capacity = parsed;
      changedFields.push("capacity");
    }
  }

  if ("requires_invite" in fields) {
    changes.requiresInvite = (fields["requires_invite"] ?? "").trim().toLowerCase() === "true";
    changedFields.push("requiresInvite");
  }

  if ("requires_approval" in fields) {
    changes.requiresApproval = (fields["requires_approval"] ?? "").trim().toLowerCase() === "true";
    changedFields.push("requiresApproval");
  }

  if ("cover_file_id" in fields) {
    const raw = fields["cover_file_id"];
    changes.coverFileId = isBlank(raw) ? null : (raw as string).trim();
    changedFields.push("coverFileId");
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return { ok: true, changes, changedFields };
}

// ---------------------------------------------------------------------------
// §7.1/§2.1's own note — parseAgendaText: the command-surface shape for
// /event_agenda's structured input. Not specified by the design (open
// question §11.5 explicitly leaves this to BACKEND-DEV) — one agenda item
// per line, pipe-delimited `kind|iso-timestamp|label`. Framework-free, no
// I/O, directly unit-testable, same "structured multi-line text" family as
// parseEventFields. Blank lines are ignored. A malformed line (missing a
// field, or an unparsable timestamp) is surfaced to the caller via
// `errors`, distinct from `validateAgenda`'s own doors/timing rules, which
// only run once every line has parsed cleanly.
// ---------------------------------------------------------------------------
export type ParseAgendaTextResult =
  | { ok: true; items: AgendaItem[] }
  | { ok: false; errors: string[] };

export function parseAgendaText(text: string): ParseAgendaTextResult {
  const items: AgendaItem[] = [];
  const errors: string[] = [];

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) {
      continue;
    }
    const parts = line.split("|");
    const kind = (parts[0] ?? "").trim();
    const atRaw = (parts[1] ?? "").trim();
    const label = (parts[2] ?? "").trim();

    if (kind.length === 0 || atRaw.length === 0 || label.length === 0) {
      errors.push(line);
      continue;
    }
    const at = new Date(atRaw);
    if (Number.isNaN(at.getTime())) {
      errors.push(line);
      continue;
    }
    items.push({ kind, at: at.toISOString(), label });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, items };
}

// ---------------------------------------------------------------------------
// §3.1/§3.1a — findMissingPublishFields: general, list-driven mechanism, not
// hardcoded to exactly three fields. Pure predicate over an already-loaded
// row — no I/O, unit-testable without a DB.
// ---------------------------------------------------------------------------
export interface EventRecord {
  id: string;
  chapterId: string;
  title: string;
  description: string;
  format: EventFormat;
  venueId: string | null;
  startsAt: Date | null;
  endsAt: Date | null;
  registrationClosesAt: Date | null;
  capacity: number | null;
  requiresInvite: boolean;
  requiresApproval: boolean;
  status: "draft" | "published" | "cancelled";
  coverFileId: string | null;
  agenda: AgendaItem[] | null;
}

export function findMissingPublishFields(event: EventRecord): string[] {
  const missing: string[] = [];
  if (isBlank(event.title)) missing.push("title");
  if (event.startsAt === null) missing.push("starts_at");
  if (event.endsAt === null) missing.push("ends_at");
  if (event.capacity === null || event.capacity <= 0) missing.push("capacity");
  if (event.venueId === null) missing.push("venue");
  return missing;
}

// ---------------------------------------------------------------------------
// §3.4 — countAdmittedRegistrations: read-only, no assumption about whether
// any rows currently exist. Called from both publish (defense in depth) and
// any capacity edit (the actual gate).
// ---------------------------------------------------------------------------
export async function countAdmittedRegistrations(
  db: DbClient["db"],
  eventId: string,
): Promise<number> {
  const rows = await db
    .select({ id: registrations.id })
    .from(registrations)
    .where(and(eq(registrations.eventId, eventId), eq(registrations.admission, "admitted")));
  return rows.length;
}

// ---------------------------------------------------------------------------
// §6.2 — parseStartPayload: framework-free grammar parsing for the /start
// deep-link payload.
// ---------------------------------------------------------------------------
export type StartPayload =
  | { kind: "none" }
  | { kind: "event"; eventId: string; channel: string | null };

export function parseStartPayload(raw: string): StartPayload {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return { kind: "none" };
  }
  if (!trimmed.startsWith("e_")) {
    return { kind: "none" };
  }
  const remainder = trimmed.slice(2);
  const separatorIndex = remainder.indexOf("__");
  if (separatorIndex === -1) {
    return { kind: "event", eventId: remainder, channel: null };
  }
  return {
    kind: "event",
    eventId: remainder.slice(0, separatorIndex),
    channel: remainder.slice(separatorIndex + 2),
  };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function getEventById(
  db: DbClient["db"],
  eventId: string,
): Promise<EventRecord | null> {
  const rows = await db
    .select({
      id: events.id,
      chapterId: events.chapterId,
      title: events.title,
      description: events.description,
      format: events.format,
      venueId: events.venueId,
      startsAt: events.startsAt,
      endsAt: events.endsAt,
      registrationClosesAt: events.registrationClosesAt,
      capacity: events.capacity,
      requiresInvite: events.requiresInvite,
      requiresApproval: events.requiresApproval,
      status: events.status,
      coverFileId: events.coverFileId,
      agenda: events.agenda,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  const row = rows[0];
  if (row === undefined) {
    return null;
  }
  return {
    ...row,
    agenda: (row.agenda as AgendaItem[] | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// §2.2 — createEvent: one INSERT (status: 'draft') + one AuditLog row, one
// transaction.
// ---------------------------------------------------------------------------
export async function createEvent(
  db: DbClient["db"],
  actorUserId: string,
  targetChapterId: string,
  input: EventCreateInput,
  at: Date,
): Promise<string> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(events)
      .values({
        chapterId: targetChapterId,
        title: input.title,
        description: input.description,
        format: input.format,
        venueId: input.venueId,
        startsAt: input.startsAt,
        endsAt: input.endsAt,
        registrationClosesAt: input.registrationClosesAt,
        capacity: input.capacity,
        requiresInvite: input.requiresInvite,
        requiresApproval: input.requiresApproval,
        status: "draft",
        coverFileId: input.coverFileId,
      })
      .returning({ id: events.id });

    const row = rows[0];
    if (row === undefined) {
      // Unreachable in practice: RETURNING on a successful INSERT always
      // yields exactly one row (no-speculation guard, same discipline as
      // REQ-015's createVenue).
      throw new Error("createEvent: insert returned no row");
    }

    await writeAuditLog(tx, {
      actorUserId,
      action: "event.create",
      entity: "event",
      entityId: row.id,
      payload: { chapterId: targetChapterId, title: input.title },
      at,
    });

    return row.id;
  });
}

// ---------------------------------------------------------------------------
// §4 — updateEvent: one UPDATE + one AuditLog row, one transaction.
// ---------------------------------------------------------------------------
export async function updateEvent(
  db: DbClient["db"],
  actorUserId: string,
  eventId: string,
  chapterId: string,
  changes: EventUpdateChanges,
  changedFields: EventUpdateField[],
  at: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(events).set(changes).where(eq(events.id, eventId));

    await writeAuditLog(tx, {
      actorUserId,
      action: "event.update",
      entity: "event",
      entityId: eventId,
      payload: { chapterId, changedFields },
      at,
    });
  });
}

// ---------------------------------------------------------------------------
// §5 — publishEvent: one UPDATE (status -> 'published') + one AuditLog row,
// one transaction. All pre-condition checks (state-machine guard, missing
// fields, capacity floor) are the caller's responsibility (the handler) —
// this function performs the write only once every check has passed.
// ---------------------------------------------------------------------------
export async function publishEvent(
  db: DbClient["db"],
  actorUserId: string,
  eventId: string,
  chapterId: string,
  title: string,
  at: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(events).set({ status: "published" }).where(eq(events.id, eventId));

    await writeAuditLog(tx, {
      actorUserId,
      action: "event.publish",
      entity: "event",
      entityId: eventId,
      payload: { chapterId, title },
      at,
    });
  });
}

// ---------------------------------------------------------------------------
// §5 — cancelEvent: state transition + audit row ONLY. Explicit scope
// boundary (design §5's closing note): no read of the registrations table,
// no notification composition/send of any kind. REQ-027's scope.
// ---------------------------------------------------------------------------
export async function cancelEvent(
  db: DbClient["db"],
  actorUserId: string,
  eventId: string,
  chapterId: string,
  title: string,
  at: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(events).set({ status: "cancelled" }).where(eq(events.id, eventId));

    await writeAuditLog(tx, {
      actorUserId,
      action: "event.cancel",
      entity: "event",
      entityId: eventId,
      payload: { chapterId, title },
      at,
    });
  });
}

// ---------------------------------------------------------------------------
// §6.5 — setPendingSource: a plain UPDATE against users, no event-specific
// logic. Called only when payload.channel !== null AND the event resolves to
// published (handler's own gating, §6.3 step 6).
// ---------------------------------------------------------------------------
export async function setPendingSource(
  db: DbClient["db"],
  userId: string,
  channel: string,
): Promise<void> {
  await db.update(users).set({ pendingSource: channel }).where(eq(users.id, userId));
}

export async function getPendingSource(
  db: DbClient["db"],
  userId: string,
): Promise<string | null> {
  const rows = await db
    .select({ pendingSource: users.pendingSource })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0]?.pendingSource ?? null;
}
