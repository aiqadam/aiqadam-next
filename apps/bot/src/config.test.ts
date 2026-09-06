import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("returns the config when both required variables are present", () => {
    const config = loadConfig({ BOT_TOKEN: "t", DATABASE_URL: "d" });
    expect(config).toEqual({
      botToken: "t",
      databaseUrl: "d",
      logLevel: "info",
      defaultChapterCode: undefined,
    });
  });

  it("defaults logLevel to info when LOG_LEVEL is unset", () => {
    const config = loadConfig({ BOT_TOKEN: "t", DATABASE_URL: "d" });
    expect(config.logLevel).toBe("info");
  });

  it("accepts a valid LOG_LEVEL", () => {
    const config = loadConfig({ BOT_TOKEN: "t", DATABASE_URL: "d", LOG_LEVEL: "debug" });
    expect(config.logLevel).toBe("debug");
  });

  it("throws naming the problem when LOG_LEVEL is invalid", () => {
    expect(() =>
      loadConfig({ BOT_TOKEN: "t", DATABASE_URL: "d", LOG_LEVEL: "verbose" }),
    ).toThrow(/invalid value for LOG_LEVEL/);
  });

  it("leaves defaultChapterCode undefined when DEFAULT_CHAPTER_CODE is unset", () => {
    const config = loadConfig({ BOT_TOKEN: "t", DATABASE_URL: "d" });
    expect(config.defaultChapterCode).toBeUndefined();
  });

  it("passes through DEFAULT_CHAPTER_CODE when set", () => {
    const config = loadConfig({ BOT_TOKEN: "t", DATABASE_URL: "d", DEFAULT_CHAPTER_CODE: "uz" });
    expect(config.defaultChapterCode).toBe("uz");
  });

  it("throws naming the missing variable when BOT_TOKEN is absent", () => {
    expect(() => loadConfig({ DATABASE_URL: "d" })).toThrow(/BOT_TOKEN/);
  });

  it("throws naming the missing variable when DATABASE_URL is absent", () => {
    expect(() => loadConfig({ BOT_TOKEN: "t" })).toThrow(/DATABASE_URL/);
  });

  it("throws naming both variables when neither is present", () => {
    expect(() => loadConfig({})).toThrow(/BOT_TOKEN.*DATABASE_URL/);
  });

  it("never includes the value of a present variable in the thrown message", () => {
    try {
      loadConfig({ BOT_TOKEN: "super-secret-token-value" });
      throw new Error("expected loadConfig to throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("super-secret-token-value");
    }
  });
});
