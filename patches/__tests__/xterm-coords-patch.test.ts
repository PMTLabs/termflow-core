/**
 * Pins the xterm pointer-arithmetic patch.
 *
 * Four things can break here and they fail in different ways, so each has its own assertion:
 *
 *  1. THE ARITHMETIC, per edit. Exercised by compiling the patched helper out of a verbatim
 *     copy of the shipped minified source and calling it with a fake element/event. This is the
 *     only place the maths is testable at all — the renderer suite mocks xterm wholesale, so a
 *     patch to `node_modules` is invisible to it.
 *  2. THE SHAPE. `@xterm/xterm` ships minified; an upgrade can reminify a helper and silently
 *     stop matching, or emit it twice so only the first copy is rewritten. Both are their own
 *     status and their own loud failure.
 *  3. THE DISK STATE. The bundle actually on disk must already be patched — see the reasoning
 *     on that test; "patchable" was the assertion this started with and it was worth nothing.
 *  4. THE WIRING. A correct patch that nothing runs is invisible: canvas clicks just quietly go
 *     back to landing on the wrong row.
 */

const fs = require('fs');
const path = require('path');
const { applyPatch, applyEdit, EDITS, TARGETS } = require('../xterm-coords-patch');

const ROOT = path.resolve(__dirname, '..', '..');

const [COORDS_EDIT, TEXTAREA_EDIT] = EDITS;

/**
 * The pristine helpers, copied VERBATIM from each shipped bundle. Two copies of each because
 * the bundles are minified separately: `xterm.mjs` emits `let` and `xterm.js` emits `const`,
 * and the CJS one gives a function and one of its own locals the same name — which the patch
 * must not disturb.
 *
 * Parameter order: `getCoordsRelativeToElement(window, event, element)` and
 * `moveTextAreaUnderMouseCursor(event, textarea, element)`.
 */
const COORDS_MJS =
  'function Ci(s,t,e){let i=e.getBoundingClientRect(),r=s.getComputedStyle(e),' +
  'n=parseInt(r.getPropertyValue("padding-left")),o=parseInt(r.getPropertyValue("padding-top"));' +
  'return[t.clientX-i.left-n,t.clientY-i.top-o]}';

const COORDS_CJS =
  'function i(e,t,i){const s=i.getBoundingClientRect(),r=e.getComputedStyle(i),' +
  'n=parseInt(r.getPropertyValue("padding-left")),o=parseInt(r.getPropertyValue("padding-top"));' +
  'return[t.clientX-s.left-n,t.clientY-s.top-o]}';

const TEXTAREA_MJS =
  'function Mn(s,t,e){let i=e.getBoundingClientRect(),r=s.clientX-i.left-10,' +
  'n=s.clientY-i.top-10;t.style.width="20px",t.style.height="20px",t.style.left=`${r}px`,' +
  't.style.top=`${n}px`,t.style.zIndex="1000",t.focus()}';

const TEXTAREA_CJS =
  'function n(e,t,i){const s=i.getBoundingClientRect(),r=e.clientX-s.left-10,' +
  'n=e.clientY-s.top-10;t.style.width="20px",t.style.height="20px",t.style.left=`${r}px`,' +
  't.style.top=`${n}px`,t.style.zIndex="1000",t.focus()}';

