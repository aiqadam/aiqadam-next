import { describe, expect, it } from "vitest";
import { determineOnboardingStep } from "./onboarding.js";
import type { ProfileRecord } from "./profile.js";

// REQ-019 §3.1 — pure-function coverage of the composed onboarding step
// derivation. advanceOnboarding itself (the side-effecting half) is verified
// against a real grammY dispatch + live Postgres per this run's handoff.

const completeProfile: ProfileRecord = {
  firstName: "A",
  lastName: "B",
  company: "C",
  position: "D",
  isStudent: false,
  experienceLevel: "user",
  phone: null,
  email: null,
  linksGithub: null,
  linksLinkedin: null,
  linksSite: null,
  phoneSkipped: true,
  emailSkipped: true,
  linksGithubSkipped: true,
  linksLinkedinSkipped: true,
  linksSiteSkipped: true,
};

describe("determineOnboardingStep", () => {
  it("consent-needed wins regardless of chapter/profile state (AC3's own mechanism)", () => {
    expect(determineOnboardingStep(false, true, completeProfile)).toEqual({
      kind: "consent-needed",
    });
    expect(determineOnboardingStep(false, false, null)).toEqual({ kind: "consent-needed" });
  });

  it("chapter-needed once consent is recorded but no chapter is assigned", () => {
    expect(determineOnboardingStep(true, false, null)).toEqual({ kind: "chapter-needed" });
  });

  it("profile-field once consent and chapter are both satisfied", () => {
    expect(determineOnboardingStep(true, true, null)).toEqual({
      kind: "profile-field",
      field: "firstName",
    });
  });

  it("ready (AC4) once consent, chapter, and profile are all satisfied", () => {
    expect(determineOnboardingStep(true, true, completeProfile)).toEqual({ kind: "ready" });
  });
});
