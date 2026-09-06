import { describe, expect, it } from "vitest";
import { formatDateTimeInTimezone } from "./formatTimeInTimezone.js";

// REQ-017 §2 — chapter-timezone rendering mechanism (AC2). The critical
// property: the rendered wall-clock time reflects the CHAPTER's zone,
// independent of process.env.TZ or any ambient default. This file's own
// process TZ is whatever the test runner happens to use — the assertions
// below never rely on it, exactly the discipline the function itself
// follows.
//
// REQ-017 design doc (data-mapping table + worked example) specifies
// 24-hour wall-clock output literally, e.g. "Oct 1, 2026, 18:00". The
// formatter must render 24-hour time for EVERY supported locale, including
// en-US which `Intl` otherwise defaults to a 12-hour AM/PM clock — that
// mismatch was a real defect (TEST-DESIGN-VALIDATOR, Step 3b) and these
// assertions lock it down so it cannot regress silently.

describe("formatDateTimeInTimezone", () => {
  const at = new Date("2026-10-01T13:00:00.000Z");

  it("renders 24-hour time in the EXPLICIT timezone parameter (en), not the ambient one", () => {
    // Asia/Tashkent is UTC+5 — 13:00 UTC -> 18:00 local.
    const tashkent = formatDateTimeInTimezone(at, "Asia/Tashkent", "en");
    expect(tashkent).toContain("18:00");
    expect(tashkent).not.toContain("PM");
    expect(tashkent).not.toContain("AM");
  });

  it("renders 24-hour time in the EXPLICIT timezone parameter (ru)", () => {
    const tashkent = formatDateTimeInTimezone(at, "Asia/Tashkent", "ru");
    expect(tashkent).toContain("18:00");
    expect(tashkent).not.toMatch(/[AP]M/i);
  });

  it("renders a DIFFERENT wall-clock time for a different explicit timezone, same instant", () => {
    // America/New_York is UTC-4 in October (EDT) — 13:00 UTC -> 09:00 local.
    const newYork = formatDateTimeInTimezone(at, "America/New_York", "en");
    expect(newYork).toContain("09:00");
    expect(newYork).not.toContain("AM");
    expect(newYork).not.toBe(formatDateTimeInTimezone(at, "Asia/Tashkent", "en"));
  });

  it("resolves the locale from lang (ru -> ru-RU month name, en -> en-US month name)", () => {
    const ru = formatDateTimeInTimezone(at, "UTC", "ru");
    const en = formatDateTimeInTimezone(at, "UTC", "en");
    expect(ru).not.toBe(en);
  });

  it("byte-for-byte matches regardless of process.env.TZ — the function never reads it", () => {
    const originalTz = process.env.TZ;
    try {
      process.env.TZ = "America/New_York";
      const withMismatchedTz = formatDateTimeInTimezone(at, "Asia/Tashkent", "en");
      process.env.TZ = "UTC";
      const withUtcTz = formatDateTimeInTimezone(at, "Asia/Tashkent", "en");
      expect(withMismatchedTz).toBe(withUtcTz);
      expect(withMismatchedTz).toContain("18:00");
    } finally {
      if (originalTz === undefined) {
        delete process.env.TZ;
      } else {
        process.env.TZ = originalTz;
      }
    }
  });
});
