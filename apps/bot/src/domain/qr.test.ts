import { describe, expect, it } from "vitest";
import { PNG } from "pngjs";
import { renderCheckInQrPng } from "./qr.js";
// jsqr's shipped .d.ts (dist/index.d.ts) declares `export default jsQR`, but
// its actual runtime entry (dist/jsQR.js, a UMD bundle with no `__esModule`
// marker) makes esModuleInterop synthesize BOTH a plain namespace import and
// its own `.default` property as the whole module object, not the function
// -- under this project's NodeNext + esModuleInterop combination, neither
// resolves to a callable type from the .d.ts alone (a known jsqr packaging
// mismatch between its "main" and "types" fields, verified at runtime:
// `require("jsqr")` genuinely is the callable decoder function). This local
// type restates the .d.ts's own declared signature so the cast is narrow and
// checked, not an escape into `any`.
import * as jsQRModule from "jsqr";

type JsQRFn = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
) => { data: string } | null;

// The two toolchains that load this file (tsc/Node's own CJS interop for
// `npm run build`, and Vite/esbuild's CJS interop under vitest) disagree on
// which of these two shapes actually holds the callable function -- picking
// whichever one is a function at runtime works under both.
const jsQRCandidate = jsQRModule as unknown as { default?: JsQRFn } & JsQRFn;
const jsQR: JsQRFn =
  typeof jsQRCandidate.default === "function" ? jsQRCandidate.default : jsQRCandidate;

// docs/agents/design/REQ-024.md §2/§6 AC3 — "an admitted row's QR image,
// decoded by an ACTUAL QR decoder, contains exactly
// `?start=ci_<that registration's qr_token>`". This test decodes the real
// produced PNG bytes with jsqr (a real QR decoder) + pngjs (a real PNG
// decoder) -- it does NOT just inspect the string passed to the encoder.

async function decodePng(buffer: Buffer): Promise<string | null> {
  const png = PNG.sync.read(buffer);
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  return decoded?.data ?? null;
}

describe("renderCheckInQrPng — REQ-024 AC3: real QR decode proof", () => {
  it("produces a PNG whose decoded content is exactly https://t.me/<botUsername>?start=ci_<qrToken>", async () => {
    const qrToken = "a".repeat(64);
    const botUsername = "test_bot";

    const png = await renderCheckInQrPng({ botUsername, qrToken });
    expect(Buffer.isBuffer(png)).toBe(true);

    const decodedText = await decodePng(png);
    expect(decodedText).toBe(`https://t.me/${botUsername}?start=ci_${qrToken}`);
    // The AC's own wording: the decoded content contains exactly this
    // substring.
    expect(decodedText).toContain(`?start=ci_${qrToken}`);
  });

  it("a fresh buffer is produced on every call (no caching)", async () => {
    const input = { botUsername: "test_bot", qrToken: "b".repeat(64) };
    const first = await renderCheckInQrPng(input);
    const second = await renderCheckInQrPng(input);
    expect(first).not.toBe(second);
    expect(first.equals(second)).toBe(true);
  });
});
