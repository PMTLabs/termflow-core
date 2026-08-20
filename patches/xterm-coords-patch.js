// Patch @xterm/xterm so pointer arithmetic accounts for a CSS transform on an ANCESTOR of the
// terminal element.
//
// WHY: xterm converts a pointer event to a position with
//
//     const rect = element.getBoundingClientRect();
//     return [event.clientX - rect.left - paddingLeft, event.clientY - rect.top - paddingTop];
//
// and the caller then divides by the CSS cell width/height. `getBoundingClientRect()`
// reports the element's box AFTER every ancestor transform, so under `transform: scale(s)`
// the left-hand side is in SCREEN pixels while the divisor is in unscaled CSS pixels. Every
// coordinate comes out too small by a factor of `s`, and the error grows with distance from
// the transform origin — so a click near the bottom of the grid selects a row several rows
// above the one under the pointer.
//
// TermFlow hits this in Canvas Mode, where a live terminal is relocated into a node whose
// `.canvas-surface` carries `transform: scale(--node-surface-scale)`. `plan/017` froze each
// canvas host to a replica of its own pane's box, which means the full-screen overlay can no
// longer guarantee scale 1 (`canvasGeometry.overlayGeometry` caps at 1 but a pane box larger
// than the viewport minus margins minus header lands below it), and a FOCUSED ordinary node
// accepts input at a scale far below 1. Both had unusable selection.
//
// There are TWO places in the bundle that do this arithmetic, and they are independent:
//
//   1. `getCoordsRelativeToElement` — the single helper behind selection, selection drag,
//      alt-click, mouse reporting to full-screen TUIs, and link hovering.
//   2. `moveTextAreaUnderMouseCursor` — parks xterm's 20x20 hidden native textarea under the
//      pointer on right-click, so the OS/WebView context menu can copy from it. TermFlow never
//      lets that native menu open (every surface calls `preventDefault`), so the textarea is
//      pure collateral — but a mispositioned one is an invisible 20x20 patch sitting ON TOP of
//      live glyphs at `z-index: 1000`, and a later left-click inside it hits the textarea
//      instead of the screen, so a selection drag started there never begins.
//
// Fixing them here rather than per-surface is deliberate: these are the only two places in
// xterm that turn a pointer into a position, and correcting them corrects every feature built
// on top at once.
//
// The correction is `rect.width / element.offsetWidth` — `offsetWidth` is the LAYOUT box and
// is not affected by transforms, so their ratio is exactly the accumulated scale. It is
// applied only when the two differ by more than a pixel, so an ordinary untransformed pane
// keeps byte-identical behaviour and cannot be perturbed by `offsetWidth`'s integer rounding.
// It is exact for pure scale+translate ancestors, which is all this codebase has; it would be
// wrong under `rotate`/`skew`, where `getBoundingClientRect()` returns an axis-aligned bbox.
//
// Like `xterm-dim-patch.js` this edits the published bundles in node_modules, so it must be
// re-run after any `@xterm/xterm` upgrade or a clean reinstall — it is wired to `postinstall`.
// It is idempotent (each edit carries its own marker and is skipped once present) and fails
// loudly if an edit matches zero times or more than once, which is what a reminified upgrade
// looks like.

const fs = require('fs');
const path = require('path');

/**
 * The two edits. Each carries its OWN marker, so a bundle where one applied and the other did
 * not is detected rather than reported "already patched" — a single shared marker would let a
 * half-patched file look finished forever.
 *
 * Every identifier is captured and written back rather than assumed: `xterm.mjs` emits `let`
 * and `xterm.js` emits `const`, and the minifier picks different single-letter names in each.
 */
