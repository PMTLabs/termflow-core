/**
 * @jest-environment jsdom
 *
 * Pins the xterm scrollbar-arrows patch (plan 046).
 *
 * The same four failure shapes as the coords patch, each with its own assertion:
 *
 *  1. THE SEMANTICS, per edit. Each rewrite is compiled out of a verbatim copy of the shipped
 *     minified construct and executed against a fake `this`. This is the only place the patched
 *     code runs under test at all — the renderer suite mocks xterm wholesale.
 *  2. THE SHAPE. `@xterm/xterm` ships minified; an upgrade can reminify a construct and silently
 *     stop matching, or emit it twice so only the first copy is rewritten.
 *  3. THE DISK STATE. The bundle actually on disk must already be patched, not merely patchable.
 *  4. THE WIRING. A correct patch that nothing runs is invisible: the scrollbar simply has no
 *     buttons and every other test still passes.
 *
 * The event the arrows emit is consumed by `packages/terminal-core/src/scrollbarArrows.ts`; that
 * side is pinned by `engine.scrollbarArrows.test.ts`. The two share the event NAME through
 * `ARROW_EVENT` / `SCROLLBAR_ARROW_EVENT`, asserted equal below so the contract cannot drift.
 */

const fs = require('fs');
const path = require('path');
const { applyPatch, applyEdit, EDITS, TARGETS, ARROW_EVENT } = require('../xterm-scrollbar-arrows-patch');
const { SCROLLBAR_ARROW_EVENT } = require('../../packages/terminal-core/src/scrollbarArrows');

const ROOT = path.resolve(__dirname, '..', '..');

const [OPTIONS_EDIT, ARROWS_EDIT, COLOUR_EDIT] = EDITS;

/**
 * Pristine constructs, copied VERBATIM from each shipped bundle (2026-09-19, @xterm/xterm 6.0.0).
 * Two copies of each because the bundles are minified separately and the minifier picks
 * different one-letter names: the resolved options are `e` in `xterm.mjs` and `t` in `xterm.js`;
 * the theme service is `l` and `n`.
 */

// E1 — the Viewport's SmoothScrollableElement option literal (just the object).
const OPTIONS_MJS = '{vertical:1,horizontal:2,useShadows:!1,mouseWheelSmoothScroll:!0,...this._getChangeOptions()}';
const OPTIONS_CJS = OPTIONS_MJS; // byte-identical in both bundles

// E2 — the VerticalScrollbar constructor from the throw's condition to the end of the
// `_createSlider` call that follows it. Compiled as `if(<text>)` so the pristine form is
// `if(e.verticalHasArrows)throw …;this._createSlider(…)` and the patched form is
// `if(e.verticalHasArrows){…}this._createSlider(…)` — exactly what the bundle contains.
const ARROWS_MJS =
  'e.verticalHasArrows)throw new Error("horizontalHasArrows is not supported in xterm.js");' +
  'this._createSlider(0,Math.floor((e.verticalScrollbarSize-e.verticalSliderSize)/2),e.verticalSliderSize,void 0)';
const ARROWS_CJS =
  't.verticalHasArrows)throw new Error("horizontalHasArrows is not supported in xterm.js");' +
  'this._createSlider(0,Math.floor((t.verticalScrollbarSize-t.verticalSliderSize)/2),t.verticalSliderSize,void 0)';

// E3 — the tail of the injected-style template array, from its last rule to the join.
const COLOUR_MJS =
  '[".xterm .xterm-scrollable-element > .scrollbar > .slider.active {",' +
  '`  background: ${l.colors.scrollbarSliderActiveBackground.css};`,"}"].join(`\n`)';
const COLOUR_CJS =
  '[".xterm .xterm-scrollable-element > .scrollbar > .slider.active {",' +
  '`  background: ${n.colors.scrollbarSliderActiveBackground.css};`,"}"].join("\\n")';

/** Compile a function body into a callable. */
function compile(params: string[], body: string): (...args: any[]) => any {
  // eslint-disable-next-line no-new-func
  return new Function(...params, body);
}

