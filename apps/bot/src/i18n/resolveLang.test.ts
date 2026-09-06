import { describe, expect, it } from "vitest";
import { mapTelegramLanguageCode, resolveLang } from "./resolveLang.js";

// Pure, DB-free functions — proportional unit coverage per REQ-014's
// resolveOrCreateUser dependency on mapTelegramLanguageCode (design §2.2).

describe("resolveLang", () => {
  it("prefers an exact bot-recognized userLang", () => {
    expect(resolveLang("en", "ru")).toBe("en");
  });

  it("falls back to chapterDefaultLang when userLang is unrecognized", () => {
    expect(resolveLang(null, "en")).toBe("en");
    expect(resolveLang("kk", "en")).toBe("en");
  });

  it("falls back to ru when neither is a recognized bot lang", () => {
    expect(resolveLang(null, null)).toBe("ru");
    expect(resolveLang("kk", "uz")).toBe("ru");
  });
});

describe("mapTelegramLanguageCode", () => {
  it("recognizes ru/en region-tagged codes via startsWith", () => {
    expect(mapTelegramLanguageCode("ru")).toBe("ru");
    expect(mapTelegramLanguageCode("ru-RU")).toBe("ru");
    expect(mapTelegramLanguageCode("en-US")).toBe("en");
  });

  it("returns null for unrecognized or missing codes", () => {
    expect(mapTelegramLanguageCode("kk")).toBeNull();
    expect(mapTelegramLanguageCode(undefined)).toBeNull();
    expect(mapTelegramLanguageCode(null)).toBeNull();
  });
});
