import { randomBytes } from "node:crypto";

// docs/agents/design/REQ-033.md §4 — the invite code VALUE generator. Pure,
// framework-free (decisions/0004): no grammY import, no I/O beyond the CSPRNG
// call, no DbClient dependency. Scope is the code value only — no issuing or
// redemption domain logic (that is REQ-037/REQ-038/REQ-039's job). Placed
// alongside (not inside) domain/registration.ts's generateQrToken(), per the
// design's own instruction: the two outputs serve different purposes
// (qr_token is machine-scanned only, never typed; this code is
// typed-or-scanned) and stay independently named and independently callable.

// §4 "Alphabet" — 32 symbols, visually-ambiguous characters excluded: digits
// 2-9 (0/1 excluded) plus uppercase A-Z minus I and O. L and Q ARE both
// included — 32 is already an exact power of two (log2(32) = 5 bits/char), so
// no further exclusion is made (design §4's explicit resolution of the one
// rework-cycle inconsistency).
export const INVITE_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

// §4 "Length and entropy" — 128-bit S4 floor / 5 bits per character = 25.6,
// rounded up to the smallest integer length that clears the floor: 26
// characters. Resulting entropy: 26 * 5 = 130 bits (>= 128, a 2-bit margin).
export const INVITE_CODE_LENGTH = 26;

// §4 "Generator shape" — one CSPRNG call (node:crypto's randomBytes, the same
// primitive generateQrToken() already uses; never Math.random, never a
// sequential id, never a hash of a user id, per S4's exact negative-case
// list), then an unbiased byte-to-symbol mapping. `byte % 32` is unbiased
// specifically because 32 evenly divides 256 (256 / 32 = 8 exactly) — every
// alphabet symbol is equally likely regardless of which byte value maps to
// it (design §4's explicit correctness note: this would NOT be safe for an
// alphabet size that does not evenly divide 256).
export function generateInviteCode(): string {
  const bytes = randomBytes(INVITE_CODE_LENGTH);
  let code = "";
  for (let i = 0; i < bytes.length; i++) {
    code += INVITE_CODE_ALPHABET[bytes[i]! % INVITE_CODE_ALPHABET.length];
  }
  return code;
}
