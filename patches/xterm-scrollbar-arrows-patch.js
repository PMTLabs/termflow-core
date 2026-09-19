// Patch @xterm/xterm so the terminal's vertical scrollbar gets ▲/▼ buttons at its ends
// (plan 046).
//
// WHY: xterm 6 replaced the native viewport scrollbar with VS Code's vendored
// `ScrollableElement`. That component fully supports end buttons — `verticalHasArrows` reserves
// `arrowSize` px at each end of the thumb's track and `ScrollbarArrow` gives each button a hit
// box, a glyph node (`.scra`), pointerdown → `onActivate()`, and press-and-hold auto-repeat
// (24 Hz after 200 ms). xterm keeps all of that code in the shipped bundle but hard-disables
// it: `VerticalScrollbar`'s constructor throws `"horizontalHasArrows is not supported in
// xterm.js"` (sic) when the option is set, and no `Terminal` option can set it anyway.
//
// Three edits, each independently anchored and marked:
//
//   E1 `viewport-options`  — the Viewport passes `verticalHasArrows:!0, arrowSize:14` (14 is
//      xterm's `DEFAULT_SCROLL_BAR_WIDTH`, so the buttons are square). This alone shortens the
//      thumb's travel by 14 px at each end — the state maths is xterm's own.
//   E2 `vertical-arrows`   — the throw becomes the two `_createArrow(...)` calls VS Code makes,
//      placed exactly as VS Code places them. Each button's `onActivate` dispatches a bubbling
//      `CustomEvent("xterm-scrollbar-arrow", { detail: -1 | 1 })` from the scrollbar node. The
//      patch owns PLACEMENT only; what a click does is decided in app code
//      (`packages/terminal-core/src/scrollbarArrows.ts` → `term.scrollLines(±1)`), where it is
//      testable and uses the public API — a click is exactly one row, not a wheel notch.
//   E3 `arrow-colour`      — the `<style>` the Viewport already injects for the thumb's colours
//      gains `.scra { color: <theme foreground> }`, so the arrows recolour on every
//      `onChangeColors` exactly when the thumb does (scheme switch, agent scheme override).
//      The glyph itself is drawn by app CSS in `currentColor` (TerminalDisplay.css): xterm
//      strips the codicon class VS Code would use, so an enabled button is an empty box.
//
// Like the sibling patches this edits the published bundles in node_modules, so it must be
// re-run after any `@xterm/xterm` upgrade or a clean reinstall — it is wired to `postinstall`.
// It is idempotent (each edit carries its own marker and is skipped once present) and fails
// loudly if an edit matches zero times or more than once, which is what a reminified upgrade
// looks like. All-or-nothing per bundle: E1 without E2 would throw at every terminal open, and
// E2 without E1 would be dead code, so a bundle is never left with a subset applied.

const fs = require('fs');
const path = require('path');

/** The DOM event the arrows emit; `packages/terminal-core/src/scrollbarArrows.ts` consumes it. */
const ARROW_EVENT = 'xterm-scrollbar-arrow';

/** `ScrollbarArrow.ARROW_IMG_SIZE` — the 11 px glyph node is baked into the vendored widget. */
const ARROW_IMG_SIZE = 11;

/**
 * The three edits. Every identifier is captured and written back rather than assumed: the
 * minifier picks different single-letter names in `xterm.mjs` and `xterm.js`. Locals introduced
 * by E2 are `__tf`-prefixed and live in their own block, so they cannot shadow the one-letter
 * locals the rest of that constructor still uses after the block.
 */
