import { and, eq, gt } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { events, venues } from "../db/schema.js";
import { writeAuditLog } from "./auditLog.js";

// REQ-015 §2-§6 — venue CRUD domain logic. Framework-free (decisions/0004):
// no grammY import anywhere in this file. Every time-dependent predicate
// takes the evaluation time as an explicit parameter (decisions/0006) —
// this file never calls SQL now()/current_timestamp inside a predicate.

export interface VenueInput {
  name: string;
  address: string;
  yandexUrl: string;
  googleUrl: string;
  capacity: number;
  lat: number | null;
  lon: number | null;
  notes: string | null;
}

export interface VenueRecord {
  id: string;
  chapterId: string;
  name: string;
  address: string;
  lat: number | null;
  lon: number | null;
  yandexUrl: string | null;
  googleUrl: string | null;
  capacity: number;
  notes: string | null;
}

export interface VenueListItem {
  id: string;
  name: string;
  address: string;
}

// ---------------------------------------------------------------------------
// §2.2 — parseVenueFields: splits the text after the command on newlines,
// each line on the FIRST ':' character, trimming both sides. Unknown labels
// are ignored (forward compatible); labels are case-insensitive. No DB
// access — directly unit-testable.
// ---------------------------------------------------------------------------
export function parseVenueFields(text: string): Record<string, string> {
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

function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim().length === 0;
}

// ---------------------------------------------------------------------------
// §2.3 — validateVenueCreateInput. Checks required fields in a fixed order
// and collects EVERY missing field into `missing` (not just the first).
// lat/lon: if either is present, both must parse as numbers; if both are
// absent, creation proceeds (§2.4's nudge is derived by the caller from
// `lat === null`).
// ---------------------------------------------------------------------------
export type VenueCreateValidation =
  | { ok: true; value: VenueInput }
  | { ok: false; missing: string[] };

