// Patch @xterm/xterm + @xterm/addon-webgl to raise the SGR-dim (faint, ESC[2m)
// opacity factor from xterm's hardcoded 0.5 to NEW_FACTOR (currently 0.70).
//
// WHY: xterm renders dim/faint text as `foreground * f + background * (1 - f)`
// with f hardcoded at 0.5 — a fixed 50% blend toward the background. On dark
// schemes that leaves secondary CLI text (subtitles, paths, model/effort lines,
// timestamps — anything a tool prints with chalk.dim()) sitting around
// 4.2-4.8:1 contrast, which reads as too faint. The factor is not exposed as a
// Terminal option in xterm v6, and the only global knob that could brighten it
// (minimumContrastRatio) is halved for dim cells AND desaturates every color it
// touches (see docs/guides/001-terminal-color-contrast.md). Raising the factor
// itself is the only fix that brightens dim text WITHOUT affecting any color.
//
// This edits the (minified) published bundles in node_modules, so it must be
// re-run after any `@xterm/xterm`/`@xterm/addon-webgl` upgrade or a clean
// reinstall — it is wired to `postinstall`. It is idempotent and, importantly,
// re-runnable from an already-patched state: each token matches ANY current
// decimal factor (.5 pristine, or a prior .68/.70) and normalizes it to
// NEW_FACTOR, so bumping the value is just an edit + re-run. It fails loudly if
// the expected tokens are missing (e.g. a version bump that reminified).

const fs = require('fs');
const path = require('path');

const NEW_FACTOR = '.70';

// Each target: the (only) dim-factor tokens in that bundle, matched with ANY
// decimal so a re-run from a prior value still normalizes to NEW_FACTOR.
// `count` is how many the bundle must contain, so a version bump that changes
// the shape trips the assertion instead of silently mis-patching.
const targets = [
  {
    // DOM/canvas renderer: runtime dim blend + precomputed half-bright fg/ANSI
    // colors. All three multiplyOpacity(x, <f>) calls in this bundle are dim.
    file: 'node_modules/@xterm/xterm/lib/xterm.mjs',
    re: /(multiplyOpacity\([^)]*?,)\.\d+(\))/g, sub: `$1${NEW_FACTOR}$2`, count: 3,
  },
  {
    file: 'node_modules/@xterm/xterm/lib/xterm.js',
    re: /(multiplyOpacity\([^)]*?,)\.\d+(\))/g, sub: `$1${NEW_FACTOR}$2`, count: 3,
  },
  {
    // WebGL addon (loaded by default), minified: bare `var gn=<f>` dim factor.
    file: 'node_modules/@xterm/addon-webgl/lib/addon-webgl.mjs',
    re: /(var gn=)\.\d+/g, sub: `$1${NEW_FACTOR}`, count: 1,
  },
  {
    // WebGL addon, CJS build: the named DIM_OPACITY constant.
    file: 'node_modules/@xterm/addon-webgl/lib/addon-webgl.js',
    re: /(DIM_OPACITY=)\.\d+/g, sub: `$1${NEW_FACTOR}`, count: 1,
  },
];

let hadError = false;

for (const { file, re, sub, count } of targets) {
  const abs = path.join(__dirname, '..', file);
  if (!fs.existsSync(abs)) {
    console.warn(`xterm-dim-patch: SKIP (not found) ${file}`);
    continue;
  }
  const content = fs.readFileSync(abs, 'utf8');
  const matches = content.match(re);
  const found = matches ? matches.length : 0;

  if (found === 0) {
    console.error(
      `xterm-dim-patch: ERROR no dim-factor token found in ${file} — the @xterm ` +
      `bundle shape changed (version bump?); update the token patterns in this patch.`,
    );
    hadError = true;
    continue;
  }
  if (found !== count) {
    console.error(
      `xterm-dim-patch: ERROR expected ${count} dim token(s) in ${file} but found ` +
      `${found} — refusing to patch a bundle that doesn't match; re-verify the tokens.`,
    );
    hadError = true;
    continue;
  }

  const out = content.replace(re, sub);
  if (out === content) {
    console.log(`xterm-dim-patch: already at ${NEW_FACTOR} in ${file}`);
  } else {
    fs.writeFileSync(abs, out, 'utf8');
    console.log(`xterm-dim-patch: set ${found} dim factor(s) -> ${NEW_FACTOR} in ${file}`);
  }
}

if (hadError) {
  process.exitCode = 1;
  console.error('xterm-dim-patch: completed WITH ERRORS (see above).');
} else {
  console.log('xterm-dim-patch: done.');
}
