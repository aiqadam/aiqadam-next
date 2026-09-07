import { eq, and } from "drizzle-orm";
import type { DbClient } from "../db/client.js";
import { events, registrations } from "../db/schema.js";
import type { BotLang } from "../i18n/catalog.js";
import { getCatalog } from "../i18n/catalog.js";
import { writeAuditLog } from "./auditLog.js";
import { computeSeatsLeft, countAdmittedRegistrations, isFinished } from "./event.js";
import { generateQrToken, type AdmissionState } from "./registration.js";
import { createWalkinProfile, isNonBlank } from "./profile.js";
import { createWalkinUser, getUserIdByPhone } from "./user.js";

// docs/agents/design/REQ-030.md — walk-in registration at the door.
// Framework-free (decisions/0004): no grammY import anywhere in this file.
// Every time-dependent predicate takes the evaluation time as an explicit
// parameter (decisions/0006) — this file never calls SQL now()/
// current_timestamp inside a predicate.

// ---------------------------------------------------------------------------
// §2 — command parsing and field validation.
// ---------------------------------------------------------------------------
export interface ParsedWalkinArgs {
  eventId: string;
  name: string;
  company: string; // "" when the door didn't collect one
  phone: string;
}

export type ParseWalkinArgsResult =
  | { ok: true; args: ParsedWalkinArgs }
  | { ok: false; reason: "usage" };

// §2's 4-step table, implemented in the exact stated order.
export function parseWalkinArgs(text: string): ParseWalkinArgsResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "usage" };
  }
  const firstSpaceIndex = trimmed.search(/\s/);
  if (firstSpaceIndex === -1) {
    return { ok: false, reason: "usage" };
  }
  const eventId = trimmed.slice(0, firstSpaceIndex);
  const remainder = trimmed.slice(firstSpaceIndex + 1).trim();

  const segments = remainder.split("|");
  if (segments.length !== 3) {
    return { ok: false, reason: "usage" };
  }

  return {
    ok: true,
    args: {
      eventId,
      name: (segments[0] ?? "").trim(),
      company: (segments[1] ?? "").trim(),
      phone: (segments[2] ?? "").trim(),
    },
  };
}

export type WalkinFieldValidation =
  | { ok: true }
  | { ok: false; reason: "missing-name" | "missing-phone" };