const EDITS = [
  {
    name: 'viewport-options',
    marker: 'verticalHasArrows:!0,arrowSize:14',
    // The Viewport's option literal for its SmoothScrollableElement. The two flags before the
    // spread are unique to this call site in both bundles.
    pattern: /useShadows:!1,mouseWheelSmoothScroll:!0,/,
    rewrite: () => 'useShadows:!1,mouseWheelSmoothScroll:!0,verticalHasArrows:!0,arrowSize:14,',
  },
  {
    name: 'vertical-arrows',
    marker: '__tfArrowFire',
    // Group 1: the resolved-options identifier. Anchored on `verticalHasArrows)throw` — the
    // HorizontalScrollbar's twin throw is anchored on `horizontalHasArrows)throw`, so this is the
    // vertical one and only the vertical one.
    pattern: /(\w+)\.verticalHasArrows\)throw new Error\("horizontalHasArrows is not supported in xterm\.js"\);/,
    rewrite: (_m, o) =>
      `${o}.verticalHasArrows){` +
      // VS Code's own geometry: the 11 px glyph centred in an arrowSize-tall, scrollbar-wide box.
      `const __tfArrowTop=(${o}.arrowSize-${ARROW_IMG_SIZE})/2,` +
      `__tfArrowLeft=(${o}.verticalScrollbarSize-${ARROW_IMG_SIZE})/2,` +
      `__tfArrowFire=__tfDir=>()=>this.domNode.domNode.dispatchEvent(` +
      `new CustomEvent("${ARROW_EVENT}",{bubbles:!0,detail:__tfDir}));` +
      `this._createArrow({className:"scra scra-up",top:__tfArrowTop,left:__tfArrowLeft,` +
      `bottom:void 0,right:void 0,bgWidth:${o}.verticalScrollbarSize,bgHeight:${o}.arrowSize,` +
      `onActivate:__tfArrowFire(-1)}),` +
      `this._createArrow({className:"scra scra-down",top:void 0,left:__tfArrowLeft,` +
      `bottom:__tfArrowTop,right:void 0,bgWidth:${o}.verticalScrollbarSize,bgHeight:${o}.arrowSize,` +
      `onActivate:__tfArrowFire(1)})}`,
  },
  {
    name: 'arrow-colour',
    marker: '> .scra {',
    // Group 1: the theme-service identifier. The last rule of the injected template, right
    // before the array is joined. `colors.foreground` is on the same object as the slider colours
    // (ThemeService derives those from it).
    pattern: /`  background: \$\{(\w+)\.colors\.scrollbarSliderActiveBackground\.css\};`,"\}"\]\.join\(/,
    rewrite: (_m, ts) =>
      `\`  background: \${${ts}.colors.scrollbarSliderActiveBackground.css};\`,"}",` +
      `".xterm .xterm-scrollable-element > .scrollbar > .scra {",` +
      `\`  color: \${${ts}.colors.foreground.css};\`,"}"].join(`,
  },
];

/**
 * Apply ONE edit to a source string. Pure, and exported so the test can exercise each edit
 * against a fixture of just that construct.
 *
 * Returns `{ source, status }` where status is 'patched' | 'already' | 'nomatch' | 'ambiguous'.
 */
function applyEdit(edit, source) {
  if (source.includes(edit.marker)) return { source, status: 'already' };

  // Exactly one occurrence. `String.replace` with a non-global pattern rewrites only the FIRST
  // match, so a bundle that grew a second copy would be half-patched and invisible from outside.
  const matches = source.match(new RegExp(edit.pattern.source, 'g'));
  if (!matches) return { source, status: 'nomatch' };
  if (matches.length !== 1) return { source, status: 'ambiguous' };

  return { source: source.replace(edit.pattern, edit.rewrite), status: 'patched' };
}

/**
 * Apply every edit to one bundle's source.
 *
 * All-or-nothing: if ANY edit cannot be applied cleanly the original source is returned
 * untouched (see the header for why a subset is worse than nothing).
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
      console.warn(`[xterm-scrollbar-arrows-patch] skipped (not found): ${rel}`);
      continue;
    }
    found++;
    const src = fs.readFileSync(file, 'utf8');
    const { source, status, problems } = applyPatch(src);

    if (problems.length > 0) {
      const detail = problems.map((p) => `${p.name} (${p.status})`).join(', ');
      throw new Error(
        `[xterm-scrollbar-arrows-patch] ${rel}: could not patch ${detail}. 'nomatch' means ` +
        `@xterm/xterm was upgraded and reminified; 'ambiguous' means the construct now appears ` +
        `more than once and only the first would be rewritten. Re-derive the pattern before ` +
        `shipping, or the scrollbar silently loses its arrow buttons.`,
      );
    }
    if (status === 'already') {
      console.log(`[xterm-scrollbar-arrows-patch] already patched: ${rel}`);
      continue;
    }

    // Written via a temp file and renamed, so a kill mid-write cannot leave a bundle that
    // CONTAINS a marker but is truncated — that state passes the idempotency check forever and
    // no re-run would ever repair it. `rename` within the same directory is atomic.
    const tmp = `${file}.tfpatch.tmp`;
    fs.writeFileSync(tmp, source);
    fs.renameSync(tmp, file);
    changed++;
    console.log(`[xterm-scrollbar-arrows-patch] patched: ${rel}`);
  }

  // Finding NO bundle at all is a silent no-op dressed as a success: the app builds, every test
  // passes, and the scrollbar quietly has no buttons. It happens if `@xterm/xterm` is ever
  // hoisted above this package or isolated in a nested `node_modules` — a layout change, not a
  // code change, so nothing else would flag it. Refuse to exit 0 having done nothing.
  if (found === 0) {
    throw new Error(
      `[xterm-scrollbar-arrows-patch] found none of the target bundles under ${root}. ` +
      `@xterm/xterm has probably moved (hoisted, or nested in another package's node_modules) ` +
      `— update TARGETS. Exiting successfully here would ship a scrollbar without its arrows ` +
      `with a green suite.`,
    );
  }

  console.log(`[xterm-scrollbar-arrows-patch] done (${changed} file(s) rewritten)`);
}

module.exports = { applyPatch, applyEdit, EDITS, TARGETS, ARROW_EVENT };

if (require.main === module) main();
