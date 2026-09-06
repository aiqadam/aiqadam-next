import { describe, expect, it } from "vitest";
import {
  checkEventStaffAuthorization,
  type ActingUser,
} from "./eventStaffAuthorization.js";
import type { EventStaffRow } from "./eventStaff.js";

// REQ-018 §3.2 — pure-predicate coverage over already-resolved data, no DB
// needed. Mirrors the design's exact numbered rules so a future edit that
// reorders/reinterprets them fails a test, not just a review. Specifically
// verifies AC1/AC3's structural shape and that NO step ever inspects
// user.role (§3.2's own closing note, AC2's structural reasoning).

const EVENT_1 = "11111111-1111-1111-1111-111111111111";
const EVENT_2 = "22222222-2222-2222-2222-222222222222";

const ENDS_AT = new Date("2026-06-01T20:00:00Z");
const BEFORE_ENDS = new Date("2026-06-01T18:00:00Z");
const AFTER_ENDS = new Date("2026-06-01T21:00:00Z");

describe("checkEventStaffAuthorization", () => {
  it("refuses with 'no-user' when no user resolved at all", () => {
    const result = checkEventStaffAuthorization(null, null, ENDS_AT, BEFORE_ENDS);
    expect(result).toEqual({ ok: false, reason: "no-user" });
  });

  it("refuses with 'not-staff-for-event' when no event_staff row exists for this pair", () => {
    const member: ActingUser = { id: "u1", role: "member", chapterId: null };
    const result = checkEventStaffAuthorization(member, null, ENDS_AT, BEFORE_ENDS);
    expect(result).toEqual({ ok: false, reason: "not-staff-for-event" });
  });

  it("AC1's negative case: staffed for event 1, checking against event 2's staffRow=null refuses 'not-staff-for-event'", () => {
    // The handler resolves staffRow via getEventStaffRow(eventId=EVENT_2, ...)
    // which returns null when the caller is only staffed for EVENT_1 — this
    // predicate never sees which event the row belongs to, only whether one
    // was found for the event actually being checked.
    const owner: ActingUser = { id: "u2", role: "owner", chapterId: null };
    const result = checkEventStaffAuthorization(owner, null, ENDS_AT, BEFORE_ENDS);
    expect(result).toEqual({ ok: false, reason: "not-staff-for-event" });
  });

  it("refuses with 'event-ended' when evaluationTime is strictly after endsAt, even with a valid staff row", () => {
    const member: ActingUser = { id: "u1", role: "member", chapterId: null };
    const staffRow: EventStaffRow = { id: "s1", eventId: EVENT_1, userId: "u1" };
    const result = checkEventStaffAuthorization(member, staffRow, ENDS_AT, AFTER_ENDS);
    expect(result).toEqual({ ok: false, reason: "event-ended" });
  });

  it("allows a plain member with a valid, unexpired staff row", () => {
    const member: ActingUser = { id: "u1", role: "member", chapterId: null };
    const staffRow: EventStaffRow = { id: "s1", eventId: EVENT_1, userId: "u1" };
    const result = checkEventStaffAuthorization(member, staffRow, ENDS_AT, BEFORE_ENDS);
    expect(result).toEqual({ ok: true });
  });

  it("does NOT grant on the strength of role: an owner/organizer with no staff row is refused exactly like a member", () => {
    const owner: ActingUser = { id: "u2", role: "owner", chapterId: null };
    const organizer: ActingUser = { id: "u3", role: "organizer", chapterId: EVENT_2 };
    expect(checkEventStaffAuthorization(owner, null, ENDS_AT, BEFORE_ENDS)).toEqual({
      ok: false,
      reason: "not-staff-for-event",
    });
    expect(checkEventStaffAuthorization(organizer, null, ENDS_AT, BEFORE_ENDS)).toEqual({
      ok: false,
      reason: "not-staff-for-event",
    });
  });

  it("exactly at endsAt is still allowed (isFinished is strictly-after)", () => {
    const member: ActingUser = { id: "u1", role: "member", chapterId: null };
    const staffRow: EventStaffRow = { id: "s1", eventId: EVENT_1, userId: "u1" };
    const result = checkEventStaffAuthorization(member, staffRow, ENDS_AT, ENDS_AT);
    expect(result).toEqual({ ok: true });
  });
});