// §2 — company has no non-blank requirement (Open Question 1).
export function validateWalkinFields(args: ParsedWalkinArgs): WalkinFieldValidation {
  if (!isNonBlank(args.name)) {
    return { ok: false, reason: "missing-name" };
  }
  if (!isNonBlank(args.phone)) {
    return { ok: false, reason: "missing-phone" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// §3 — the person-matching rule: digit-strip normalization, no other
// canonicalization (§3.2/§3.3).
// ---------------------------------------------------------------------------
export function normalizePhoneForMatching(phone: string): string {
  return phone.replace(/[^0-9]/g, "");
}

// ---------------------------------------------------------------------------
// §5 — the pure decision.
// ---------------------------------------------------------------------------
export interface WalkinDecisionInput {
  eventStatus: "draft" | "published" | "cancelled";
  endsAt: Date | null;
  capacity: number | null;
  existingRegistration: {
    admission: AdmissionState;
    checkedInAt: Date | null;
  } | null;
  seatsLeft: number;
  overrideConfirmed: boolean;
}

export type WalkinDecisionOutcome =
  | { kind: "event-not-ready" }
  | { kind: "event-cancelled" }
  | { kind: "event-finished" }
  | { kind: "already-checked-in" }
  | { kind: "check-in-existing-admitted" }
  | { kind: "admit-and-check-in" }
  | { kind: "needs-override-confirmation" };

// §5's 7-row first-match-wins table, implemented in the exact stated order.
export function decideWalkinOutcome(
  input: WalkinDecisionInput,
  evaluationTime: Date,
): WalkinDecisionOutcome {
  if (input.endsAt === null || input.capacity === null) {
    return { kind: "event-not-ready" };
  }
  if (input.eventStatus === "cancelled") {
    return { kind: "event-cancelled" };
  }
  if (isFinished(input.endsAt, evaluationTime)) {
    return { kind: "event-finished" };
  }
  if (
    input.existingRegistration !== null &&
    input.existingRegistration.admission === "admitted" &&
    input.existingRegistration.checkedInAt !== null
  ) {
    return { kind: "already-checked-in" };
  }
  if (
    input.existingRegistration !== null &&
    input.existingRegistration.admission === "admitted" &&
    input.existingRegistration.checkedInAt === null
  ) {
    return { kind: "check-in-existing-admitted" };
  }
  const notAlreadyAdmitted =
    input.existingRegistration === null || input.existingRegistration.admission !== "admitted";
  if (notAlreadyAdmitted && (input.seatsLeft > 0 || input.overrideConfirmed)) {
    return { kind: "admit-and-check-in" };
  }
  // notAlreadyAdmitted && seatsLeft <= 0 && !overrideConfirmed
  return { kind: "needs-override-confirmation" };
}

// ---------------------------------------------------------------------------
// §7.1 — the render/re-parse pair, the mechanism §1.1 depends on.
// ---------------------------------------------------------------------------
export interface WalkinMessageFields {
  eventTitle: string;
  name: string;
  company: string; // "" allowed
  phone: string;
}

const COMPANY_PLACEHOLDER = "—"; // "—"

function formatCanonicalLines(fields: WalkinMessageFields): string {
  return [
    `Event: ${fields.eventTitle}`,
    `Name: ${fields.name}`,
    `Company: ${fields.company === "" ? COMPANY_PLACEHOLDER : fields.company}`,
    `Phone: ${fields.phone}`,
  ].join("\n");
}

export function formatWalkinConfirmMessage(fields: WalkinMessageFields, lang: BotLang): string {
  const catalog = getCatalog(lang);
  return [formatCanonicalLines(fields), "", catalog.walkin.consentStatement].join("\n");
}

export function formatWalkinOverrideMessage(
  fields: WalkinMessageFields,
  admittedCount: number,
  capacity: number,
  lang: BotLang,
): string {
  const catalog = getCatalog(lang);
  const prompt = catalog.walkin.overridePrompt
    .replace("{admittedCount}", String(admittedCount))
    .replace("{capacity}", String(capacity));
  return [formatCanonicalLines(fields), "", prompt].join("\n");
}

export type ParseWalkinMessageResult =
  | { ok: true; fields: { name: string; company: string; phone: string } }
  | { ok: false };

// §7.1's parse rule, stated exactly: find the first line with each fixed
// prefix; any of the three not found -> refuse. The literal placeholder "—"
// for Company is converted back to "".
export function parseWalkinMessageFields(messageText: string): ParseWalkinMessageResult {
  const lines = messageText.split("\n");

  const nameLine = lines.find((line) => line.startsWith("Name: "));
  const companyLine = lines.find((line) => line.startsWith("Company: "));
  const phoneLine = lines.find((line) => line.startsWith("Phone: "));

  if (nameLine === undefined || companyLine === undefined || phoneLine === undefined) {
    return { ok: false };
  }

  const rawCompany = companyLine.slice("Company: ".length);
  return {
    ok: true,
    fields: {
      name: nameLine.slice("Name: ".length),
      company: rawCompany === COMPANY_PLACEHOLDER ? "" : rawCompany,
      phone: phoneLine.slice("Phone: ".length),
    },
  };
}

// ---------------------------------------------------------------------------
// §6 — the transactional write.
// ---------------------------------------------------------------------------
export type CommitWalkinResult = WalkinDecisionOutcome & { auditAction?: string };

export async function commitWalkin(
  db: DbClient["db"],
  eventId: string,
  organizerUserId: string,
  args: { name: string; company: string; phone: string },
  overrideConfirmed: boolean,
  at: Date,
): Promise<CommitWalkinResult> {
  return db.transaction(async (tx) => {
    // §6.2 step 1 — lock the events row.
    const eventRows = await tx
      .select({
        id: events.id,
        status: events.status,
        endsAt: events.endsAt,
        capacity: events.capacity,
        chapterId: events.chapterId,
      })
      .from(events)
      .where(eq(events.id, eventId))
      .for("update");

    const event = eventRows[0];
    if (event === undefined) {
      return { kind: "event-not-ready" };
    }

    // §6.2 step 2 — resolve a phone match, inside this same transaction.
    const normalizedPhone = normalizePhoneForMatching(args.phone);
    const matchedUserId = await getUserIdByPhone(tx, normalizedPhone);

    // §6.2 step 3 — resolve or create the person.
    let userId: string;
    if (matchedUserId !== null) {
      userId = matchedUserId;
    } else {
      const created = await createWalkinUser(tx, { chapterId: event.chapterId, consentPdAt: at });
      userId = created.id;
      await createWalkinProfile(tx, {
        userId,
        name: args.name,
        company: args.company,
        phone: args.phone,
      });
    }

    // §6.2 step 4 — locked read of any existing registration for this pair.
    const existingRows = await tx
      .select({
        id: registrations.id,
        admission: registrations.admission,
        checkedInAt: registrations.checkedInAt,
      })
      .from(registrations)
      .where(and(eq(registrations.eventId, eventId), eq(registrations.userId, userId)))
      .for("update");
    const existingRow = existingRows[0];

    // §6.2 step 5 — fresh admitted count / seatsLeft.
    const admittedCount = await countAdmittedRegistrations(tx, eventId);
    const seatsLeft = computeSeatsLeft(event.capacity ?? 0, admittedCount);

    // §6.2 step 6 — decide (pure).
    const outcome = decideWalkinOutcome(
      {
        eventStatus: event.status,
        endsAt: event.endsAt,
        capacity: event.capacity,
        existingRegistration:
          existingRow === undefined
            ? null
            : {
                admission: existingRow.admission as AdmissionState,
                checkedInAt: existingRow.checkedInAt,
              },
        seatsLeft,
        overrideConfirmed,
      },
      at,
    );

    // §6.2 step 7 — every non-writing outcome returns as-is.
    if (
      outcome.kind === "event-not-ready" ||
      outcome.kind === "event-cancelled" ||
      outcome.kind === "event-finished" ||
      outcome.kind === "already-checked-in" ||
      outcome.kind === "needs-override-confirmation"
    ) {
      return outcome;
    }

    if (outcome.kind === "check-in-existing-admitted") {
      // §6.2 step 8.
      const existingId = existingRow?.id;
      if (existingId === undefined) {
        // Unreachable: this outcome only arises when existingRow is defined
        // (decideWalkinOutcome's own precondition).
        throw new Error("commitWalkin: check-in-existing-admitted with no existing row");
      }
      await tx
        .update(registrations)
        .set({ checkedInAt: at, checkedInBy: organizerUserId, checkInMethod: "manual" })
        .where(eq(registrations.id, existingId));

      await writeAuditLog(tx, {
        actorUserId: organizerUserId,
        action: "registration.checkin",
        entity: "registration",
        entityId: existingId,
        payload: { eventId, source: "walkin" },
        at,
      });

      return { ...outcome, auditAction: "registration.checkin" };
    }

    // "admit-and-check-in" — §6.2 step 9.
    const previousAdmission = existingRow?.admission ?? null;
    const auditAction = seatsLeft > 0 ? "registration.walkin_admit" : "registration.walkin_override_admit";

    let registrationId: string;
    if (existingRow !== undefined) {
      await tx
        .update(registrations)
        .set({
          admission: "admitted",
          checkedInAt: at,
          checkedInBy: organizerUserId,
          checkInMethod: "manual",
          qrToken: generateQrToken(),
        })
        .where(eq(registrations.id, existingRow.id));
      registrationId = existingRow.id;
    } else {
      const inserted = await tx
        .insert(registrations)
        .values({
          eventId,
          userId,
          admission: "admitted",
          checkedInAt: at,
          checkedInBy: organizerUserId,
          checkInMethod: "manual",
          qrToken: generateQrToken(),
          source: "walkin",
        })
        .returning({ id: registrations.id });
      const insertedRow = inserted[0];
      if (insertedRow === undefined) {
        // Unreachable in practice: RETURNING on a successful INSERT always
        // yields exactly one row (no-speculation guard, this codebase's
        // established convention).
        throw new Error("commitWalkin: insert returned no row");
      }
      registrationId = insertedRow.id;
    }

    await writeAuditLog(tx, {
      actorUserId: organizerUserId,
      action: auditAction,
      entity: "registration",
      entityId: registrationId,
      payload: { eventId, previousAdmission, source: "walkin" },
      at,
    });

    return { ...outcome, auditAction };
  });
}
