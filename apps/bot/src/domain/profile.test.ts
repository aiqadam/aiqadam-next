import { describe, expect, it } from "vitest";
import {
  determineNextProfileField,
  isNonBlank,
  isProfileComplete,
  isValidEmailFormat,
  isValidExperienceLevelAnswer,
  isValidStudentAnswer,
  parseProfileEditFields,
  validateProfileEditInput,
  type ProfileRecord,
} from "./profile.js";

// REQ-019 §2 — pure-function coverage of the resumability derivation and
// validation rules. Live-DB coverage (writeRequiredProfileField/
// writeOptionalProfileField/markOptionalProfileFieldSkipped, the actual
// upsert shape, and the full handler dispatch) is verified separately
// against a real Postgres fixture per this run's handoff (result.summary).

function emptyProfile(overrides: Partial<ProfileRecord> = {}): ProfileRecord {
  return {
    firstName: null,
    lastName: null,
    company: null,
    position: null,
    isStudent: null,
    experienceLevel: null,
    phone: null,
    email: null,
    linksGithub: null,
    linksLinkedin: null,
    linksSite: null,
    phoneSkipped: false,
    emailSkipped: false,
    linksGithubSkipped: false,
    linksLinkedinSkipped: false,
    linksSiteSkipped: false,
    ...overrides,
  };
}

describe("determineNextProfileField", () => {
  it("returns firstName for a null profile (row does not exist yet)", () => {
    expect(determineNextProfileField(null)).toEqual({ kind: "field", field: "firstName" });
  });

  it("returns the first null required field in fixed order (AC1's own case: 3 answered, 4th next)", () => {
    const profile = emptyProfile({ firstName: "A", lastName: "B", company: "C" });
    expect(determineNextProfileField(profile)).toEqual({ kind: "field", field: "position" });
  });

  it("moves to the first optional field once all six required fields are set", () => {
    const profile = emptyProfile({
      firstName: "A",
      lastName: "B",
      company: "C",
      position: "D",
      isStudent: false,
      experienceLevel: "user",
    });
    expect(determineNextProfileField(profile)).toEqual({ kind: "field", field: "phone" });
  });

  it("skips an optional field marked skipped and moves to the next one", () => {
    const profile = emptyProfile({
      firstName: "A",
      lastName: "B",
      company: "C",
      position: "D",
      isStudent: false,
      experienceLevel: "user",
      phoneSkipped: true,
    });
    expect(determineNextProfileField(profile)).toEqual({ kind: "field", field: "email" });
  });

  it("AC2 — is complete once every optional field is skipped, none answered", () => {
    const profile = emptyProfile({
      firstName: "A",
      lastName: "B",
      company: "C",
      position: "D",
      isStudent: false,
      experienceLevel: "user",
      phoneSkipped: true,
      emailSkipped: true,
      linksGithubSkipped: true,
      linksLinkedinSkipped: true,
      linksSiteSkipped: true,
    });
    expect(determineNextProfileField(profile)).toEqual({ kind: "complete" });
    expect(isProfileComplete(profile)).toBe(true);
  });

  it("a value answered instead of skipped also counts as resolved", () => {
    const profile = emptyProfile({
      firstName: "A",
      lastName: "B",
      company: "C",
      position: "D",
      isStudent: false,
      experienceLevel: "user",
      phone: "+1234567890",
      emailSkipped: true,
      linksGithubSkipped: true,
      linksLinkedinSkipped: true,
      linksSiteSkipped: true,
    });
    expect(isProfileComplete(profile)).toBe(true);
  });

  it("isStudent === false is a legitimate answer, not treated as unanswered", () => {
    const profile = emptyProfile({ firstName: "A", lastName: "B", company: "C", position: "D" });
    expect(determineNextProfileField(profile)).toEqual({ kind: "field", field: "isStudent" });
    const answered = emptyProfile({
      firstName: "A",
      lastName: "B",
      company: "C",
      position: "D",
      isStudent: false,
    });
    expect(determineNextProfileField(answered)).toEqual({ kind: "field", field: "experienceLevel" });
  });
});

describe("isNonBlank", () => {
  it("rejects empty and whitespace-only strings", () => {
    expect(isNonBlank("")).toBe(false);
    expect(isNonBlank("   ")).toBe(false);
  });
  it("accepts a non-blank string", () => {
    expect(isNonBlank("  a  ")).toBe(true);
  });
});

describe("isValidEmailFormat (AC6)", () => {
  it("accepts a conventional address", () => {
    expect(isValidEmailFormat("a@b.com")).toBe(true);
  });
  it("rejects a blank string", () => {
    expect(isValidEmailFormat("")).toBe(false);
  });
  it("rejects a string with no @", () => {
    expect(isValidEmailFormat("a.b.com")).toBe(false);
  });
  it("rejects a string with no . in the domain", () => {
    expect(isValidEmailFormat("a@bcom")).toBe(false);
  });
  it("rejects embedded whitespace", () => {
    expect(isValidEmailFormat("a b@c.com")).toBe(false);
  });
});

describe("isValidStudentAnswer / isValidExperienceLevelAnswer", () => {
  it("accepts exactly yes/no case-insensitively", () => {
    expect(isValidStudentAnswer("Yes")).toBe(true);
    expect(isValidStudentAnswer("no")).toBe(true);
    expect(isValidStudentAnswer("maybe")).toBe(false);
  });
  it("accepts exactly the four experience tokens case-insensitively", () => {
    expect(isValidExperienceLevelAnswer("Builder")).toBe(true);
    expect(isValidExperienceLevelAnswer("wizard")).toBe(false);
  });
});

describe("parseProfileEditFields / validateProfileEditInput", () => {
  it("parses label:value lines, ignoring unrecognized labels", () => {
    const fields = parseProfileEditFields("first_name: Ada\nunknown: x\nemail: ada@example.com");
    expect(fields).toEqual({ first_name: "Ada", unknown: "x", email: "ada@example.com" });
  });

  it("accepts a valid partial update", () => {
    const result = validateProfileEditInput({ first_name: "Ada", phone: "skip" });
    expect(result).toEqual({ ok: true, updates: { firstName: "Ada", phone: "skip" } });
  });

  it("rejects invalid fields all-or-nothing, naming every invalid label", () => {
    const result = validateProfileEditInput({ student: "maybe", email: "not-an-email" });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.invalid.sort()).toEqual(["email", "student"]);
    }
  });

  it("AC6 — email 'skip' token never reaches format validation", () => {
    const result = validateProfileEditInput({ email: "skip" });
    expect(result).toEqual({ ok: true, updates: { email: "skip" } });
  });
});
