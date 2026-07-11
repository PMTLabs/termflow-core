// Generate legal/EULA.rtf (the installer license-agreement page) from legal/EULA.txt,
// so the RTF never drifts from the canonical text. Run after editing EULA.txt:
//   node scripts/gen-eula-rtf.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const txt = readFileSync(join(root, 'legal', 'EULA.txt'), 'utf8').replace(/\r\n/g, '\n');

// RTF escaping: backslash and braces are control chars; non-ASCII → \uN. Bold the
// "N." / "N.N" section headers so the installer page is readable.
const escapeRtf = (s) =>
  s
    .replace(/[\\{}]/g, (m) => '\\' + m)
    .replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0)}?`);

const body = txt
  .split('\n')
  .map((line) => {
    const esc = escapeRtf(line);
    if (/^\d+\.\s/.test(line)) return `{\\b ${esc}}\\par`; // "1. HEADER"
    return `${esc}\\par`;
  })
  .join('\n');

const rtf = `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Segoe UI;}}\n\\fs20\n${body}\n}\n`;
writeFileSync(join(root, 'legal', 'EULA.rtf'), rtf);
console.log(`[gen-eula-rtf] wrote legal/EULA.rtf (${rtf.length} bytes)`);
