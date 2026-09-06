import { describe, expect, it } from "vitest";
import {
  buildEventCardContent,
  buildSeatsLine,
  computeSeatsLeft,
  findMissingPublishFields,
  isFinished,
  isRegistrationOpen,
  parseAgendaText,
  parseEventFields,
  parseStartPayload,
  validateAgenda,
  validateEventCreateInput,
  validateEventUpdateInput,
  type EventRecord,
  type EventWithChapterTimezone,
} from "./event.js";
import type { VenueRecord } from "./venue.js";

// REQ-016 §2.1/§3.1/§6.2/§7.1 — framework-free, no-DB coverage for the
// parsing/validation functions the handlers call. Mirrors the design's exact
// numbered rules so a future edit that reorders/reinterprets them fails a
// test, not just a review.

const CHAPTER = "11111111-1111-1111-1111-111111111111";

function baseEvent(overrides: Partial<EventRecord> = {}): EventRecord {
  return {
    id: "e1",
    chapterId: CHAPTER,
    title: "LLM Engineering in Production",
    description: "A practitioner's walkthrough",
    format: "meetup",
    venueId: "v1",
    startsAt: new Date("2026-10-01T18:00:00Z"),
    endsAt: new Date("2026-10-01T20:00:00Z"),
    registrationClosesAt: null,
    capacity: 60,
    requiresInvite: false,
    requiresApproval: false,
    status: "draft",
    coverFileId: null,
    agenda: null,
    ...overrides,
  };
}

describe("parseEventFields", () => {
  it("splits each line on the first ':' and trims both sides", () => {
    const fields = parseEventFields("title: My Event\ndescription: hello");
    expect(fields).toEqual({ title: "My Event", description: "hello" });
  });

  it("ignores unknown labels (forward compatible)", () => {
    const fields = parseEventFields("title: X\nstatus: published");
    expect(fields["status"]).toBe("published");
  });
});

describe("validateEventCreateInput", () => {
  const complete = {
    title: "My Event",
    description: "Description text",
    format: "meetup",
    starts: "2026-10-01T18:00:00Z",
    ends: "2026-10-01T20:00:00Z",
    capacity: "50",
  };

  it("succeeds with all DB-required fields and no venue, venue null", () => {
    const result = validateEventCreateInput(complete);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.venueId).toBeNull();
      expect(result.value.capacity).toBe(50);
    }
  });

  it("collects every missing required field, not just the first", () => {
    const result = validateEventCreateInput({ title: "X" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(
        expect.arrayContaining(["description", "format", "starts_at", "ends_at", "capacity"]),
      );
    }
  });

  it("refuses an unknown format value", () => {
    const result = validateEventCreateInput({ ...complete, format: "webinar" });
    expect(result).toEqual({ ok: false, missing: ["format"] });
  });

  it("refuses when ends_at is not after starts_at", () => {
    const result = validateEventCreateInput({
      ...complete,
      starts: "2026-10-01T20:00:00Z",
      ends: "2026-10-01T18:00:00Z",
    });
    expect(result).toEqual({ ok: false, missing: ["ends_at_before_starts_at"] });
  });

  it("refuses non-positive capacity", () => {
    expect(validateEventCreateInput({ ...complete, capacity: "0" })).toEqual({
      ok: false,
      missing: ["capacity"],
    });
  });
});

describe("validateEventUpdateInput", () => {
  it("changes only the supplied fields", () => {
    const result = validateEventUpdateInput({ title: "New title" });
    expect(result).toEqual({
      ok: true,
      changes: { title: "New title" },
      changedFields: ["title"],
    });
  });

  it("refuses clearing title to blank, naming the field", () => {
    const result = validateEventUpdateInput({ title: "   " });
    expect(result).toEqual({ ok: false, missing: ["title"] });
  });

  it("allows clearing venue to null with an explicit empty value", () => {
    const result = validateEventUpdateInput({ venue: "" });
    expect(result).toEqual({
      ok: true,
      changes: { venueId: null },
      changedFields: ["venueId"],
    });
  });

  it("refuses a non-positive capacity, naming the field", () => {
    const result = validateEventUpdateInput({ capacity: "-1" });
    expect(result).toEqual({ ok: false, missing: ["capacity"] });
  });
});

