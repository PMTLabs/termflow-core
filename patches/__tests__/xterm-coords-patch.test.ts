/**
 * Pins the xterm pointer-coordinate patch.
 *
 * Three separate things can break here and they fail in different ways, so each has its own
 * assertion:
 *
 *  1. THE ARITHMETIC. Exercised by compiling the patched helper out of a verbatim copy of the
 *     shipped minified source and calling it with a fake element/event. This is the only place
 *     the maths is testable at all — the renderer suite mocks xterm wholesale, so a patch to
 *     `node_modules` is invisible to it.
 *  2. THE SHAPE. `@xterm/xterm` ships minified; an upgrade can reminify the helper and silently
 *     stop matching. The patch script throws in that case, and the tripwire below asserts the
 *     bundles currently on disk are in a state it recognises.
 *  3. THE WIRING. A correct patch that nothing runs is worth nothing, and its absence is
 *     invisible: canvas clicks just quietly land on the wrong row again. Asserted against
 *     `package.json`'s `postinstall` rather than against `node_modules`, so the test does not
 *     depend on whether this particular checkout has been installed since the patch landed.
 */

const fs = require('fs');
const path = require('path');
const { applyPatch, MARKER, TARGETS } = require('../xterm-coords-patch');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * The pristine helper, copied VERBATIM from each shipped bundle. Two copies because the two
 * bundles are minified separately: `xterm.mjs` emits `let` and names its locals `i,r,n,o`,
 * `xterm.js` emits `const` and names them `s,r,n,o` — and the CJS one gives the function and
 * its third parameter the same name, which the patch must not disturb.
 *
 * Parameter order in both: (window, event, element).
 */
const PRISTINE_MJS =
  'function Ci(s,t,e){let i=e.getBoundingClientRect(),r=s.getComputedStyle(e),' +
  'n=parseInt(r.getPropertyValue("padding-left")),o=parseInt(r.getPropertyValue("padding-top"));' +
  'return[t.clientX-i.left-n,t.clientY-i.top-o]}';

const PRISTINE_CJS =
  'function i(e,t,i){const s=i.getBoundingClientRect(),r=e.getComputedStyle(i),' +
  'n=parseInt(r.getPropertyValue("padding-left")),o=parseInt(r.getPropertyValue("padding-top"));' +
  'return[t.clientX-s.left-n,t.clientY-s.top-o]}';

/** Compile a function-declaration string into a callable. */
function compile(fnText: string): (win: any, ev: any, el: any) => [number, number] {
  // eslint-disable-next-line no-new-func
  return new Function(`return (${fnText})`)();
}

