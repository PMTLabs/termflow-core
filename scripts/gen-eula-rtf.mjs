// Generate legal/EULA-installer.txt (the WiX/MSI license-agreement page) from the
// canonical legal/EULA.txt, so it never drifts from the real terms. Run after editing
// EULA.txt:  node scripts/gen-eula-rtf.mjs
// (Kept this filename because package.json's `gen:eula-rtf` script points at it.)
//
// Why plain text and not RTF: the installed tauri-bundler (2.9.x) does NOT pass an
// `.rtf` license through verbatim — it reads whatever `bundle.licenseFile` points at as
// PLAIN TEXT, replaces every newline with `\par`, and wraps the result in its own fixed
// RTF template before handing it to WiX's RichEdit control. So any RTF markup we author
// is shown as literal garbage, and — crucially — because EULA.txt is hard-wrapped at ~80
// columns, one `\par` per physical line makes RichEdit break sentences mid-line (the bug
// this fixes). The fix is to feed the bundler UN-wrapped text: one line per logical
// paragraph, so its newline→`\par` gives one paragraph per block and RichEdit re-wraps
// each to the dialog width. We also fold the sole non-ASCII char (em-dash) to ASCII,
// since the bundler's plain-text path emits raw bytes under \ansicpg1252 (no \uN escape),
// which would otherwise render as mojibake.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const txt = readFileSync(join(root, 'legal', 'EULA.txt'), 'utf8').replace(/\r\n/g, '\n');

// A physical source line is a wrapped continuation of the paragraph above it only when
// that line was "full" (near the ~80-col wrap width). Meta lines (Version, Effective
// date, Licensor, Contact) are short standalone lines that must NOT be joined; the
// longest of them (Licensor, 57) sits well below any wrapped body line (>=72), so 65
// separates them cleanly. Sub-item and section-body continuations are detected by
// indentation instead and don't rely on this threshold.
const JOIN_THRESHOLD = 65;

const isHeader = (l) => /^\d+\.\s/.test(l); // "1. DEFINITIONS", "10. LIMITATION …"
const isSubItem = (l) => /^\s+\d+\.\d+\s/.test(l); // "   1.1 …", "   12.1 …"

/** @type {{type:string, text:string}[]} */
const blocks = [];
let current = null;
let prevLen = 0;
const flush = () => {
  if (current) blocks.push(current);
  current = null;
};

for (const raw of txt.split('\n')) {
  if (raw.trim() === '') {
    flush();
    prevLen = 0;
    continue;
  }
  const trimmed = raw.trim();
  if (isHeader(raw)) {
    flush();
    current = { type: 'header', text: trimmed };
  } else if (isSubItem(raw)) {
    flush();
    current = { type: 'subitem', text: trimmed };
  } else if (/^\s/.test(raw) && current && current.type === 'header') {
    // Indented body directly under a section header (sections 3–11 are prose, not "N.N"
    // sub-items) → start a new body paragraph, not part of the header.
    flush();
    current = { type: 'para', text: trimmed };
  } else if (/^\s/.test(raw) && current) {
    // Indented continuation of the current sub-item or body paragraph.
    current.text += ' ' + trimmed;
  } else if (current && prevLen >= JOIN_THRESHOLD) {
    // Col-0 wrapped continuation of a body paragraph.
    current.text += ' ' + trimmed;
  } else {
    flush();
    current = { type: blocks.length === 0 ? 'title' : 'para', text: trimmed };
  }
  prevLen = raw.replace(/\s+$/, '').length;
}
flush();

// The bundler's plain-text branch does not \uN-escape, and WiX reads the RTF as cp1252,
// so keep the payload ASCII (only the title's em-dash is non-ASCII in this document).
const toAscii = (s) =>
  s
    .replace(/[–—]/g, '-') // en/em dash
    .replace(/[‘’]/g, "'") // curly single quotes
    .replace(/[“”]/g, '"') // curly double quotes
    .replace(/…/g, '...'); // ellipsis

// One line per paragraph, no blank lines — the bundler template already puts vertical
// space (\sa200) after every paragraph, so blank lines would double the gaps.
const out = blocks.map((b) => toAscii(b.text)).join('\n') + '\n';
writeFileSync(join(root, 'legal', 'EULA-installer.txt'), out);
console.log(`[gen-eula-rtf] wrote legal/EULA-installer.txt (${blocks.length} paragraphs, ${out.length} bytes)`);
