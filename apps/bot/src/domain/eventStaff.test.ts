import { describe, expect, it } from "vitest";
import { parseStaffCommandArgs } from "./eventStaff.js";

// REQ-018 §2.1 — pure-function coverage over parseStaffCommandArgs, no DB
// needed. Mirrors the design's exact rules so a future edit that reorders/
// reinterprets them fails a test, not just a review.

describe("parseStaffCommandArgs", () => {
  it("returns null with fewer than two non-blank tokens", () => {
    expect(parseStaffCommandArgs("")).toBeNull();
    expect(parseStaffCommandArgs("   ")).toBeNull();
    expect(parseStaffCommandArgs("event123")).toBeNull();
  });

  it("parses eventId and tgUsername from exactly two tokens", () => {
    expect(parseStaffCommandArgs("event123 alice")).toEqual({
      eventId: "event123",
      tgUsername: "alice",
    });
  });

  it("strips one leading '@' from the username, no case-folding", () => {
    expect(parseStaffCommandArgs("event123 @Alice")).toEqual({
      eventId: "event123",
      tgUsername: "Alice",
    });
  });

  it("trims both tokens", () => {
    expect(parseStaffCommandArgs("  event123   @alice  ")).toEqual({
      eventId: "event123",
      tgUsername: "alice",
    });
  });

  it("ignores any tokens beyond the first two", () => {
    expect(parseStaffCommandArgs("event123 alice extra ignored")).toEqual({
      eventId: "event123",
      tgUsername: "alice",
    });
  });
});
