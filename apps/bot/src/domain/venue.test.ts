import { describe, expect, it } from "vitest";
import {
  parseVenueFields,
  validateVenueCreateInput,
  validateVenueUpdateInput,
} from "./venue.js";

// REQ-015 §2.2/§2.3/§4 step 3 — framework-free, no-DB coverage for the
// parsing/validation functions the create and edit handlers call.

describe("parseVenueFields", () => {
  it("splits each line on the first ':' and trims both sides", () => {
    const fields = parseVenueFields("name: Coworking Ilon\naddress: Tashkent, Chilanzar, 12");
    expect(fields).toEqual({
      name: "Coworking Ilon",
      address: "Tashkent, Chilanzar, 12",
    });
  });

  it("splits on the FIRST ':' only, so a value containing ':' survives intact", () => {
    const fields = parseVenueFields("yandex: https://yandex.uz/maps/-/CCU...");
    expect(fields["yandex"]).toBe("https://yandex.uz/maps/-/CCU...");
  });

  it("lowercases labels (case-insensitive)", () => {
    const fields = parseVenueFields("Name: X\nADDRESS: Y");
    expect(fields).toEqual({ name: "X", address: "Y" });
  });

  it("ignores lines with no ':' and blank lines", () => {
    const fields = parseVenueFields("name: X\n\nnot a field line\naddress: Y");
    expect(fields).toEqual({ name: "X", address: "Y" });
  });

  it("ignores unknown labels (forward compatible) — they are simply present, not rejected", () => {
    const fields = parseVenueFields("name: X\nunknown_label: Z");
    expect(fields["unknown_label"]).toBe("Z");
  });
});

describe("validateVenueCreateInput", () => {
  const complete = {
    name: "Coworking Ilon",
    address: "Tashkent, Chilanzar, 12",
    yandex: "https://yandex.uz/maps/x",
    google: "https://maps.google.com/?q=x",
    capacity: "40",
  };

  it("succeeds with all required fields and no coordinates, lat/lon null", () => {
    const result = validateVenueCreateInput(complete);
    expect(result).toEqual({
      ok: true,
      value: {
        name: "Coworking Ilon",
        address: "Tashkent, Chilanzar, 12",
        yandexUrl: "https://yandex.uz/maps/x",
        googleUrl: "https://maps.google.com/?q=x",
        capacity: 40,
        lat: null,
        lon: null,
        notes: null,
      },
    });
  });

  it("succeeds with lat/lon both present", () => {
    const result = validateVenueCreateInput({ ...complete, lat: "41.311", lon: "69.240" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.lat).toBe(41.311);
      expect(result.value.lon).toBe(69.24);
    }
  });

  it("is refused naming 'yandex' when missing", () => {
    const { yandex, ...rest } = complete;
    void yandex;
    const result = validateVenueCreateInput(rest);
    expect(result).toEqual({ ok: false, missing: ["yandex"] });
  });

  it("is refused naming 'google' when missing", () => {
    const { google, ...rest } = complete;
    void google;
    const result = validateVenueCreateInput(rest);
    expect(result).toEqual({ ok: false, missing: ["google"] });
  });

  it("collects EVERY missing required field, not just the first", () => {
    const result = validateVenueCreateInput({ name: "X" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.missing).toEqual(["address", "yandex", "google", "capacity"]);
    }
  });

  it("refuses naming 'capacity' when it does not parse as a positive integer", () => {
    expect(validateVenueCreateInput({ ...complete, capacity: "0" })).toEqual({
      ok: false,
      missing: ["capacity"],
    });
    expect(validateVenueCreateInput({ ...complete, capacity: "abc" })).toEqual({
      ok: false,
      missing: ["capacity"],
    });
    expect(validateVenueCreateInput({ ...complete, capacity: "-5" })).toEqual({
      ok: false,
      missing: ["capacity"],
    });
  });

  it("refuses naming 'lon' when lat is present but lon is not (not a generic 'coordinates missing')", () => {
    const result = validateVenueCreateInput({ ...complete, lat: "41.311" });
    expect(result).toEqual({ ok: false, missing: ["lon"] });
  });

  it("refuses naming 'lat' when lon is present but lat is not", () => {
    const result = validateVenueCreateInput({ ...complete, lon: "69.240" });
    expect(result).toEqual({ ok: false, missing: ["lat"] });
  });
});

describe("validateVenueUpdateInput", () => {
  it("returns ok with empty changes when no recognized fields are supplied", () => {
    const result = validateVenueUpdateInput({});
    expect(result).toEqual({ ok: true, changes: {}, changedFields: [] });
  });

  it("updates only the supplied fields", () => {
    const result = validateVenueUpdateInput({ capacity: "50" });
    expect(result).toEqual({
      ok: true,
      changes: { capacity: 50 },
      changedFields: ["capacity"],
    });
  });

  it("refuses naming 'yandex' when supplied but blank (cannot clear a required field)", () => {
    const result = validateVenueUpdateInput({ yandex: "" });
    expect(result).toEqual({ ok: false, missing: ["yandex"] });
  });

  it("refuses naming 'google' when supplied but blank", () => {
    const result = validateVenueUpdateInput({ google: "  " });
    expect(result).toEqual({ ok: false, missing: ["google"] });
  });

  it("clears an optional field (notes) via an explicit empty value", () => {
    const result = validateVenueUpdateInput({ "notes": "" });
    expect(result).toEqual({
      ok: true,
      changes: { notes: null },
      changedFields: ["notes"],
    });
  });

  it("clears lat/lon independently via an explicit empty value, without requiring the other", () => {
    const result = validateVenueUpdateInput({ lat: "" });
    expect(result).toEqual({ ok: true, changes: { lat: null }, changedFields: ["lat"] });
  });

  it("refuses naming 'capacity' when supplied but not a positive integer", () => {
    expect(validateVenueUpdateInput({ capacity: "0" })).toEqual({
      ok: false,
      missing: ["capacity"],
    });
  });
});