describe("findMissingPublishFields", () => {
  it("returns an empty list for a fully valid event", () => {
    expect(findMissingPublishFields(baseEvent())).toEqual([]);
  });

  it("names 'title' when blank/whitespace-only", () => {
    expect(findMissingPublishFields(baseEvent({ title: "   " }))).toEqual(["title"]);
  });

  it("names 'starts_at' when null", () => {
    expect(findMissingPublishFields(baseEvent({ startsAt: null }))).toEqual(["starts_at"]);
  });

  it("names 'capacity' when zero or negative (not just null)", () => {
    expect(findMissingPublishFields(baseEvent({ capacity: 0 }))).toEqual(["capacity"]);
    expect(findMissingPublishFields(baseEvent({ capacity: -5 }))).toEqual(["capacity"]);
  });

  it("names 'venue' when venue_id is null — every current format requires one", () => {
    expect(findMissingPublishFields(baseEvent({ venueId: null }))).toEqual(["venue"]);
  });

  it("names every missing/invalid field at once, in table order", () => {
    expect(
      findMissingPublishFields(
        baseEvent({ title: "", capacity: 0, venueId: null, endsAt: null }),
      ),
    ).toEqual(["title", "ends_at", "capacity", "venue"]);
  });
});

describe("parseStartPayload", () => {
  it("parses an empty/blank payload as 'none'", () => {
    expect(parseStartPayload("")).toEqual({ kind: "none" });
    expect(parseStartPayload("   ")).toEqual({ kind: "none" });
  });

  it("parses a payload that doesn't start with 'e_' as 'none'", () => {
    expect(parseStartPayload("x_123")).toEqual({ kind: "none" });
  });

  it("parses a plain event payload with no channel", () => {
    expect(parseStartPayload("e_abc-123")).toEqual({
      kind: "event",
      eventId: "abc-123",
      channel: null,
    });
  });

  it("parses a channel-suffixed payload, splitting on the FIRST '__'", () => {
    expect(parseStartPayload("e_abc-123__linkedin")).toEqual({
      kind: "event",
      eventId: "abc-123",
      channel: "linkedin",
    });
  });

  it("keeps the channel as opaque text even if it itself contains '__'", () => {
    expect(parseStartPayload("e_abc-123__lin__kedin")).toEqual({
      kind: "event",
      eventId: "abc-123",
      channel: "lin__kedin",
    });
  });
});

describe("validateAgenda", () => {
  const startsAt = new Date("2026-10-01T18:00:00Z");
  const endsAt = new Date("2026-10-01T20:00:00Z");

  it("accepts an empty agenda", () => {
    expect(validateAgenda([], startsAt, endsAt)).toEqual({ ok: true });
  });

  it("accepts a doors item exactly at starts_at (boundary allowed)", () => {
    const result = validateAgenda(
      [{ kind: "doors", at: startsAt.toISOString(), label: "Doors" }],
      startsAt,
      endsAt,
    );
    expect(result).toEqual({ ok: true });
  });

  it("refuses a doors item later than starts_at, naming the item", () => {
    const item = { kind: "doors", at: "2026-10-01T19:00:00Z", label: "Doors" };
    expect(validateAgenda([item], startsAt, endsAt)).toEqual({
      ok: false,
      reason: "doors-after-start",
      item,
    });
  });

  it("refuses any item (doors included) later than ends_at, naming the item", () => {
    const item = { kind: "networking", at: "2026-10-01T21:00:00Z", label: "Networking" };
    expect(validateAgenda([item], startsAt, endsAt)).toEqual({
      ok: false,
      reason: "item-after-end",
      item,
    });
  });

  it("imposes NO lower bound — an item well before starts_at succeeds", () => {
    const item = { kind: "networking", at: "2026-09-01T00:00:00Z", label: "Setup" };
    expect(validateAgenda([item], startsAt, endsAt)).toEqual({ ok: true });
  });

  it("refuses more than one doors item, checked before any timing", () => {
    const items = [
      { kind: "doors", at: startsAt.toISOString(), label: "Doors 1" },
      { kind: "doors", at: startsAt.toISOString(), label: "Doors 2" },
    ];
    expect(validateAgenda(items, startsAt, endsAt)).toEqual({
      ok: false,
      reason: "multiple-doors",
    });
  });
});

