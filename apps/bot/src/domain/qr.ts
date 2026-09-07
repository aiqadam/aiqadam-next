import QRCode from "qrcode";

// docs/agents/design/REQ-024.md §2 — the single shared QR-image renderer this
// requirement introduces. Framework-free (decisions/0004): no grammy import
// anywhere in this file, no I/O beyond the pure `qrcode` library call, no
// DbClient dependency. Placed alongside (not inside) domain/registration.ts
// per the design's own reasoning (this module's only export takes no `db`
// handle, unlike every other export in that file).

export interface CheckInQrInput {
  botUsername: string;
  qrToken: string;
}

// §2 step 1 — the exact deep-link template, no additional characters before,
// after, or between the pieces: `https://t.me/<botUsername>?start=ci_<qrToken>`.
// §2 step 2 — passed to the `qrcode` package's PNG-buffer generation entry
// point; a fresh buffer is produced on every call, no caching, no disk write.
export async function renderCheckInQrPng(input: CheckInQrInput): Promise<Buffer> {
  const deepLink = `https://t.me/${input.botUsername}?start=ci_${input.qrToken}`;
  return QRCode.toBuffer(deepLink, { type: "png" });
}
