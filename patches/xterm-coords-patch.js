// Patch @xterm/xterm so pointer -> cell mapping accounts for a CSS transform on an
// ANCESTOR of the terminal element.
//
// WHY: xterm converts a pointer event to a cell with
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
// Fixing it here rather than per-surface is deliberate: this helper is the single place xterm
// turns a pointer into a coordinate, so selection, selection DRAG, mouse reporting to
// full-screen TUIs and link hovering are all corrected at once.
//
// The correction is `rect.width / element.offsetWidth` — `offsetWidth` is the LAYOUT box and
// is not affected by transforms, so their ratio is exactly the accumulated scale. It is
// applied only when the two differ by more than a pixel, so an ordinary untransformed pane
// keeps byte-identical behaviour and cannot be perturbed by `offsetWidth`'s integer rounding.
//
// Like `xterm-dim-patch.js` this edits the published bundles in node_modules, so it must be
// re-run after any `@xterm/xterm` upgrade or a clean reinstall — it is wired to `postinstall`.
// It is idempotent (an already-patched bundle is detected by the injected `__tfsx` marker and
// left alone) and fails loudly if a bundle matches neither the pristine nor the patched shape,
// which is what a reminified upgrade looks like.

const fs = require('fs');
const path = require('path');

/** Injected local for the horizontal scale. Doubles as the idempotency marker — grep-able, and
 *  impossible to collide with anything the minifier produces. */
const MARKER = '__tfsx';
/** ...and the vertical one. Named in full rather than derived from `MARKER`, so the identifier
 *  a maintainer greps for in the bundle is the identifier written here. */
const MARKER_Y = '__tfsy';

/**
 * The pristine helper, in both bundles. `xterm.mjs` emits `let`, `xterm.js` emits `const`, and
 * the minifier picks different single-letter names in each — so every identifier is captured
 * and written back rather than assumed.
 *
 * Capture groups:
 *   1 declaration keyword   2 rect   3 element   4 computed style
 *   5 window                6 padding-left   7 padding-top   8 event
 */
const PRISTINE = new RegExp(
  '\\{(let|const) (\\w+)=(\\w+)\\.getBoundingClientRect\\(\\),' +
  '(\\w+)=(\\w+)\\.getComputedStyle\\(\\3\\),' +
  '(\\w+)=parseInt\\(\\4\\.getPropertyValue\\("padding-left"\\)\\),' +
  '(\\w+)=parseInt\\(\\4\\.getPropertyValue\\("padding-top"\\)\\);' +
  'return\\[(\\w+)\\.clientX-\\2\\.left-\\6,\\8\\.clientY-\\2\\.top-\\7\\]\\}',
);

/** The same pattern, global, purely to COUNT matches — see the ambiguity check below. Built
 *  from `PRISTINE.source` so the two can never drift apart. */
const PRISTINE_ALL = new RegExp(PRISTINE.source, 'g');

/**
 * Rewrite one bundle's source. Pure — takes and returns a string — so the test can exercise
 * the arithmetic on a fixture without a node_modules tree.
 *
 * Returns `{ source, status }` where status is 'patched' | 'already' | 'nomatch' | 'ambiguous'.
 */
function applyPatch(source) {
  if (source.includes(MARKER)) return { source, status: 'already' };

  // Exactly one occurrence, asserted the way `xterm-dim-patch.js` asserts its own `count`.
  // `String.replace` with a non-global pattern rewrites only the FIRST match, so a bundle that
  // grew a second copy of this helper would be half-patched — half the pointer paths corrected
  // and half not, which is worse than either extreme and invisible from the outside.
  const matches = source.match(PRISTINE_ALL);
  if (!matches) return { source, status: 'nomatch' };
  if (matches.length !== 1) return { source, status: 'ambiguous' };

  // The two scale factors are bound alongside the existing locals, so the injection stays a
  // single declaration list and the function body keeps its original shape.
  //
  // NOTE the ORDER in the return: the padding is in unscaled CSS pixels while
  // `clientX - rect.left` is in screen pixels, so the division must happen BEFORE the padding
  // is subtracted. Dividing the whole expression instead would scale the padding twice.
  const patched = source.replace(
    PRISTINE,
    (_m, decl, rect, el, style, win, padL, padT, ev) =>
      `{${decl} ${rect}=${el}.getBoundingClientRect(),` +
      `${style}=${win}.getComputedStyle(${el}),` +
      `${padL}=parseInt(${style}.getPropertyValue("padding-left")),` +
      `${padT}=parseInt(${style}.getPropertyValue("padding-top")),` +
      `${MARKER}=${el}.offsetWidth>0&&Math.abs(${rect}.width-${el}.offsetWidth)>1` +
      `?${rect}.width/${el}.offsetWidth:1,` +
      `${MARKER_Y}=${el}.offsetHeight>0&&Math.abs(${rect}.height-${el}.offsetHeight)>1` +
      `?${rect}.height/${el}.offsetHeight:1;` +
      `return[(${ev}.clientX-${rect}.left)/${MARKER}-${padL},` +
      `(${ev}.clientY-${rect}.top)/${MARKER_Y}-${padT}]}`,
  );
  return { source: patched, status: 'patched' };
}

const TARGETS = [
  'node_modules/@xterm/xterm/lib/xterm.mjs',
  'node_modules/@xterm/xterm/lib/xterm.js',
];

function main() {
  const root = path.resolve(__dirname, '..');
  let changed = 0;

  for (const rel of TARGETS) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file)) {
      // Not fatal on its own: a consumer may install without the CJS bundle. A bundle that is
      // PRESENT but unpatchable is fatal, below.
      console.warn(`[xterm-coords-patch] skipped (not found): ${rel}`);
      continue;
    }
    const src = fs.readFileSync(file, 'utf8');
    const { source, status } = applyPatch(src);

    if (status === 'nomatch') {
      throw new Error(
        `[xterm-coords-patch] ${rel} matches neither the pristine nor the patched shape of ` +
        `getCoordsRelativeToElement. @xterm/xterm was probably upgraded and reminified — ` +
        `re-derive the pattern before shipping, or canvas pointer input silently regresses.`,
      );
    }
    if (status === 'ambiguous') {
      throw new Error(
        `[xterm-coords-patch] ${rel} contains more than one match for ` +
        `getCoordsRelativeToElement. Only the first would be rewritten, leaving some pointer ` +
        `paths corrected and some not — re-derive the pattern before shipping.`,
      );
    }
    if (status === 'already') {
      console.log(`[xterm-coords-patch] already patched: ${rel}`);
      continue;
    }
    fs.writeFileSync(file, source);
    changed++;
    console.log(`[xterm-coords-patch] patched: ${rel}`);
  }

  console.log(`[xterm-coords-patch] done (${changed} file(s) rewritten)`);
}

module.exports = { applyPatch, PRISTINE, MARKER, MARKER_Y, TARGETS };

if (require.main === module) main();