/** The resolved options VS Code's scrollbar sees in TermFlow: 14 px bar, arrows requested. */
function resolvedOptions(overrides: Record<string, unknown> = {}) {
  return { verticalHasArrows: true, arrowSize: 14, verticalScrollbarSize: 14, verticalSliderSize: 14, ...overrides };
}

/**
 * A stand-in for the VerticalScrollbar instance: records `_createArrow` / `_createSlider`
 * calls, and owns a scrollbar node parked under a parent so bubbling can be observed.
 */
function fakeScrollbar() {
  const parent = document.createElement('div');
  const node = document.createElement('div');
  parent.appendChild(node);
  const arrows: any[] = [];
  const sliders: any[] = [];
  return {
    parent,
    node,
    arrows,
    sliders,
    self: {
      domNode: { domNode: node },
      _createArrow(opts: any) { arrows.push(opts); },
      _createSlider(...args: any[]) { sliders.push(args); },
    },
  };
}

const optionsVariants: [string, string][] = [['xterm.mjs', OPTIONS_MJS], ['xterm.js', OPTIONS_CJS]];
const arrowsVariants: [string, string, string][] = [['xterm.mjs', ARROWS_MJS, 'e'], ['xterm.js', ARROWS_CJS, 't']];
const colourVariants: [string, string, string][] = [['xterm.mjs', COLOUR_MJS, 'l'], ['xterm.js', COLOUR_CJS, 'n']];

describe('viewport-options — the Viewport asks for arrows', () => {
  it.each(optionsVariants)('%s: adds verticalHasArrows and a 14px arrowSize, keeping everything else', (_n, pristine) => {
    const { source, status } = applyEdit(OPTIONS_EDIT, pristine);
    expect(status).toBe('patched');
    const self = { _getChangeOptions: () => ({ verticalScrollbarSize: 14, mouseWheelScrollSensitivity: 1 }) };
    const before = compile([], `return ${pristine}`).call(self);
    const after = compile([], `return ${source}`).call(self);
    expect(after).toEqual({ ...before, verticalHasArrows: true, arrowSize: 14 });
    // 14 is xterm's DEFAULT_SCROLL_BAR_WIDTH, so the buttons are square.
    expect(after.arrowSize).toBe(after.verticalScrollbarSize);
  });
});

