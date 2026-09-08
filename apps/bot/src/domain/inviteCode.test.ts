import { describe, expect, it } from "vitest";
import {
  generateInviteCode,
  INVITE_CODE_ALPHABET,
  INVITE_CODE_LENGTH,
} from "./inviteCode.js";

// docs/agents/design/REQ-033.md §4 / handoff AC6, AC7.

describe("generateInviteCode", () => {
  it("returns a 26-character string", () => {
    const code = generateInviteCode();
    expect(code).toHaveLength(26);
    expect(code).toHaveLength(INVITE_CODE_LENGTH);
  });

  it("the alphabet is exactly the 32-symbol, L/Q-included, 0/O/1/I-excluded set", () => {
    expect(INVITE_CODE_ALPHABET).toBe("23456789ABCDEFGHJKLMNPQRSTUVWXYZ");
    expect(INVITE_CODE_ALPHABET).toHaveLength(32);
    expect(INVITE_CODE_ALPHABET).toContain("L");
    expect(INVITE_CODE_ALPHABET).toContain("Q");
    for (const excluded of ["0", "O", "1", "I"]) {
      expect(INVITE_CODE_ALPHABET).not.toContain(excluded);
    }
  });

  it("AC7: every character of 1000 generated codes is in the stated alphabet", () => {
    for (let i = 0; i < 1000; i++) {
      const code = generateInviteCode();
      for (const ch of code) {
        expect(INVITE_CODE_ALPHABET).toContain(ch);
      }
    }
  });

  it("AC6: 10000 generated codes have zero collisions", () => {
    const codes = new Set<string>();
    for (let i = 0; i < 10000; i++) {
      codes.add(generateInviteCode());
    }
    expect(codes.size).toBe(10000);
  });

  it("draws from a CSPRNG source: this module never calls Math.random", () => {
    // git-grep-equivalent, expressed as a runtime source check so it fails
    // loudly in CI if the implementation ever changes (S4).
    const mathRandomSpy = Math.random;
    let called = false;
    Math.random = () => {
      called = true;
      return mathRandomSpy();
    };
    try {
      generateInviteCode();
      expect(called).toBe(false);
    } finally {
      Math.random = mathRandomSpy;
    }
  });
});
