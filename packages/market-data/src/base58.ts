/**
 * Minimal base58 (Bitcoin alphabet) codec, enough to validate Solana
 * addresses without pulling in a dependency.
 */

const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map<string, number>([...ALPHABET].map((c, i) => [c, i]));

export function base58Encode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
  // Big-number base conversion, base 256 -> base 58.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    for (let j = 0; j < digits.length; j++) {
      carry += (digits[j] ?? 0) << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }
  let out = "1".repeat(zeros);
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i] ?? 0];
  return out;
}

/** Returns null for any string that is not valid base58. */
export function base58Decode(text: string): Uint8Array | null {
  if (typeof text !== "string" || text.length === 0) return null;
  let zeros = 0;
  while (zeros < text.length && text[zeros] === "1") zeros += 1;
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i++) {
    const value = INDEX.get(text[i] ?? "");
    if (value === undefined) return null;
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += (bytes[j] ?? 0) * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i] ?? 0;
  return out;
}

/**
 * A Solana mint address is the base58 encoding of exactly 32 bytes. The mint
 * address is the canonical token identity; tickers are never identifiers.
 */
export function isValidMint(address: unknown): address is string {
  if (typeof address !== "string" || address.length < 32 || address.length > 44) return false;
  const bytes = base58Decode(address);
  return bytes !== null && bytes.length === 32;
}