const EDITS = [
  {
    name: 'getCoordsRelativeToElement',
    marker: '__tfsx',
    // Groups: 1 decl, 2 rect, 3 element, 4 computed style, 5 window, 6 padL, 7 padT, 8 event.
    pattern: new RegExp(
      '\\{(let|const) (\\w+)=(\\w+)\\.getBoundingClientRect\\(\\),' +
      '(\\w+)=(\\w+)\\.getComputedStyle\\(\\3\\),' +
      '(\\w+)=parseInt\\(\\4\\.getPropertyValue\\("padding-left"\\)\\),' +
      '(\\w+)=parseInt\\(\\4\\.getPropertyValue\\("padding-top"\\)\\);' +
      'return\\[(\\w+)\\.clientX-\\2\\.left-\\6,\\8\\.clientY-\\2\\.top-\\7\\]\\}',
    ),
    // NOTE the ORDER: the padding is in unscaled CSS pixels while `clientX - rect.left` is in
    // screen pixels, so the division must happen BEFORE the padding is subtracted. Dividing
    // the whole expression instead would scale the padding too.
    rewrite: (_m, decl, rect, el, style, win, padL, padT, ev) =>
      `{${decl} ${rect}=${el}.getBoundingClientRect(),` +
      `${style}=${win}.getComputedStyle(${el}),` +
      `${padL}=parseInt(${style}.getPropertyValue("padding-left")),` +
      `${padT}=parseInt(${style}.getPropertyValue("padding-top")),` +
      `${scaleX('__tfsx', rect, el)},${scaleY('__tfsy', rect, el)};` +
      `return[(${ev}.clientX-${rect}.left)/__tfsx-${padL},` +
      `(${ev}.clientY-${rect}.top)/__tfsy-${padT}]}`,
  },
  {
    name: 'moveTextAreaUnderMouseCursor',
    marker: '__tfmx',
    // Groups: 1 decl, 2 rect, 3 element, 4 leftVar, 5 event, 6 topVar.
    // The literal 10 is half the 20x20 box, i.e. an unscaled CSS length like the padding above,
    // so it is subtracted on the same side of the division.
    pattern: new RegExp(
      '\\{(let|const) (\\w+)=(\\w+)\\.getBoundingClientRect\\(\\),' +
      '(\\w+)=(\\w+)\\.clientX-\\2\\.left-10,' +
      '(\\w+)=\\5\\.clientY-\\2\\.top-10;',
    ),
    rewrite: (_m, decl, rect, el, leftVar, ev, topVar) =>
      `{${decl} ${rect}=${el}.getBoundingClientRect(),` +
      `${scaleX('__tfmx', rect, el)},${scaleY('__tfmy', rect, el)},` +
      `${leftVar}=(${ev}.clientX-${rect}.left)/__tfmx-10,` +
      `${topVar}=(${ev}.clientY-${rect}.top)/__tfmy-10;`,
  },
];

/** `name = <horizontal scale>`, or 1 when the element is untransformed or unrendered. */
function scaleX(name, rect, el) {
  return `${name}=${el}.offsetWidth>0&&Math.abs(${rect}.width-${el}.offsetWidth)>1`
    + `?${rect}.width/${el}.offsetWidth:1`;
}

/** `name = <vertical scale>`, same guards. */
function scaleY(name, rect, el) {
  return `${name}=${el}.offsetHeight>0&&Math.abs(${rect}.height-${el}.offsetHeight)>1`
    + `?${rect}.height/${el}.offsetHeight:1`;
}

/**
 * Apply ONE edit to a source string. Pure, and exported so the test can exercise each edit's
 * arithmetic against a fixture of just that helper.
 *
 * Returns `{ source, status }` where status is 'patched' | 'already' | 'nomatch' | 'ambiguous'.
 */
function applyEdit(edit, source) {
  if (source.includes(edit.marker)) return { source, status: 'already' };

  // Exactly one occurrence, asserted the way `xterm-dim-patch.js` asserts its own `count`.
  // `String.replace` with a non-global pattern rewrites only the FIRST match, so a bundle that
  // grew a second copy of a helper would be half-patched — some pointer paths corrected and
  // some not, which is worse than either extreme and invisible from the outside.
  const matches = source.match(new RegExp(edit.pattern.source, 'g'));
  if (!matches) return { source, status: 'nomatch' };
  if (matches.length !== 1) return { source, status: 'ambiguous' };

  return { source: source.replace(edit.pattern, edit.rewrite), status: 'patched' };
}