describe('vertical-arrows — the throw becomes two arrows', () => {
  it.each(arrowsVariants)('%s: pristine throws; patched does not, and the code after the block still runs', (_n, pristine, o) => {
    const stock = fakeScrollbar();
    expect(() => compile([o], `if(${pristine}`).call(stock.self, resolvedOptions()))
      .toThrow('horizontalHasArrows is not supported in xterm.js');
    expect(stock.arrows).toHaveLength(0);

    const { source, status } = applyEdit(ARROWS_EDIT, pristine);
    expect(status).toBe('patched');
    const patched = fakeScrollbar();
    expect(() => compile([o], `if(${source}`).call(patched.self, resolvedOptions())).not.toThrow();
    // The `_createSlider(0, floor((14-14)/2), 14, undefined)` that follows the block is intact —
    // i.e. the block's `__tf` locals did not swallow or shadow the constructor's own.
    expect(patched.sliders).toEqual([[0, 0, 14, undefined]]);
  });

  it.each(arrowsVariants)('%s: places the two arrows exactly where VS Code does', (_n, pristine, o) => {
    const { source } = applyEdit(ARROWS_EDIT, pristine);
    const sb = fakeScrollbar();
    compile([o], `if(${source}`).call(sb.self, resolvedOptions());

    expect(sb.arrows).toHaveLength(2);
    const [up, down] = sb.arrows;
    // Glyph is ARROW_IMG_SIZE (11) px inside a 14 px box: (14 - 11) / 2 = 1.5 on each axis.
    expect(up).toMatchObject({
      className: 'scra scra-up', top: 1.5, left: 1.5, bottom: undefined, right: undefined, bgWidth: 14, bgHeight: 14,
    });
    expect(down).toMatchObject({
      className: 'scra scra-down', top: undefined, left: 1.5, bottom: 1.5, right: undefined, bgWidth: 14, bgHeight: 14,
    });
    expect(typeof up.onActivate).toBe('function');
    expect(typeof down.onActivate).toBe('function');
  });

  it.each(arrowsVariants)('%s: a wider bar or taller button re-centres the glyph', (_n, pristine, o) => {
    const { source } = applyEdit(ARROWS_EDIT, pristine);
    const sb = fakeScrollbar();
    compile([o], `if(${source}`).call(sb.self, resolvedOptions({ arrowSize: 21, verticalScrollbarSize: 17 }));
    expect(sb.arrows[0]).toMatchObject({ top: 5, left: 3, bgWidth: 17, bgHeight: 21 });
    expect(sb.arrows[1]).toMatchObject({ bottom: 5, left: 3, bgWidth: 17, bgHeight: 21 });
  });

  it.each(arrowsVariants)('%s: ▲ emits detail -1 and ▼ emits detail +1, bubbling out of the scrollbar node', (_n, pristine, o) => {
    const { source } = applyEdit(ARROWS_EDIT, pristine);
    const sb = fakeScrollbar();
    compile([o], `if(${source}`).call(sb.self, resolvedOptions());

    const seen: Array<{ detail: unknown; target: EventTarget | null }> = [];
    // Listen on the PARENT: the app listens on `.xterm`, several ancestors up, so the event
    // must bubble — a non-bubbling event would satisfy a listener on the node itself and never
    // reach the engine.
    sb.parent.addEventListener(ARROW_EVENT, (ev) => {
      seen.push({ detail: (ev as CustomEvent).detail, target: ev.target });
    });

    sb.arrows[0].onActivate();
    sb.arrows[1].onActivate();
    expect(seen).toEqual([
      { detail: -1, target: sb.node },
      { detail: 1, target: sb.node },
    ]);
  });

  it.each(arrowsVariants)('%s: without verticalHasArrows nothing is created (the option gate is preserved)', (_n, pristine, o) => {
    const { source } = applyEdit(ARROWS_EDIT, pristine);
    const sb = fakeScrollbar();
    compile([o], `if(${source}`).call(sb.self, resolvedOptions({ verticalHasArrows: false }));
    expect(sb.arrows).toHaveLength(0);
    expect(sb.sliders).toHaveLength(1);
  });
});

describe('arrow-colour — the injected theme style covers the arrows', () => {
  const themeService = (o: string) => ({
    [o]: {
      colors: {
        scrollbarSliderActiveBackground: { css: 'rgba(242,242,242,0.5)' },
        foreground: { css: '#f2f2f2' },
      },
    },
  });

  it.each(colourVariants)('%s: appends a .scra colour rule after the slider rules, using the theme foreground', (_n, pristine, o) => {
    const { source, status } = applyEdit(COLOUR_EDIT, pristine);
    expect(status).toBe('patched');
    const ts = themeService(o)[o];
    const before: string = compile([o], `return ${pristine}`)(ts);
    const after: string = compile([o], `return ${source}`)(ts);

    // Everything that was there is still there, in place, and the new rule follows it.
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(
      '\n.xterm .xterm-scrollable-element > .scrollbar > .scra {' +
      '\n  color: #f2f2f2;' +
      '\n}',
    );
  });
});