/**
 * An element whose LAYOUT box is `layoutW x layoutH` and whose PAINTED box is that times
 * `scale` — i.e. exactly what an ancestor `transform: scale(scale)` produces. `offsetWidth` is
 * the layout box (transforms do not affect it); `getBoundingClientRect()` is the painted one.
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

describe('xterm coords patch — arithmetic', () => {
  const variants: [string, string][] = [['xterm.mjs', PRISTINE_MJS], ['xterm.js', PRISTINE_CJS]];

  it.each(variants)('%s: an untransformed element is left exactly as it was', (_name, pristine) => {
    const before = compile(pristine);
    const after = compile(applyPatch(pristine).source);
    const el = fakeElement(800, 600, 1);
    const win = fakeWindow(4, 2);
    const ev = { clientX: 317, clientY: 129 };

    expect(after(win, ev, el)).toEqual(before(win, ev, el));
    expect(after(win, ev, el)).toEqual([317 - 4, 129 - 2]);
  });

  it.each(variants)('%s: a scaled element divides the pointer delta by the scale', (_name, pristine) => {
    const after = compile(applyPatch(pristine).source);
    const el = fakeElement(800, 600, 0.5);
    const win = fakeWindow(0, 0);

    // A click 300 SCREEN px into a half-scale surface is 600 CSS px into the grid.
    expect(after(win, { clientX: 300, clientY: 150 }, el)).toEqual([600, 300]);

    // And the pristine helper is what got this wrong — kept as a positive control so the case
    // cannot silently start passing for the wrong reason.
    expect(compile(pristine)(win, { clientX: 300, clientY: 150 }, el)).toEqual([300, 150]);
  });

  it.each(variants)('%s: the element\'s own offset is removed before scaling', (_name, pristine) => {
    const after = compile(applyPatch(pristine).source);
    const el = fakeElement(800, 600, 0.5, 100, 40);
    const win = fakeWindow(0, 0);

    // 400 screen px, of which the first 100 are outside the element: 300 screen -> 600 CSS.
    expect(after(win, { clientX: 400, clientY: 190 }, el)).toEqual([600, 300]);
  });

  it.each(variants)('%s: padding is subtracted AFTER the division, not before', (_name, pristine) => {
    const after = compile(applyPatch(pristine).source);
    const el = fakeElement(800, 600, 0.5);
    const win = fakeWindow(10, 6);

    // The padding is an unscaled CSS length, so it belongs on the CSS side of the division.
    // Dividing the whole expression instead would give (300-10)/0.5 = 580 — the trap this
    // asserts against.
    expect(after(win, { clientX: 300, clientY: 150 }, el)).toEqual([600 - 10, 300 - 6]);
  });

  it.each(variants)('%s: sub-pixel rounding of offsetWidth is treated as no transform', (_name, pristine) => {
    const after = compile(applyPatch(pristine).source);
    // `offsetWidth` is an integer while the painted rect is fractional: an ordinary pane, not
    // a scaled one. Correcting here would move the far-right column by half a pixel for every
    // terminal in the app, so the patch must decline.
    const el = {
      offsetWidth: 801,
      offsetHeight: 600,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800.5, height: 599.6 }),
    };
    const win = fakeWindow(0, 0);
    expect(after(win, { clientX: 400, clientY: 300 }, el)).toEqual([400, 300]);
  });

  it.each(variants)('%s: a zero-sized (unrendered) element cannot divide by zero', (_name, pristine) => {
    const after = compile(applyPatch(pristine).source);
    const el = fakeElement(0, 0, 1);
    const win = fakeWindow(0, 0);
    expect(after(win, { clientX: 40, clientY: 20 }, el)).toEqual([40, 20]);
  });
});

describe('xterm coords patch — idempotency and failure', () => {
  it('reports an already-patched source instead of patching it twice', () => {
    const once = applyPatch(PRISTINE_MJS);
    expect(once.status).toBe('patched');
    expect(once.source).toContain(MARKER);

    const twice = applyPatch(once.source);
    expect(twice.status).toBe('already');
    expect(twice.source).toBe(once.source);
  });

  it('reports a source it does not recognise rather than corrupting it', () => {
    const garbage = 'function Ci(s,t,e){return[t.clientX,t.clientY]}';
    const result = applyPatch(garbage);
    expect(result.status).toBe('nomatch');
    expect(result.source).toBe(garbage);
  });
});

describe('xterm coords patch — the shipped bundles', () => {
  it.each(TARGETS)('%s is in a shape the patch recognises', (rel: string) => {
    const file = path.join(ROOT, rel);
    if (!fs.existsSync(file)) return; // no install in this checkout; nothing to assert
    const status = applyPatch(fs.readFileSync(file, 'utf8')).status;
    // 'patched' means this tree has run postinstall; 'already' means it ran earlier. Either is
    // fine. 'nomatch' means an upgrade reminified the helper and the patch is now a silent
    // no-op — which is exactly the failure this exists to catch.
    expect(status).not.toBe('nomatch');
  });
});

describe('xterm coords patch — wiring', () => {
  it('runs on postinstall', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    // A patch nothing runs is invisible: canvas clicks quietly go back to landing on the wrong
    // row, and every test above still passes.
    expect(pkg.scripts.postinstall).toContain('xterm-coords-patch.js');
  });
});
