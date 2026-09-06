import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

describe("loadConfig", () => {
  it("returns the config when both required variables are present", () => {
    const config = loadConfig({ BOT_TOKEN: "t", DATABASE_URL: "d" });
    expect(config).toEqual({ botToken: "t", databaseUrl: "d" });
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