describe('idempotency and failure', () => {
  const ALL_MJS = `${OPTIONS_MJS}\n${ARROWS_MJS}\n${COLOUR_MJS}`;

  it('reports an already-patched source instead of patching it twice', () => {
    const once = applyPatch(ALL_MJS);
    expect(once.status).toBe('patched');
    expect(once.problems).toEqual([]);

    const twice = applyPatch(once.source);
    expect(twice.status).toBe('already');
    expect(twice.source).toBe(once.source);
  });

  it('detects a HALF-patched source rather than calling it done', () => {
    // Each edit carries its own marker: a source where E1 applied and E2/E3 did not would
    // otherwise report "already patched" forever — and throw at every terminal open, since
    // E1 without E2 hits the very throw this patch removes.
    const half = applyEdit(OPTIONS_EDIT, ALL_MJS).source;
    const result = applyPatch(half);
    expect(result.status).toBe('patched');
    expect(result.source).toContain('__tfArrowFire');
    expect(result.source).toContain('> .scra {');
  });

  it('reports a source it does not recognise rather than corrupting it', () => {
    const garbage = 'class X{constructor(e){this._createSlider(0,0,e.verticalSliderSize,void 0)}}';
    const result = applyPatch(garbage);
    expect(result.status).toBe('nomatch');
    expect(result.source).toBe(garbage);
    expect(result.problems.map((p: { name: string }) => p.name))
      .toEqual(['viewport-options', 'vertical-arrows', 'arrow-colour']);
  });

  it('refuses a source with more than one match rather than half-patching it', () => {
    const doubled = `${OPTIONS_MJS}\n${ARROWS_MJS}\n${ARROWS_CJS}\n${COLOUR_MJS}`;
    const result = applyPatch(doubled);
    expect(result.status).toBe('ambiguous');
    expect(result.source).toBe(doubled);
    expect(result.problems.map((p: { name: string }) => p.name)).toEqual(['vertical-arrows']);
  });

  it('leaves the source untouched when ANY edit fails', () => {
    // All-or-nothing: E1 alone would make every terminal throw on open; E2 alone is dead code.
    const optionsOnly = OPTIONS_MJS;
    const result = applyPatch(optionsOnly);
    expect(result.status).toBe('nomatch');
    expect(result.source).toBe(optionsOnly);
    expect(result.source).not.toContain('verticalHasArrows:!0');
  });

  it('the HorizontalScrollbar twin throw is left alone', () => {
    // Same message, different flag. The horizontal bar is Hidden in xterm and has no track to
    // reserve; touching it would create arrows nobody can see and nobody removes.
    const horizontal = 'e.horizontalHasArrows)throw new Error("horizontalHasArrows is not supported in xterm.js");';
    expect(applyEdit(ARROWS_EDIT, horizontal).status).toBe('nomatch');
  });
});

describe('the app-side contract', () => {
  it('emits the event name the engine listens for', () => {
    expect(ARROW_EVENT).toBe(SCROLLBAR_ARROW_EVENT);
  });
});

describe('the shipped bundles', () => {
  /**
   * The bundle ON DISK must already be patched — not merely patchable. A tree where postinstall
   * never ran, or ran and failed, would otherwise pass every test above while the scrollbar has
   * no buttons. Safe to assert against disk: every CI job runs `bun install --frozen-lockfile`
   * with no `node_modules` cache, so postinstall always runs.
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
    // 'nomatch' means an upgrade reminified a construct; 'ambiguous' means one appears twice.
    expect(applyPatch(source).status).toBe('already');
    for (const edit of EDITS) expect(source).toContain(edit.marker);
  });
});

describe('wiring', () => {
  it('runs on postinstall, after the coords patch and before the patch that cannot fail loudly', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const postinstall: string = pkg.scripts.postinstall;
    expect(postinstall).toContain('xterm-scrollbar-arrows-patch.js');
    // `xterm-dim-patch.js` signals failure with `process.exitCode = 1` rather than throwing, so
    // with `&&` chaining a dim failure would silently prevent any patch AFTER it from running.
    // This one throws, so it belongs with the coords patch, ahead of dim.
    expect(postinstall.indexOf('xterm-scrollbar-arrows-patch.js'))
      .toBeLessThan(postinstall.indexOf('xterm-dim-patch.js'));
    expect(pkg.scripts['patch:xterm-scrollbar-arrows']).toBe('node patches/xterm-scrollbar-arrows-patch.js');
  });
});