describe("parseAgendaText", () => {
  it("parses pipe-delimited lines into agenda items", () => {
    const result = parseAgendaText(
      "doors|2026-10-01T17:30:00Z|Doors open\nclose|2026-10-01T20:00:00Z|Closing",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.kind).toBe("doors");
      expect(result.items[0]?.label).toBe("Doors open");
    }
  });

  it("ignores blank lines", () => {
    const result = parseAgendaText("doors|2026-10-01T17:30:00Z|Doors open\n\n");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.items).toHaveLength(1);
    }
  });

  it("reports a malformed line (missing a field) as an error", () => {
    const result = parseAgendaText("doors|2026-10-01T17:30:00Z");
    expect(result.ok).toBe(false);
  });

  it("reports an unparsable timestamp as an error", () => {
    const result = parseAgendaText("doors|not-a-date|Doors open");
    expect(result.ok).toBe(false);
  });
});

// REQ-017 §1 — computed-never-stored predicates (AC3, AC4). Pure, no I/O.
describe("computeSeatsLeft", () => {
  it("is capacity minus admittedCount", () => {
    expect(computeSeatsLeft(60, 12)).toBe(48);
  });

  it("goes negative when admittedCount exceeds capacity (an override case)", () => {
    expect(computeSeatsLeft(10, 11)).toBe(-1);
  });
});

describe("buildSeatsLine", () => {
  it("renders seatsLeft when seatsLeft > 0", () => {
    expect(buildSeatsLine(5)).toEqual({ kind: "seatsLeft", count: 5 });
  });

  it("renders waitlistOpen when seatsLeft is exactly 0", () => {
    expect(buildSeatsLine(0)).toEqual({ kind: "waitlistOpen" });
  });

  it("renders waitlistOpen when seatsLeft is negative", () => {
    expect(buildSeatsLine(-1)).toEqual({ kind: "waitlistOpen" });
  });
});

describe("isRegistrationOpen", () => {
  const evaluationTime = new Date("2026-09-01T00:00:00Z");

  it("is always true when registrationClosesAt is null (no deadline configured)", () => {
    expect(isRegistrationOpen(null, evaluationTime)).toBe(true);
  });

  it("is true when evaluationTime is strictly before registrationClosesAt", () => {
    expect(isRegistrationOpen(new Date("2026-09-02T00:00:00Z"), evaluationTime)).toBe(true);
  });

  it("is false when evaluationTime is at or after registrationClosesAt", () => {
    expect(isRegistrationOpen(evaluationTime, evaluationTime)).toBe(false);
    expect(isRegistrationOpen(new Date("2026-08-31T00:00:00Z"), evaluationTime)).toBe(false);
  });
});

describe("isFinished", () => {
  const endsAt = new Date("2026-10-01T20:00:00Z");

  it("is false when evaluationTime is before or exactly at endsAt", () => {
    expect(isFinished(endsAt, new Date("2026-10-01T19:00:00Z"))).toBe(false);
    expect(isFinished(endsAt, endsAt)).toBe(false);
  });

  it("is true when evaluationTime is strictly after endsAt", () => {
    expect(isFinished(endsAt, new Date("2026-10-01T20:00:01Z"))).toBe(true);
  });
});

