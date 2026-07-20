// Generate legal/EULA.rtf (the installer license-agreement page) from legal/EULA.txt,
// so the RTF never drifts from the canonical text. Run after editing EULA.txt:
//   node scripts/gen-eula-rtf.mjs
//
// Why the reflow: EULA.txt is hard-wrapped at ~80 columns for readability as a text
// file. Tauri's WiX bundler passes a `.rtf` license through VERBATIM (tauri-bundler
// msi/mod.rs: `if license.ends_with(".rtf") { use it as-is }`), and WiX renders it in
// a Win32 RichEdit control that does its OWN word-wrapping to the dialog width. So each
// logical paragraph must be a SINGLE run of text ending in one `\par` — if we emitted
// one `\par` per physical source line (the old behavior), every wrapped line became its
// own paragraph and the dialog broke sentences mid-line. We therefore un-wrap the source
// back into flowing paragraphs, then let RichEdit re-wrap it.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();
const txt = readFileSync(join(root, 'legal', 'EULA.txt'), 'utf8').replace(/\r\n/g, '\n');

// RTF escaping: backslash and braces are control chars; non-ASCII (em-dash, curly
// quotes, …) → `\uN?` so RichEdit renders them instead of mojibake.
const escapeRtf = (s) =>
  s
    .replace(/[\\{}]/g, (m) => '\\' + m)
    .replace(/[-￿]/g, (c) => `\\u${c.charCodeAt(0)}?`);

// A physical source line is a wrapped continuation of the paragraph above it only when
// that paragraph line was "full" (near the ~80-col wrap width). Meta lines (Version,
// Effective date, Licensor, Contact) are short standalone lines that must NOT be joined;
// the longest of them (Licensor, 57) sits well below any wrapped body line (>=72), so 65
// separates them cleanly. Sub-item continuations are detected by indentation instead and
// don't rely on this threshold.
const JOIN_THRESHOLD = 65;

const isHeader = (l) => /^\d+\.\s/.test(l); // "1. DEFINITIONS", "10. LIMITATION …"
const isSubItem = (l) => /^\s+\d+\.\d+\s/.test(l); // "   1.1 …", "   12.1 …"

/** @type {{type:'title'|'para'|'header'|'subitem', text:string}[]} */
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
    // Indented body text directly under a section header (sections 3–11 have prose
    // bodies with no "N.N" numbering) → start a new body paragraph, not part of the
    // bold header.
    flush();
    current = { type: 'para', text: trimmed };
  } else if (/^\s/.test(raw) && current) {
    // Indented, non-sub-item line → wrapped continuation of the current sub-item or
    // body paragraph.
    current.text += ' ' + trimmed;
  } else if (current && prevLen >= JOIN_THRESHOLD) {
    // Col-0 line following a "full" line → wrapped continuation of a body paragraph.
    current.text += ' ' + trimmed;
  } else {
    flush();
    current = { type: blocks.length === 0 ? 'title' : 'para', text: trimmed };
  }
  prevLen = raw.replace(/\s+$/, '').length;
}
flush();

// Paragraph shapes (twips: 1pt = 20 twips). Body 9pt (\fs18); title 13pt bold; section
// headers bold with space above; sub-items use a hanging indent so wrapped lines align
// past the "N.N" label.
const emit = (b) => {
  const t = escapeRtf(b.text);
  switch (b.type) {
    case 'title':
      return `\\pard\\qc\\sa160 {\\b\\fs26 ${t}}\\par`;
    case 'header':
      return `\\pard\\sb160\\sa80 {\\b ${t}}\\par`;
    case 'subitem':
      return `\\pard\\sa100\\li360\\fi-360 ${t}\\par`;
    default:
      return `\\pard\\sa120 ${t}\\par`;
  }
};

const body = blocks.map(emit).join('\n');
const rtf = `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Segoe UI;}}\n\\fs18\n${body}\n}\n`;
writeFileSync(join(root, 'legal', 'EULA.rtf'), rtf);
console.log(`[gen-eula-rtf] wrote legal/EULA.rtf (${blocks.length} paragraphs, ${rtf.length} bytes)`);
