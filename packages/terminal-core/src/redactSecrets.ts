// Best-effort secret redaction (backlog 011). Replaces secret-shaped VALUES with
// '***' while keeping the command itself, so history stays useful — never drops
// the whole line. Assignment/flag/header forms first, then bare key literals.
const RULES: Array<{ pattern: RegExp; replacement: string }> = [
  // password=..., TOKEN: ..., api-key=..., SECRET_KEY=..., AUTH_TOKEN_PROD=...:
  // the keyword may sit ANYWHERE in the variable name (prefix AND suffix chars
  // allowed) — Django's SECRET_KEY / Rails' SECRET_KEY_BASE must not bypass.
  // The value must IMMEDIATELY follow `=`/`:` (no whitespace), so prose like
  // `-m "docs: explain token= syntax"` never has its next word redacted. The
  // double-quoted form handles shell-escaped quotes (\") inside the value; the
  // bare fallback excludes lone quote chars so a benign trailing quote
  // (`echo "my token:"`) is never swallowed into an unbalanced-quote redaction.
  {
    pattern:
      /\b((?:[a-z0-9_-]*(?:password|passwd|token|secret|api[-_]?key|apikey|access[-_]?key|private[-_]?key)[a-z0-9_-]*)\s*[=:])("(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+)/gi,
    replacement: '$1***',
  },
  // --password s3cr3t / --token abc (space-separated flag form).
  {
    pattern:
      /((?:^|\s)--(?:password|token|api-key|secret|client-secret)\s+)("(?:\\.|[^"\\])*"|'[^']*'|[^\s"']+)/gi,
    replacement: '$1***',
  },
  // Authorization: Bearer <value> (also Basic/Token); value may be quoted,
  // including shell-escaped quotes (\"...\") inside a double-quoted header arg.
  {
    pattern: /(authorization:\s*(?:bearer|basic|token)\s+)(\\?"[^"]*"|'[^']*'|[^\s"']+)/gi,
    replacement: '$1***',
  },
  // Bare key-shaped literals.
  { pattern: /\bsk-[A-Za-z0-9_-]{8,}\b/g, replacement: '***' },
  { pattern: /\bAKIA[A-Z0-9]{8,}\b/g, replacement: '***' },
  { pattern: /\bghp_[A-Za-z0-9]{20,}\b/g, replacement: '***' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, replacement: '***' },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, replacement: '***' },
];

export function redactSecrets(command: string): string {
  let out = command;
  for (const { pattern, replacement } of RULES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
