import { describe, expect, it } from "vitest";
import { ru } from "./ru.js";
import { en } from "./en.js";

// Key-set parity check (REQ-013 §4 / AC1). Folded into the existing `npm
// test` (Vitest at the repo root, already gated by ci-cd.yml's build job)
// rather than a bespoke standalone script.

type Leaf = Record<string, unknown>;

function flatten(obj: Leaf, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, flatten(value as Leaf, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

describe("i18n catalog parity", () => {
  it("ru and en have identical key sets", () => {
    const ruKeys = Object.keys(flatten(ru)).sort();
    const enKeys = Object.keys(flatten(en)).sort();
    expect(enKeys).toEqual(ruKeys);
  });

  it("every leaf value in ru is a non-empty string", () => {
    const values = Object.values(flatten(ru));
    for (const value of values) {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it("every leaf value in en is a non-empty string", () => {
    const values = Object.values(flatten(en));
    for (const value of values) {
      expect(typeof value).toBe("string");
      expect((value as string).length).toBeGreaterThan(0);
    }
  });
});
