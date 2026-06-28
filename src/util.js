// Small, dependency-light helpers shared across the CLI.
import { parseUnits } from 'viem';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Convert a raw cell value (number or string) coming from the spreadsheet into
 * a clean decimal string, WITHOUT going through float math that could corrupt
 * precision. Returns the canonical string or throws with a human message.
 */
export function normalizeAmountString(raw) {
  if (raw === null || raw === undefined || raw === '') {
    throw new Error('amount is empty');
  }

  let s;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) throw new Error(`amount is not finite (${raw})`);
    s = String(raw);
    // String() uses exponential form for very large/small magnitudes; refuse it
    // so we never silently mis-parse. Real payout amounts never need this.
    if (/e/i.test(s)) {
      throw new Error(`amount "${raw}" uses exponential notation; enter it as a plain decimal string`);
    }
  } else {
    s = String(raw).trim();
  }

  // Strip a leading currency-ish symbol and surrounding whitespace only.
  s = s.replace(/\s+/g, '');

  if (s.includes(',')) {
    throw new Error(`amount "${raw}" contains a comma; use a dot as the decimal separator and no thousand separators`);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new Error(`amount "${raw}" is not a valid non-negative decimal number`);
  }
  return s;
}

/**
 * Parse a raw amount into base units (wei) for a token with `decimals`.
 * Validates: numeric, > 0, and not more fractional digits than the token allows.
 * Returns { wei: bigint, human: string }.
 */
export function parseAmount(raw, decimals) {
  const s = normalizeAmountString(raw);

  const [, frac = ''] = s.split('.');
  if (frac.length > decimals) {
    throw new Error(`amount "${s}" has ${frac.length} decimal places but the token only supports ${decimals}`);
  }

  const wei = parseUnits(s, decimals);
  if (wei <= 0n) {
    throw new Error(`amount "${s}" must be greater than 0`);
  }
  return { wei, human: s };
}

/** Sum an array of bigints. */
export const sumBig = (arr) => arr.reduce((a, b) => a + b, 0n);

/** Pad/format a fixed-width table for the console. */
export function renderTable(headers, rows) {
  const cols = headers.length;
  const widths = headers.map((h, i) =>
    Math.max(String(h).length, ...rows.map((r) => String(r[i] ?? '').length)),
  );
  const line = (cells) =>
    cells.map((c, i) => String(c ?? '').padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '-'.repeat(w)).join('  ');
  return [line(headers), sep, ...rows.map(line)].join('\n');
}

/** Truncate a hash/address for compact display. */
export const shortHash = (h) =>
  h && h.length > 14 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h;
