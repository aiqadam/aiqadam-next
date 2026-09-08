import { describe, expect, it } from "vitest";
import {
  decideRegistrationOutcome,
  generateQrToken,
  isNoShow,
  resolveRegistrationSource,
  type RegistrationDecisionInput,
} from "./registration.js";

// docs/agents/design/REQ-020.md §2.2/§4/§5.1 — framework-free, no-DB
// coverage for the pure functions the atomic write composes. Mirrors the
// design's exact numbered rules so a future edit that reorders/reinterprets
// them fails a test, not just a review.

function baseInput(overrides: Partial<RegistrationDecisionInput> = {}): RegistrationDecisionInput {
  return {
    existingAdmission: null,
    eventStatus: "published",
    requiresInvite: false,
    requiresApproval: false,
    registrationClosesAt: null,
    endsAt: new Date("2026-10-01T20:00:00Z"),
    seatsLeft: 5,
    ...overrides,
  };
}

const evalTime = new Date("2026-09-01T00:00:00Z");

describe("decideRegistrationOutcome — §2.2's first-match-wins table", () => {
  it("row 1: an existing admission wins over every other condition, even a cancelled/finished event", () => {
    const outcome = decideRegistrationOutcome(
      baseInput({ existingAdmission: "admitted", eventStatus: "cancelled" }),
      evalTime,
    );
    expect(outcome).toEqual({ kind: "already-registered", admission: "admitted" });
  });

  it("row 1 reports every admission state, not just 'admitted'", () => {
    for (const admission of ["requested", "waitlisted", "admitted", "rejected", "withdrawn"] as const) {
      expect(decideRegistrationOutcome(baseInput({ existingAdmission: admission }), evalTime)).toEqual({
        kind: "already-registered",
        admission,
      });
    }
  });

  it("row 2: a cancelled event is refused before requires-invite/approval/capacity are even considered", () => {
    const outcome = decideRegistrationOutcome(
      baseInput({ eventStatus: "cancelled", requiresInvite: true, seatsLeft: 0 }),
      evalTime,
    );
    expect(outcome).toEqual({ kind: "event-cancelled" });
  });

  it("row 3: a finished event (evaluationTime strictly after endsAt) is refused", () => {
    const outcome = decideRegistrationOutcome(
      baseInput({ endsAt: new Date("2026-08-31T00:00:00Z") }),
      evalTime,
    );
    expect(outcome).toEqual({ kind: "event-finished" });
  });

  it("row 3 boundary: evaluationTime exactly at endsAt is NOT finished", () => {
    const outcome = decideRegistrationOutcome(baseInput({ endsAt: evalTime }), evalTime);
    expect(outcome).not.toEqual({ kind: "event-finished" });
  });

  it("row 4: registration closed (evaluationTime at or after registrationClosesAt) is refused", () => {
    const outcome = decideRegistrationOutcome(
      baseInput({ registrationClosesAt: evalTime }),
      evalTime,
    );
    expect(outcome).toEqual({ kind: "registration-closed" });
  });

  it("row 4 checked before rows 5/6: a closed AND requires-invite event reports 'closed' first", () => {
    const outcome = decideRegistrationOutcome(
      baseInput({ registrationClosesAt: evalTime, requiresInvite: true }),
      evalTime,
    );
    expect(outcome).toEqual({ kind: "registration-closed" });
  });

  it("row 5: requires_invite refuses before the capacity check (row 7)", () => {
    const outcome = decideRegistrationOutcome(baseInput({ requiresInvite: true, seatsLeft: 5 }), evalTime);
    expect(outcome).toEqual({ kind: "requires-invite" });
  });

  it("row 6: requires_approval yields 'requested' before the capacity check, checked after requires_invite (docs/agents/design/REQ-034.md §1)", () => {
    const outcome = decideRegistrationOutcome(
      baseInput({ requiresApproval: true, seatsLeft: 5 }),
      evalTime,
    );
    expect(outcome).toEqual({ kind: "requested" });
  });

  it("row 7: seatsLeft > 0 -> admitted", () => {
    expect(decideRegistrationOutcome(baseInput({ seatsLeft: 1 }), evalTime)).toEqual({
      kind: "admitted",
    });
  });

  it("row 8: seatsLeft <= 0 -> waitlisted", () => {
    expect(decideRegistrationOutcome(baseInput({ seatsLeft: 0 }), evalTime)).toEqual({
      kind: "waitlisted",
    });
    expect(decideRegistrationOutcome(baseInput({ seatsLeft: -1 }), evalTime)).toEqual({
      kind: "waitlisted",
    });
  });
});

// §4 — qr_token generation (S4, AC3). CSPRNG, 32 bytes hex-encoded (64 hex
// chars = 256 bits, well clear of the >=128-bit / >=16-byte floor).
describe("generateQrToken", () => {
  it("returns a 64-character lowercase hex string (32 bytes = 256 bits)", () => {
    const token = generateQrToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("AC3 — 1000 generated tokens: zero collisions, every one the expected length", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const token = generateQrToken();
      expect(token).toHaveLength(64);
      expect(token).toMatch(/^[0-9a-f]{64}$/);
      tokens.add(token);
    }
    expect(tokens.size).toBe(1000);
  });
});

// docs/agents/design/REQ-032.md §1 — isNoShow: REQ-032.md §1's
// first-match-wins table, the constructed admitted-checked-in /
// admitted-not-checked-in / withdrawn triple.
describe("isNoShow — REQ-032.md §1's first-match-wins table, the constructed admitted-checked-in / admitted-not-checked-in / withdrawn triple", () => {
  const endsAt = new Date("2026-09-01T00:00:00Z");
  const evaluationTime = new Date("2026-09-01T02:00:00Z");

  it("Registration 1 — admitted, checked in: returns false (checked in wins regardless of endsAt)", () => {
    const reg1 = isNoShow("admitted", new Date("2026-09-01T00:05:00Z"), endsAt, evaluationTime);
    expect(reg1).toBe(false);
  });

  it("Registration 2 — admitted, never checked in: returns true (the exact no-show condition)", () => {
    const reg2 = isNoShow("admitted", null, endsAt, evaluationTime);
    expect(reg2).toBe(true);
  });

  it("Registration 3 — withdrawn: returns false (admission !== 'admitted' short-circuits before checkedInAt/endsAt are even consulted)", () => {
    const reg3 = isNoShow("withdrawn", null, endsAt, evaluationTime);
    expect(reg3).toBe(false);
  });

  it("across the three constructed registrations, exactly one (Registration 2) evaluates to true", () => {
    const reg1 = isNoShow("admitted", new Date("2026-09-01T00:05:00Z"), endsAt, evaluationTime);
    const reg2 = isNoShow("admitted", null, endsAt, evaluationTime);
    const reg3 = isNoShow("withdrawn", null, endsAt, evaluationTime);
    expect([reg1, reg2, reg3]).toEqual([false, true, false]);
  });
});

// §5.1 — resolveRegistrationSource.
describe("resolveRegistrationSource", () => {
  it("returns pendingSource unchanged when non-null", () => {
    expect(resolveRegistrationSource("linkedin")).toBe("linkedin");
  });

  it("returns 'direct' when pendingSource is null", () => {
    expect(resolveRegistrationSource(null)).toBe("direct");
  });
});
