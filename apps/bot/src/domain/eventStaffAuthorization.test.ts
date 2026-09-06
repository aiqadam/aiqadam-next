import { describe, expect, it } from "vitest";
import {
  buildCheckinRefusalAudit,
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

// SECURITY-REVIEWER Step 2c FAIL (S5) rework — buildCheckinRefusalAudit is
// the pure decision logic behind the audit row requireEventStaffForEvent now
// writes on every refusal branch. Locked down per-reason so a future edit
// that drops a branch, leaks the wrong actor, or lets PII into the payload
// fails a test, not just a review.
describe("buildCheckinRefusalAudit", () => {
  const EVENT_ID = EVENT_1;

  it("'no-user': actorUserId is null — there is no resolved User row to attribute the attempt to", () => {
    const entry = buildCheckinRefusalAudit(null, EVENT_ID, "no-user");
    expect(entry).toEqual({
      actorUserId: null,
      action: "checkin.refused",
      entity: "event",
      entityId: EVENT_ID,
      payload: { reason: "no-user" },
    });
  });

  it("'not-staff-for-event': actorUserId is the resolved user's internal id, never the tg_id", () => {
    const member: ActingUser = { id: "u1", role: "member", chapterId: null };
    const entry = buildCheckinRefusalAudit(member, EVENT_ID, "not-staff-for-event");
    expect(entry).toEqual({
      actorUserId: "u1",
      action: "checkin.refused",
      entity: "event",
      entityId: EVENT_ID,
      payload: { reason: "not-staff-for-event" },
    });
  });

  it("'event-ended': same shape, actor still attributed since the user resolved and had a staff row", () => {
    const member: ActingUser = { id: "u1", role: "member", chapterId: null };
    const entry = buildCheckinRefusalAudit(member, EVENT_ID, "event-ended");
    expect(entry).toEqual({
      actorUserId: "u1",
      action: "checkin.refused",
      entity: "event",
      entityId: EVENT_ID,
      payload: { reason: "event-ended" },
    });
  });

  it("payload never carries more than the fixed reason string — no PII, no free text (S11)", () => {
    const owner: ActingUser = { id: "u2", role: "owner", chapterId: "c1" };
    const entry = buildCheckinRefusalAudit(owner, EVENT_ID, "not-staff-for-event");
    expect(Object.keys(entry.payload as Record<string, unknown>)).toEqual(["reason"]);
    expect(entry).not.toHaveProperty("at");
  });
});
