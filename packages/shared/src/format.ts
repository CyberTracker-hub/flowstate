/**
 * Financial number formatting. Unknown values always render as an em dash,
 * never as 0, so "no data" cannot be read as "zero".
 */

export const EMPTY = "—";

function usable(x: number | null | undefined): x is number {
  return typeof x === "number" && Number.isFinite(x);
}

function group(n: number, fractionDigits: number): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/**
 * Token price in USD with precision that adapts to magnitude:
 * >= 1 => 2 decimals; below 1 => 4 significant digits ("$0.00001234").
 */
export function formatPriceUsd(value: number | null | undefined): string {
  if (!usable(value)) return EMPTY;
  if (value === 0) return "$0.00";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1) return `${sign}$${group(abs, 2)}`;
  const exponent = Math.floor(Math.log10(abs));
  const decimals = Math.min(12, Math.max(4, 3 - exponent));
  const fixed = abs.toFixed(decimals);
  // Trim trailing zeros but keep at least 4 decimals for tabular alignment.
  const trimmed = fixed.replace(/0+$/, "");
  const [whole, frac = ""] = trimmed.split(".");
  return `${sign}$${whole}.${frac.padEnd(4, "0")}`;
}

const COMPACT_UNITS: ReadonlyArray<[number, string]> = [
  [1e12, "T"],
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
];

/** 1234 => "1.23K", 1_500_000 => "1.50M". Values below 1,000 keep up to 2 decimals. */
export function formatCompact(value: number | null | undefined): string {
  if (!usable(value)) return EMPTY;
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  for (let i = 0; i < COMPACT_UNITS.length; i++) {
    const unit = COMPACT_UNITS[i];
    if (unit === undefined || abs < unit[0]) continue;
    const text = (abs / unit[0]).toFixed(2);
    // Avoid "1000.00K": when rounding reaches 1000, promote to the next unit.
    const larger = COMPACT_UNITS[i - 1];
    if (text === "1000.00" && larger !== undefined) return `${sign}1.00${larger[1]}`;
    return `${sign}${text}${unit[1]}`;
  }
  const small = Number.isInteger(abs) ? abs.toString() : abs.toFixed(2);
  return small === "1000.00" ? `${sign}1.00K` : `${sign}${small}`;
}

/** Compact USD amount for volume, liquidity and market cap. */
export function formatCompactUsd(value: number | null | undefined): string {
  if (!usable(value)) return EMPTY;
  const body = formatCompact(Math.abs(value));
  return `${value < 0 ? "-" : ""}$${body}`;
}

/** Signed percentage. Input is already in percent units (5 => "+5.00%"). */
export function formatPercent(value: number | null | undefined, fractionDigits = 2): string {
  if (!usable(value)) return EMPTY;
  const rounded = Number(value.toFixed(fractionDigits));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "-" : "";
  return `${sign}${group(Math.abs(rounded), fractionDigits)}%`;
}

/** Multiplier such as a volume ratio: 3.42 => "3.4x". */
export function formatRatio(value: number | null | undefined): string {
  if (!usable(value)) return EMPTY;
  return `${value.toFixed(1)}x`;
}

export function formatCount(value: number | null | undefined): string {
  if (!usable(value)) return EMPTY;
  return group(Math.round(value), 0);
}

/** Shorten a mint address for display: "So111…1112". Never use as an identifier. */
export function shortenAddress(address: string, visible = 4): string {
  if (address.length <= visible * 2 + 1) return address;
  return `${address.slice(0, visible)}…${address.slice(-visible)}`;
}
