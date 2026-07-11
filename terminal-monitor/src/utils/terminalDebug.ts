/**
 * Terminal debugging utilities
 */

/**
 * Convert a string to show all escape sequences visibly
 */
export function debugEscapeSequences(str: string): string {
  return str
    .replace(/\x1b/g, '\\x1b')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x1F\x7F-\x9F]/g, (match) => {
      const code = match.charCodeAt(0);
      return `\\x${code.toString(16).padStart(2, '0')}`;
    });
}

/**
 * Log terminal data with escape sequences visible
 */
export function logTerminalData(label: string, data: string): void {
  console.log(`[Terminal Debug] ${label}:`, debugEscapeSequences(data));

  // Also log if it contains clear screen sequences
  const clearPatterns = [
    { pattern: '\x1b[2J', name: 'Clear Screen' },
    { pattern: '\x1b[3J', name: 'Clear Screen + Scrollback' },
    { pattern: '\x1b[H', name: 'Cursor Home' },
    { pattern: '\x1b[0J', name: 'Clear to End of Screen' },
    { pattern: '\x1b[1J', name: 'Clear to Beginning of Screen' },
    { pattern: '\x1bc', name: 'Reset Terminal' },
    { pattern: '\x0C', name: 'Form Feed' },
  ];

  const found = clearPatterns.filter((p) => data.includes(p.pattern));
  if (found.length > 0) {
    console.log(
      `[Terminal Debug] Found escape sequences:`,
      found.map((f) => f.name).join(', ')
    );
  }
}