/** Compile a function-declaration string into a callable. */
function compile(fnText: string): (...args: any[]) => any {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${fnText})`)();
}

/**
 * An element whose LAYOUT box is `layoutW x layoutH` and whose PAINTED box is that times
 * `scale` — exactly what an ancestor `transform: scale(scale)` produces. `offsetWidth` is the
 * layout box (transforms do not affect it); `getBoundingClientRect()` is the painted one.
 */
function fakeElement(layoutW: number, layoutH: number, scale: number, left = 0, top = 0) {
  return {
    offsetWidth: layoutW,
    offsetHeight: layoutH,
    getBoundingClientRect: () => ({
      left, top, width: layoutW * scale, height: layoutH * scale,
    }),
  };
}

function fakeWindow(padLeft: number, padTop: number) {
  return {
    getComputedStyle: () => ({
      getPropertyValue: (prop: string) => (prop === 'padding-left' ? `${padLeft}px` : `${padTop}px`),
    }),
  };
}

/** A stand-in for xterm's hidden helper textarea. */
function fakeTextarea() {
  return { style: {} as Record<string, string>, focus: () => {} };
}

const coordsVariants: [string, string][] = [['xterm.mjs', COORDS_MJS], ['xterm.js', COORDS_CJS]];
const textareaVariants: [string, string][] = [['xterm.mjs', TEXTAREA_MJS], ['xterm.js', TEXTAREA_CJS]];

const patchCoords = (src: string) => compile(applyEdit(COORDS_EDIT, src).source);
const patchTextarea = (src: string) => compile(applyEdit(TEXTAREA_EDIT, src).source);

describe('getCoordsRelativeToElement — arithmetic', () => {
  it.each(coordsVariants)('%s: an untransformed element is left exactly as it was', (_n, pristine) => {
    const before = compile(pristine);
    const after = patchCoords(pristine);
    const el = fakeElement(800, 600, 1);
    const win = fakeWindow(4, 2);
    const ev = { clientX: 317, clientY: 129 };

    expect(after(win, ev, el)).toEqual(before(win, ev, el));
    expect(after(win, ev, el)).toEqual([317 - 4, 129 - 2]);
  });

  it.each(coordsVariants)('%s: a scaled element divides the pointer delta by the scale', (_n, pristine) => {
    const after = patchCoords(pristine);
    const el = fakeElement(800, 600, 0.5);
    const win = fakeWindow(0, 0);

    // A click 300 SCREEN px into a half-scale surface is 600 CSS px into the grid.
    expect(after(win, { clientX: 300, clientY: 150 }, el)).toEqual([600, 300]);

    // And the pristine helper is what got this wrong — kept as a positive control so the case
    // cannot silently start passing for the wrong reason.
    expect(compile(pristine)(win, { clientX: 300, clientY: 150 }, el)).toEqual([300, 150]);
  });

  it.each(coordsVariants)('%s: the element\'s own offset is removed before scaling', (_n, pristine) => {
    const after = patchCoords(pristine);
    const el = fakeElement(800, 600, 0.5, 100, 40);
    const win = fakeWindow(0, 0);

    // 400 screen px, of which the first 100 are outside the element: 300 screen -> 600 CSS.
    expect(after(win, { clientX: 400, clientY: 190 }, el)).toEqual([600, 300]);
  });

  it.each(coordsVariants)('%s: padding is subtracted AFTER the division, not before', (_n, pristine) => {
    const after = patchCoords(pristine);
    const el = fakeElement(800, 600, 0.5);
    const win = fakeWindow(10, 6);

    // The padding is an unscaled CSS length, so it belongs on the CSS side of the division.
    // Dividing the whole expression instead would give (300-10)/0.5 = 580 — the trap this
    // asserts against.
    expect(after(win, { clientX: 300, clientY: 150 }, el)).toEqual([600 - 10, 300 - 6]);
  });

  it.each(coordsVariants)('%s: sub-pixel rounding of offsetWidth is treated as no transform', (_n, pristine) => {
    const after = patchCoords(pristine);
    // `offsetWidth` is an integer while the painted rect is fractional: an ordinary pane, not
    // a scaled one. Correcting here would move the far-right column by half a pixel for every
    // terminal in the app, so the patch must decline.
    const el = {
      offsetWidth: 801,
      offsetHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800.5, height: 599.6 }),
    };
    expect(after(fakeWindow(0, 0), { clientX: 400, clientY: 300 }, el)).toEqual([400, 300]);
  });

  it.each(coordsVariants)('%s: a zero-sized (unrendered) element cannot divide by zero', (_n, pristine) => {
    const after = patchCoords(pristine);
    expect(after(fakeWindow(0, 0), { clientX: 40, clientY: 20 }, fakeElement(0, 0, 1)))
      .toEqual([40, 20]);
  });
});

/**
 * The second instance of the same defect.
 *
 * xterm parks a 20x20 hidden native textarea under the pointer on right-click so the OS context
 * menu can copy from it. TermFlow never lets that menu open, so the textarea is pure collateral
 * — but placed with unscaled arithmetic it lands far from the pointer, on top of live glyphs at
 * `z-index: 1000`, and a later left-click inside those 20x20 px hits the textarea instead of
 * the screen: a selection drag started there never begins.
 */
describe('moveTextAreaUnderMouseCursor — arithmetic', () => {
  it.each(textareaVariants)('%s: an untransformed element is left exactly as it was', (_n, pristine) => {
    const before = compile(pristine);
    const after = patchTextarea(pristine);
    const el = fakeElement(800, 600, 1);
    const ev = { clientX: 317, clientY: 129 };

    const a = fakeTextarea();
    const b = fakeTextarea();
    before(ev, a, el);
    after(ev, b, el);
    expect(b.style).toEqual(a.style);
    expect(b.style.left).toBe('307px');
    expect(b.style.top).toBe('119px');
  });

  it.each(textareaVariants)('%s: a scaled element places the textarea under the pointer', (_n, pristine) => {
    const el = fakeElement(1400, 800, 0.5);
    const ev = { clientX: 650, clientY: 300 };

    const patched = fakeTextarea();
    patchTextarea(pristine)(ev, patched, el);
    // 650 screen px into a half-scale surface is 1300 CSS px, less the 10px half-box.
    expect(patched.style.left).toBe('1290px');
    expect(patched.style.top).toBe('590px');

    // The positive control: pristine put it at 640px, 650 CSS px adrift — the dead zone.
    const stock = fakeTextarea();
    compile(pristine)(ev, stock, el);
    expect(stock.style.left).toBe('640px');
  });

  it.each(textareaVariants)('%s: the 10px half-box is subtracted after the division', (_n, pristine) => {
    // Same trap as the padding above: 10 is an unscaled CSS length (half of the 20x20 box), so
    // dividing the whole expression would give (400-10)/0.5 = 780 rather than 790.
    const el = fakeElement(1000, 800, 0.5);
    const t = fakeTextarea();
    patchTextarea(pristine)({ clientX: 400, clientY: 200 }, t, el);
    expect(t.style.left).toBe('790px');
    expect(t.style.top).toBe('390px');
  });

  it.each(textareaVariants)('%s: leaves the rest of the helper alone', (_n, pristine) => {
    const el = fakeElement(800, 600, 0.5);
    const t = fakeTextarea();
    patchTextarea(pristine)({ clientX: 100, clientY: 100 }, t, el);
    expect(t.style.width).toBe('20px');
    expect(t.style.height).toBe('20px');
    expect(t.style.zIndex).toBe('1000');
  });
});

describe('idempotency and failure', () => {
  const BOTH_MJS = `${COORDS_MJS}\n${TEXTAREA_MJS}`;

  it('reports an already-patched source instead of patching it twice', () => {
    const once = applyPatch(BOTH_MJS);
    expect(once.status).toBe('patched');
    expect(once.problems).toEqual([]);

    const twice = applyPatch(once.source);
    expect(twice.status).toBe('already');
    expect(twice.source).toBe(once.source);
  });

  it('detects a HALF-patched source rather than calling it done', () => {
    // The reason each edit carries its own marker. With one shared marker, a bundle where the
    // first edit applied and the second did not would report "already patched" forever, and no
    // re-run would ever finish the job.
    const half = applyEdit(COORDS_EDIT, BOTH_MJS).source;
    const result = applyPatch(half);
    expect(result.status).toBe('patched');
    expect(result.source).toContain('__tfmx');
  });

  it('reports a source it does not recognise rather than corrupting it', () => {
    const garbage = 'function Ci(s,t,e){return[t.clientX,t.clientY]}';
    const result = applyPatch(garbage);
    expect(result.status).toBe('nomatch');
    expect(result.source).toBe(garbage);
    expect(result.problems.map((p: { name: string }) => p.name))
      .toEqual(['getCoordsRelativeToElement', 'moveTextAreaUnderMouseCursor']);
  });

  it('refuses a source with more than one match rather than half-patching it', () => {
    // `String.replace` with a non-global pattern rewrites only the FIRST match, so a bundle
    // that grew a second copy of a helper would come out with some pointer paths corrected and
    // some not — worse than either extreme, and invisible from outside.
    const twice = `${COORDS_MJS}\n${COORDS_CJS}\n${TEXTAREA_MJS}`;
    const result = applyPatch(twice);
    expect(result.status).toBe('ambiguous');
    expect(result.source).toBe(twice);
    expect(result.problems.map((p: { name: string }) => p.name))
      .toEqual(['getCoordsRelativeToElement']);
  });

  it('leaves the source untouched when ANY edit fails', () => {
    // All-or-nothing: a bundle must never be left with half its pointer paths corrected.
    const coordsOnly = COORDS_MJS;
    const result = applyPatch(coordsOnly);
    expect(result.status).toBe('nomatch');
    expect(result.source).toBe(coordsOnly);
    expect(result.source).not.toContain('__tfsx');
  });
});

describe('the shipped bundles', () => {
  /**
   * The bundle ON DISK must already be patched — not merely patchABLE.
   *
   * "Patchable" is the assertion this started with, and it was worth almost nothing: it reads
   * the file, patches it IN MEMORY, and passes. A tree where postinstall never ran, or ran and
   * failed, sails through it while every canvas click lands on the wrong row.
   *
   * That is not hypothetical. `postinstall` chains two scripts, and the sibling
   * `xterm-dim-patch.js` reports failure by setting `process.exitCode = 1` rather than
   * throwing — so if it ran first and hit a bundle it did not recognise, the shell would
   * short-circuit and this patch would never execute. The scripts are ordered so that cannot
   * happen, but ordering is a convention and this is the check that does not depend on it.
   *
   * Safe to assert against disk: every CI job runs `bun install --frozen-lockfile` with no
   * `node_modules` cache, so postinstall always runs.
   */
  /**
   * At least one bundle must be WHERE WE LOOK FOR IT.
   *
   * The per-target case below tolerates a missing file, because a build may ship only one
   * module format — but that tolerance is also a hole: if `@xterm/xterm` were hoisted above
   * this package, every target would be missing, each per-target case would return early and
   * pass, and the app would ship pristine pointer arithmetic with a green suite. Safe to
   * assert unconditionally: jest itself lives in `node_modules`, so if this test is running at
   * all, `node_modules` exists.
   */
  it('finds the bundles where the patch looks for them', () => {
    const present = TARGETS.filter((rel: string) => fs.existsSync(path.join(ROOT, rel)));
    expect(present.length).toBeGreaterThan(0);
  });

  it.each(TARGETS)('%s is patched on disk, not merely patchable', (rel: string) => {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) return; // this format not shipped; the case above covers "none"
    const source = fs.readFileSync(file, 'utf8');

    // 'already' is the ONLY passing state: postinstall has run and every marker is in the file.
    // 'patched' means the bundle is pristine and postinstall did not run — run `bun install`.
    // 'nomatch' means an upgrade reminified a helper; 'ambiguous' means one appears twice.
    expect(applyPatch(source).status).toBe('already');
    for (const edit of EDITS) expect(source).toContain(edit.marker);
  });
});

describe('wiring', () => {
  it('runs on postinstall, before the patch that cannot fail loudly', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const postinstall: string = pkg.scripts.postinstall;
    // A patch nothing runs is invisible: canvas clicks quietly go back to landing on the wrong
    // row, and every test above still passes.
    expect(postinstall).toContain('xterm-coords-patch.js');
    // And it must run FIRST. `xterm-dim-patch.js` signals failure with `process.exitCode = 1`
    // rather than throwing, so with `&&` chaining a dim failure would silently prevent this
    // patch from running at all. Ordered this way, a failure here throws and stops the install,
    // and a dim failure can no longer suppress it.
    expect(postinstall.indexOf('xterm-coords-patch.js'))
      .toBeLessThan(postinstall.indexOf('xterm-dim-patch.js'));
  });
});
