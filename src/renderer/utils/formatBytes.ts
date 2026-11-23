const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/** Parses a byte count given as a number, bigint or decimal string (SFTP sizes arrive as u64 strings). */
function parse(bytes: number | bigint | string): bigint | undefined {
  if (typeof bytes === 'bigint') return bytes >= 0n ? bytes : undefined;
  if (typeof bytes === 'number') return Number.isSafeInteger(bytes) && bytes >= 0 ? BigInt(bytes) : undefined;
  return /^\d+$/.test(bytes.trim()) ? BigInt(bytes.trim()) : undefined;
}

/**
 * Human-readable size in 1024-based units: "20 B", "1.5 MB", "256 KB".
 * One decimal below 10 (a trailing ".0" is dropped), whole numbers from 10 up.
 * A value that rounds up to 1024 is promoted to the next unit, so 1023.6 KB prints "1 MB", never "1024 KB".
 * Input that is not a non-negative integer is shown as given, followed by " B".
 */
export function formatBytes(bytes: number | bigint | string): string {
  const exact = parse(bytes);
  if (exact === undefined) return `${String(bytes)} B`;
  let value = Number(exact);
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit++; }
  let shown = round(value);
  if (shown >= 1024 && unit < UNITS.length - 1) { value /= 1024; unit++; shown = round(value); }
  return `${shown.toLocaleString('en-US', { maximumFractionDigits: 1, useGrouping: false })} ${UNITS[unit]}`;
}

/** Exact count with grouping for tooltips: "262,144 bytes", "1 byte". */
export function formatBytesExact(bytes: number | bigint | string): string {
  const exact = parse(bytes);
  if (exact === undefined) return `${String(bytes)} bytes`;
  return `${exact.toLocaleString('en-US')} ${exact === 1n ? 'byte' : 'bytes'}`;
}

function round(value: number): number {
  return value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
}
