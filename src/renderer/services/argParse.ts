/**
 * Split a command-line argument string into argv entries. Whitespace separates
 * arguments; double quotes group text containing spaces (`-NoLogo -Command "Get-Date -Format o"`);
 * `\"` is a literal quote. Throws on an unclosed quote rather than guessing.
 */
export function parseArgs(input: string): string[] {
  const args: string[] = [];
  let current = '';
  let inQuotes = false;
  let hasToken = false;
  const chars = [...input];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '\\' && chars[i + 1] === '"') {
      current += '"';
      hasToken = true;
      i++;
    } else if (ch === '"') {
      inQuotes = !inQuotes;
      hasToken = true;
    } else if (!inQuotes && /\s/.test(ch)) {
      if (hasToken) args.push(current);
      current = '';
      hasToken = false;
    } else {
      current += ch;
      hasToken = true;
    }
  }
  if (inQuotes) throw new Error('Arguments have an unclosed double quote.');
  if (hasToken) args.push(current);
  return args;
}

