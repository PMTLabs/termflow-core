// Plan 061: the "Over ssh" section of the docs site copies the remote prompt-hook
// snippets verbatim. This checks the three fenced code blocks (bash, zsh, fish) are
// byte-equal to REMOTE_HOOK_SNIPPETS, or rewrites them with --write.
//
//   bun scripts/check-remote-hook-docs.ts [--write] [path/to/13-snippets-and-command-history.md]
//
// The docs live in a sibling repo, so when the file is absent the check is skipped
// (exit 0) unless a path was passed explicitly.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REMOTE_HOOK_SHELLS, REMOTE_HOOK_SNIPPETS } from '../src/renderer/components/Terminal/remoteHookSnippets';

const args = process.argv.slice(2);
const write = args.includes('--write');
const explicit = args.find((a) => !a.startsWith('--'));
const docsPath = resolve(
  explicit ?? `${__dirname}/../../termflow-docs/docs/04-using-the-terminal/13-snippets-and-command-history.md`,
);

if (!existsSync(docsPath)) {
  if (explicit) {
    console.error(`docs file not found: ${docsPath}`);
    process.exit(1);
  }
  console.log(`skipped: ${docsPath} not found (termflow-docs is not checked out next to termflow-core)`);
  process.exit(0);
}

const eol = readFileSync(docsPath, 'utf8').includes('\r\n') ? '\r\n' : '\n';
let text = readFileSync(docsPath, 'utf8');
let bad = 0;
for (const shell of REMOTE_HOOK_SHELLS) {
  const re = new RegExp('(```' + shell + '\\r?\\n)([^\\r\\n]*)(\\r?\\n```)');
  const m = text.match(re);
  if (!m) {
    console.error(`no \`\`\`${shell} block with a single line found`);
    bad++;
    continue;
  }
  if (m[2] === REMOTE_HOOK_SNIPPETS[shell]) continue;
  if (write) {
    text = text.replace(re, (_all, open, _body, close) => open + REMOTE_HOOK_SNIPPETS[shell] + close);
    console.log(`rewrote ${shell} block`);
  } else {
    console.error(`${shell} block differs from REMOTE_HOOK_SNIPPETS.${shell}`);
    bad++;
  }
}
if (write && bad === 0) writeFileSync(docsPath, text.split(/\r?\n/).join(eol));
if (bad) process.exit(1);
console.log(write ? 'docs blocks written' : 'docs blocks match the snippet constants');
