import { describe, expect, it } from "vitest";
import { checkOrganizerForChapter, type ActingUser } from "./eventAuthorization.js";

// REQ-016 §0/§1 (parallel copy) — pure-predicate coverage over already-resolved data, no DB
// needed. Mirrors the design's exact numbered rules so a future edit that
// reorders/reinterprets them fails a test, not just a review.

const CHAPTER_A = "11111111-1111-1111-1111-111111111111";
const CHAPTER_B = "22222222-2222-2222-2222-222222222222";

describe("checkOrganizerForChapter", () => {
  it("refuses with 'no-user' when no users row resolved at all", () => {
    const result = checkOrganizerForChapter(null, CHAPTER_A);
    expect(result).toEqual({ ok: false, reason: "no-user" });
  });

  it("refuses a member with 'not-organizer', regardless of chapter match", () => {
    const member: ActingUser = { id: "u1", role: "member", chapterId: CHAPTER_A };
    expect(checkOrganizerForChapter(member, CHAPTER_A)).toEqual({
      ok: false,
      reason: "not-organizer",
    });
    expect(checkOrganizerForChapter(member, CHAPTER_B)).toEqual({
      ok: false,
      reason: "not-organizer",
    });
  });

  it("allows an owner to act on any chapter, including one that isn't their own", () => {
    const owner: ActingUser = { id: "u2", role: "owner", chapterId: null };
    expect(checkOrganizerForChapter(owner, CHAPTER_A)).toEqual({
      ok: true,
      user: owner,
    });
    expect(checkOrganizerForChapter(owner, CHAPTER_B)).toEqual({
      ok: true,
      user: owner,
    });
  });

  it("allows an organizer acting on their own chapter", () => {
    const organizer: ActingUser = {
      id: "u3",
      role: "organizer",
      chapterId: CHAPTER_A,
    };
    expect(checkOrganizerForChapter(organizer, CHAPTER_A)).toEqual({
      ok: true,
      user: organizer,
    });
  });

  it("refuses an organizer of chapter A acting on chapter B with 'wrong-chapter'", () => {
    const organizer: ActingUser = {
      id: "u3",
      role: "organizer",
      chapterId: CHAPTER_A,
    };
    expect(checkOrganizerForChapter(organizer, CHAPTER_B)).toEqual({
      ok: false,
      reason: "wrong-chapter",
    });
  });

  it("refuses an organizer with a null chapter_id cleanly, never treating null as a match (Step 1b null-guard)", () => {
    const organizerNoChapter: ActingUser = {
      id: "u4",
      role: "organizer",
      chapterId: null,
    };
    expect(checkOrganizerForChapter(organizerNoChapter, CHAPTER_A)).toEqual({
      ok: false,
      reason: "wrong-chapter",
    });
    // Even an empty-string sentinel target (what the create handler passes
    // when it cannot resolve any chapter to target) must not accidentally
    // compare equal to a null chapterId.
    expect(checkOrganizerForChapter(organizerNoChapter, "")).toEqual({
      ok: false,
      reason: "wrong-chapter",
    });
  });
});