export function validateVenueCreateInput(
  fields: Record<string, string>,
): VenueCreateValidation {
  const missing: string[] = [];

  const rawName = fields["name"];
  const rawAddress = fields["address"];
  const rawYandex = fields["yandex"];
  const rawGoogle = fields["google"];
  const rawCapacity = fields["capacity"];
  const rawLat = fields["lat"];
  const rawLon = fields["lon"];
  const rawNotes = fields["notes"];

  if (isBlank(rawName)) missing.push("name");
  if (isBlank(rawAddress)) missing.push("address");
  if (isBlank(rawYandex)) missing.push("yandex");
  if (isBlank(rawGoogle)) missing.push("google");

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

  let lat: number | null = null;
  let lon: number | null = null;
  const latPresent = !isBlank(rawLat);
  const lonPresent = !isBlank(rawLon);
  if (latPresent || lonPresent) {
    if (!latPresent) {
      missing.push("lat");
    } else {
      const parsedLat = Number(rawLat);
      if (Number.isNaN(parsedLat)) {
        missing.push("lat");
      } else {
        lat = parsedLat;
      }
    }
    if (!lonPresent) {
      missing.push("lon");
    } else {
      const parsedLon = Number(rawLon);
      if (Number.isNaN(parsedLon)) {
        missing.push("lon");
      } else {
        lon = parsedLon;
      }
    }
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return {
    ok: true,
    value: {
      name: rawName as string,
      address: rawAddress as string,
      yandexUrl: rawYandex as string,
      googleUrl: rawGoogle as string,
      capacity,
      lat,
      lon,
      notes: isBlank(rawNotes) ? null : (rawNotes as string),
    },
  };
}

// ---------------------------------------------------------------------------
// §4 step 3 — validateVenueUpdateInput: partial update, only the supplied
// fields are validated/changed. `yandex`/`google` stay required post-creation
// (present-but-empty is refused, naming the field); other fields may be
// cleared with an explicit empty value (e.g. `notes:`). Unlike create,
// lat/lon are validated independently here — editing just one of them does
// not require also supplying the other, since the unsupplied one already has
// a stored value.
// ---------------------------------------------------------------------------
export type VenueUpdateField =
  | "name"
  | "address"
  | "yandexUrl"
  | "googleUrl"
  | "capacity"
  | "lat"
  | "lon"
  | "notes";

export interface VenueUpdateChanges {
  name?: string;
  address?: string;
  yandexUrl?: string;
  googleUrl?: string;
  capacity?: number;
  lat?: number | null;
  lon?: number | null;
  notes?: string | null;
}

export type VenueUpdateValidation =
  | { ok: true; changes: VenueUpdateChanges; changedFields: VenueUpdateField[] }
  | { ok: false; missing: string[] };

export function validateVenueUpdateInput(
  fields: Record<string, string>,
): VenueUpdateValidation {
  const missing: string[] = [];
  const changes: VenueUpdateChanges = {};
  const changedFields: VenueUpdateField[] = [];

  if ("name" in fields) {
    if (isBlank(fields["name"])) {
      missing.push("name");
    } else {
      changes.name = (fields["name"] as string).trim();
      changedFields.push("name");
    }
  }

  if ("address" in fields) {
    if (isBlank(fields["address"])) {
      missing.push("address");
    } else {
      changes.address = (fields["address"] as string).trim();
      changedFields.push("address");
    }
  }

  if ("yandex" in fields) {
    if (isBlank(fields["yandex"])) {
      missing.push("yandex");
    } else {
      changes.yandexUrl = (fields["yandex"] as string).trim();
      changedFields.push("yandexUrl");
    }
  }

  if ("google" in fields) {
    if (isBlank(fields["google"])) {
      missing.push("google");
    } else {
      changes.googleUrl = (fields["google"] as string).trim();
      changedFields.push("googleUrl");
    }
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

  if ("lat" in fields) {
    const raw = fields["lat"];
    if (isBlank(raw)) {
      changes.lat = null;
      changedFields.push("lat");
    } else {
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) {
        missing.push("lat");
      } else {
        changes.lat = parsed;
        changedFields.push("lat");
      }
    }
  }

  if ("lon" in fields) {
    const raw = fields["lon"];
    if (isBlank(raw)) {
      changes.lon = null;
      changedFields.push("lon");
    } else {
      const parsed = Number(raw);
      if (Number.isNaN(parsed)) {
        missing.push("lon");
      } else {
        changes.lon = parsed;
        changedFields.push("lon");
      }
    }
  }

  if ("notes" in fields) {
    const raw = fields["notes"];
    changes.notes = isBlank(raw) ? null : (raw as string).trim();
    changedFields.push("notes");
  }

  if (missing.length > 0) {
    return { ok: false, missing };
  }

  return { ok: true, changes, changedFields };
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------
export async function getVenueById(
  db: DbClient["db"],
  venueId: string,
): Promise<VenueRecord | null> {
  const rows = await db
    .select({
      id: venues.id,
      chapterId: venues.chapterId,
      name: venues.name,
      address: venues.address,
      lat: venues.lat,
      lon: venues.lon,
      yandexUrl: venues.yandexUrl,
      googleUrl: venues.googleUrl,
      capacity: venues.capacity,
      notes: venues.notes,
    })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  return rows[0] ?? null;
}

// §3 — listing is a plain read scoped by chapterId, not gated by
// requireOrganizerForChapter (design §3's own scope note).
export async function listVenuesForChapter(
  db: DbClient["db"],
  chapterId: string,
): Promise<VenueListItem[]> {
  return db
    .select({ id: venues.id, name: venues.name, address: venues.address })
    .from(venues)
    .where(eq(venues.chapterId, chapterId));
}

// ---------------------------------------------------------------------------
// §5 step 3 — hasFutureEventReference. Evaluation time is an explicit
// parameter (decisions/0006) — this query never reads the clock itself.
// ---------------------------------------------------------------------------
export async function hasFutureEventReference(
  db: DbClient["db"],
  venueId: string,
  evaluationTime: Date,
): Promise<boolean> {
  const rows = await db
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.venueId, venueId), gt(events.startsAt, evaluationTime)))
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// §2.6 — createVenue: one INSERT + one AuditLog row, one transaction.
// ---------------------------------------------------------------------------
export async function createVenue(
  db: DbClient["db"],
  actorUserId: string,
  targetChapterId: string,
  input: VenueInput,
  at: Date,
): Promise<string> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(venues)
      .values({
        chapterId: targetChapterId,
        name: input.name,
        address: input.address,
        yandexUrl: input.yandexUrl,
        googleUrl: input.googleUrl,
        capacity: input.capacity,
        lat: input.lat,
        lon: input.lon,
        notes: input.notes,
      })
      .returning({ id: venues.id });

    const row = rows[0];
    if (row === undefined) {
      // Unreachable in practice: RETURNING on a successful INSERT always
      // yields exactly one row (no-speculation guard, same discipline as
      // resolveOrCreateUser in domain/user.ts).
      throw new Error("createVenue: insert returned no row");
    }

    await writeAuditLog(tx, {
      actorUserId,
      action: "venue.create",
      entity: "venue",
      entityId: row.id,
      payload: { chapterId: targetChapterId, name: input.name },
      at,
    });

    return row.id;
  });
}

// ---------------------------------------------------------------------------
// §4 step 4 — updateVenue: one UPDATE + one AuditLog row, one transaction.
// ---------------------------------------------------------------------------
export async function updateVenue(
  db: DbClient["db"],
  actorUserId: string,
  venueId: string,
  chapterId: string,
  changes: VenueUpdateChanges,
  changedFields: VenueUpdateField[],
  at: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(venues).set(changes).where(eq(venues.id, venueId));

    await writeAuditLog(tx, {
      actorUserId,
      action: "venue.update",
      entity: "venue",
      entityId: venueId,
      payload: { chapterId, changedFields },
      at,
    });
  });
}

// ---------------------------------------------------------------------------
// §5 step 4 — deleteVenue: one DELETE + one AuditLog row, one transaction.
// `venueSnapshot` is captured BEFORE the delete (by the caller, from the same
// getVenueById read used for the authorization/future-event checks), since
// the row no longer exists to read from afterward.
// ---------------------------------------------------------------------------
export async function deleteVenue(
  db: DbClient["db"],
  actorUserId: string,
  venueId: string,
  venueSnapshot: { chapterId: string; name: string },
  at: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(venues).where(eq(venues.id, venueId));

    await writeAuditLog(tx, {
      actorUserId,
      action: "venue.delete",
      entity: "venue",
      entityId: venueId,
      payload: { chapterId: venueSnapshot.chapterId, name: venueSnapshot.name },
      at,
    });
  });
}
