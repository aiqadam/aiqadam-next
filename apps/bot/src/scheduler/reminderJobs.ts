import type { DbClient } from "../db/client.js";
import {
  sendLedgeredNotification,
  type ComposedMessage,
  type NotificationSender,
} from "../domain/notification.js";
import {
  getRegistrationAdmissionAndEvent,
} from "../domain/registration.js";
import { findDoorsAgendaItem, getEventByIdWithChapterTimezone } from "../domain/event.js";
import { getVenueById } from "../domain/venue.js";
import { renderCheckInQrPng } from "../domain/qr.js";
import { formatDateTimeInTimezone } from "../i18n/formatTimeInTimezone.js";
import { getCatalog, type BotLang } from "../i18n/catalog.js";
import {
  selectRegistrationsForReminder24h,
  selectRegistrationsForReminder3h,
} from "../domain/reminders.js";
import type { ScheduledJobDefinition } from "./runner.js";

// docs/agents/design/REQ-026.md §5 — the two scheduled jobs. Framework-free
// aside from the ScheduledJobDefinition shape itself (no grammy import).

// §5.1 — T-24h composeMessage (AC1, AC2, AC4, AC10).
async function composeReminder24h(
  db: DbClient["db"],
  registrationId: string,
  lang: BotLang,
): Promise<ComposedMessage> {
  const catalog = getCatalog(lang);

  const registration = await getRegistrationAdmissionAndEvent(db, registrationId);
  if (registration === null || registration.admission !== "admitted") {
    return { kind: "skip" };
  }

  const event = await getEventByIdWithChapterTimezone(db, registration.eventId);
  if (event === null || event.status !== "published" || event.startsAt === null) {
    return { kind: "skip" };
  }

  const text = [
    catalog.reminder24h.prompt,
    event.title,
    formatDateTimeInTimezone(event.startsAt, event.chapterTimezone, lang),
  ].join("\n");

  return {
    kind: "text",
    text,
    buttons: [
      { label: catalog.reminder24h.confirmButton, callbackData: `reminder24h:confirm:${registrationId}` },
      { label: catalog.reminder24h.declineButton, callbackData: `reminder24h:decline:${registrationId}` },
    ],
  };
}

// §5.2 — T-3h composeMessage (AC5, AC6, AC7, AC8, AC10).
async function composeReminder3h(
  db: DbClient["db"],
  registrationId: string,
  botUsername: string,
  lang: BotLang,
): Promise<ComposedMessage> {
  const catalog = getCatalog(lang);

  const registration = await getRegistrationAdmissionAndEvent(db, registrationId);
  if (registration === null || registration.admission !== "admitted") {
    return { kind: "skip" };
  }

  const event = await getEventByIdWithChapterTimezone(db, registration.eventId);
  if (event === null || event.status !== "published" || event.startsAt === null) {
    return { kind: "skip" };
  }

  const venue = event.venueId !== null ? await getVenueById(db, event.venueId) : null;
  const doorsItem = findDoorsAgendaItem(event.agenda);

  const lines: string[] = [catalog.reminder3h.header, event.title];
  if (doorsItem !== null) {
    // docs/agents/design/REQ-026.md §5.2 step 4 — the SAME function, same
    // three arguments in the same order, as buildEventCardContent's
    // agendaLines mapping (domain/event.ts) applies to this same doors item.
    // This identity is what makes AC7's byte-for-byte requirement hold
    // structurally.
    lines.push(
      `${catalog.reminder3h.doorsLabel} ${formatDateTimeInTimezone(new Date(doorsItem.at), event.chapterTimezone, lang)}`,
    );
  }
  lines.push(
    `${catalog.reminder3h.startLabel} ${formatDateTimeInTimezone(event.startsAt, event.chapterTimezone, lang)}`,
  );
  lines.push(venue?.address ?? "");
  lines.push(venue?.yandexUrl ?? "");
  lines.push(venue?.googleUrl ?? "");
  const caption = lines.join("\n");

  if (registration.qrToken === null) {
    // Defensive — unreachable in practice (every admitted registration has a
    // qr_token, REQ-020 §3.2 step 8). Never send a caption-only message that
    // silently drops AC5's QR requirement.
    return { kind: "skip" };
  }

  const photo = await renderCheckInQrPng({ botUsername, qrToken: registration.qrToken });
  return { kind: "photo", photo, caption };
}

export function makeReminder24hJob(
  db: DbClient["db"],
  sender: NotificationSender,
  intervalMs: number,
): ScheduledJobDefinition {
  return {
    name: "reminder24h",
    intervalMs,
    async run(evaluationTime: Date): Promise<void> {
      const candidates = await selectRegistrationsForReminder24h(db, evaluationTime);
      for (const candidate of candidates) {
        await sendLedgeredNotification({
          db,
          sender,
          registrationId: candidate.registrationId,
          kind: "reminder_24h",
          classification: "transactional",
          userId: candidate.userId,
          composeMessage: (lang) => composeReminder24h(db, candidate.registrationId, lang),
        });
      }
    },
  };
}

export function makeReminder3hJob(
  db: DbClient["db"],
  sender: NotificationSender,
  botUsername: string,
  intervalMs: number,
): ScheduledJobDefinition {
  return {
    name: "reminder3h",
    intervalMs,
    async run(evaluationTime: Date): Promise<void> {
      const candidates = await selectRegistrationsForReminder3h(db, evaluationTime);
      for (const candidate of candidates) {
        await sendLedgeredNotification({
          db,
          sender,
          registrationId: candidate.registrationId,
          kind: "reminder_3h",
          classification: "transactional",
          userId: candidate.userId,
          composeMessage: (lang) => composeReminder3h(db, candidate.registrationId, botUsername, lang),
        });
      }
    },
  };
}