/**
 * Apply every edit to one bundle's source.
 *
 * All-or-nothing: if ANY edit cannot be applied cleanly the original source is returned
 * untouched, so a bundle is never left with half its pointer paths corrected.
 *
 * Returns `{ source, status, problems }`. `status` is 'patched' when at least one edit was
 * applied, 'already' when every edit was present, and otherwise the first problem's status;
 * `problems` names the offending edits for the error message.
 */
function applyPatch(source) {
  let out = source;
  let applied = 0;
  const problems = [];

  for (const edit of EDITS) {
    const result = applyEdit(edit, out);
    if (result.status === 'nomatch' || result.status === 'ambiguous') {
      problems.push({ name: edit.name, status: result.status });
      continue;
    }
    if (result.status === 'patched') applied++;
    out = result.source;
  }

  if (problems.length > 0) {
    return { source, status: problems[0].status, problems };
  }
  return { source: out, status: applied > 0 ? 'patched' : 'already', problems };
}

const TARGETS = [
  'node_modules/@xterm/xterm/lib/xterm.mjs',
  'node_modules/@xterm/xterm/lib/xterm.js',
];

function main() {
  const root = path.resolve(__dirname, '..');
  let changed = 0;
  let found = 0;

  for (const rel of TARGETS) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      // Not fatal on its own: a build may ship only one of the two module formats. Finding
      // NEITHER is fatal — see below.
      console.warn(`[xterm-coords-patch] skipped (not found): ${rel}`);
      continue;
    }
    found++;
    const src = fs.readFileSync(file, 'utf8');
    const { source, status, problems } = applyPatch(src);

    if (problems.length > 0) {
      const detail = problems.map((p) => `${p.name} (${p.status})`).join(', ');
      throw new Error(
        `[xterm-coords-patch] ${rel}: could not patch ${detail}. 'nomatch' means @xterm/xterm ` +
        `was upgraded and reminified; 'ambiguous' means the helper now appears more than once ` +
        `and only the first would be rewritten. Re-derive the pattern before shipping, or ` +
        `canvas pointer input silently regresses.`,
      );
    }
    if (status === 'already') {
      console.log(`[xterm-coords-patch] already patched: ${rel}`);
      continue;
    }

    // Written via a temp file and renamed, so a kill mid-write cannot leave a bundle that
    // CONTAINS a marker but is truncated — that state passes the idempotency check forever and
    // no re-run would ever repair it. `rename` within the same directory is atomic.
    const tmp = `${file}.tfpatch.tmp`;
    fs.writeFileSync(tmp, source);
    fs.renameSync(tmp, file);
    changed++;
    console.log(`[xterm-coords-patch] patched: ${rel}`);
  }

  // Finding NO bundle at all is a silent no-op dressed as a success, and it is the exact shape
  // of failure this patch is most vulnerable to: the app builds, every test passes, and canvas
  // clicks quietly land on the wrong row. It happens if `@xterm/xterm` is ever hoisted above
  // this package or isolated in a nested `node_modules` — a layout change, not a code change,
  // so nothing else would flag it. Warn per missing file, but refuse to exit 0 having done
  // nothing.
  if (found === 0) {
    throw new Error(
      `[xterm-coords-patch] found none of the target bundles under ${root}. @xterm/xterm has ` +
      `probably moved (hoisted, or nested in another package's node_modules) — update TARGETS. ` +
      `Exiting successfully here would ship unpatched pointer arithmetic with a green suite.`,
    );
  }

  console.log(`[xterm-coords-patch] done (${changed} file(s) rewritten)`);
}

module.exports = { applyPatch, applyEdit, EDITS, TARGETS };

if (require.main === module) main();