// REQ-017 §3 — event card assembly. Pure composition, no I/O.
describe("buildEventCardContent", () => {
  const CHAPTER = "11111111-1111-1111-1111-111111111111";

  function baseEventWithTz(
    overrides: Partial<EventWithChapterTimezone> = {},
  ): EventWithChapterTimezone {
    return {
      id: "e1",
      chapterId: CHAPTER,
      title: "LLM Engineering in Production",
      description: "A practitioner's walkthrough",
      format: "meetup",
      venueId: "v1",
      startsAt: new Date("2026-10-01T13:00:00Z"),
      endsAt: new Date("2026-10-01T15:00:00Z"),
      registrationClosesAt: null,
      capacity: 60,
      requiresInvite: false,
      requiresApproval: false,
      status: "published",
      coverFileId: null,
      agenda: null,
      chapterTimezone: "Asia/Tashkent",
      ...overrides,
    };
  }

  function baseVenue(overrides: Partial<VenueRecord> = {}): VenueRecord {
    return {
      id: "v1",
      chapterId: CHAPTER,
      name: "Tashkent AI Hub",
      address: "123 Amir Temur Ave",
      lat: 41.3,
      lon: 69.2,
      yandexUrl: "https://yandex.ru/maps/?pt=69.2,41.3",
      googleUrl: "https://maps.google.com/?q=41.3,69.2",
      capacity: 80,
      notes: null,
      ...overrides,
    };
  }

  it("renders both map links verbatim from the venue's stored URLs (AC1)", () => {
    const content = buildEventCardContent(baseEventWithTz(), baseVenue(), 0, "en");
    expect(content.yandexMapUrl).toBe("https://yandex.ru/maps/?pt=69.2,41.3");
    expect(content.googleMapUrl).toBe("https://maps.google.com/?q=41.3,69.2");
  });

  it("computes seatsLine from capacity and the passed-in admittedCount, never storing anything", () => {
    const content = buildEventCardContent(baseEventWithTz({ capacity: 60 }), baseVenue(), 48, "en");
    expect(content.seatsLine).toEqual({ kind: "seatsLeft", count: 12 });
  });

  it("renders waitlistOpen once admittedCount reaches capacity", () => {
    const content = buildEventCardContent(baseEventWithTz({ capacity: 60 }), baseVenue(), 60, "en");
    expect(content.seatsLine).toEqual({ kind: "waitlistOpen" });
  });

  it("renders every agenda item (doors and non-doors) with a formatted time and label (AC5)", () => {
    const content = buildEventCardContent(
      baseEventWithTz({
        agenda: [
          { kind: "doors", at: "2026-10-01T12:30:00.000Z", label: "Doors open" },
          { kind: "networking", at: "2026-10-01T14:30:00.000Z", label: "Networking" },
        ],
      }),
      baseVenue(),
      0,
      "en",
    );
    expect(content.agendaLines).toHaveLength(2);
    expect(content.agendaLines[0]?.label).toBe("Doors open");
    expect(content.agendaLines[1]?.label).toBe("Networking");
    // Asia/Tashkent is UTC+5 — 12:30 UTC -> 17:30 local; 14:30 UTC -> 19:30 local.
    // Rendered 24-hour per REQ-017 design (formatDateTimeInTimezone uses hourCycle: "h23").
    expect(content.agendaLines[0]?.timeText).toContain("17:30");
    expect(content.agendaLines[1]?.timeText).toContain("19:30");
  });

  it("renders no venue block at all when venue is null (defensive, §3.3)", () => {
    const content = buildEventCardContent(baseEventWithTz(), null, 0, "en");
    expect(content.venueName).toBeNull();
    expect(content.venueAddress).toBeNull();
    expect(content.yandexMapUrl).toBeNull();
    expect(content.googleMapUrl).toBeNull();
  });
});
