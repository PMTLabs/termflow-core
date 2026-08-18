/**
 * The keyboard and toolbar wiring for Tam's items 1-4 — the parts with no pure form.
 *
 * The DECISIONS are pure and tested in `canvasGestures.test.ts`: `terminalKeyAction` is where
 * "Esc reaches the terminal" now lives, and `canvasKeyAction` is where "E enlarges the selected
 * node" lives. What is left here is what only exists as code — which listener is in which phase,
 * whether the handler that resolved to `passthrough` really leaves the event alone, and which
 * callback a button is wired to. Mounting `CanvasMode` for real means mounting every terminal on
 * the canvas, so these read source.
 *
 * **Every match runs against source with comments stripped**, for the reason `canvasCloseWiring`
 * records: three tests in this plan have now been satisfied by their own explanatory prose.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

const CANVAS = path.resolve(__dirname, '..');

function code(file: string): string {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MODE = code(path.join(CANVAS, 'CanvasMode.tsx'));
const MINIMAP = code(path.join(CANVAS, 'CanvasMinimap.tsx'));
const CSS = readSource(path.join(CANVAS, 'Canvas.css'));

const ON_KEY = 'const onKey = (e: KeyboardEvent) => {';

/**
 * One keydown handler, whole — from its opening line to the `};` that closes it.
 *
 * Found by walking BACK from something only that handler contains, because both listeners in
 * this component open with the same line. Scoping matters more than usual here: the two are
 * near-mirrors of each other, so a file-wide `toContain` passes against whichever one the
 * assertion was not about.
 *
 * Sliced rather than matched with a regex because the delimiters are newlines and braces, which
 * is the worst case for escaping.
 */
function handlerAround(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  const start = src.lastIndexOf(ON_KEY, at);
  return start < 0 ? '' : src.slice(start, src.indexOf('\n    };', at));
}

/** A single arrow callback, from `const <name> = useCallback(` to the line that closes it. */
function callback(src: string, name: string): string {
  const i = src.indexOf(`const ${name} = useCallback(`);
  return i < 0 ? '' : src.slice(i, src.indexOf('\n  }, [', i));
}

const CANVAS_KEYS = handlerAround(MODE, 'canvasKeyAction(');
const TERMINAL_KEYS = handlerAround(MODE, 'terminalKeyAction(');

describe('found the two handlers it is reading', () => {
  /** Or every assertion below passes vacuously against an empty string — and both slices being
   *  whole handlers is what the gate and ordering tests depend on. */
  it('sliced two whole handlers, and they are different code', () => {
    for (const [name, src] of [['canvas', CANVAS_KEYS], ['terminal', TERMINAL_KEYS]] as const) {
      expect({ name, opens: src.startsWith(ON_KEY) }).toEqual({ name, opens: true });
    }
    expect(CANVAS_KEYS).toContain('canvasKeyAction(');
    expect(TERMINAL_KEYS).toContain('terminalKeyAction(');
    expect(CANVAS_KEYS).not.toBe(TERMINAL_KEYS);
    // Neither slice may swallow the other, or "this handler does not do X" means nothing.
    expect(CANVAS_KEYS).not.toContain('terminalKeyAction(');
    expect(TERMINAL_KEYS).not.toContain('canvasKeyAction(');
  });
});

/**
 * Item 1. The resolver can say `passthrough` all it likes; if the handler stops the event anyway,
 * Esc still never reaches the PTY — and the symptom is identical to the bug that was reported.
 */
describe('a passthrough really is left alone', () => {
  it('returns before touching the event', () => {
    // The order is the whole assertion: the `passthrough` return has to come BEFORE the
    // preventDefault, or every key in a focused terminal is swallowed.
    const bail = TERMINAL_KEYS.indexOf("if (action === 'passthrough') return;");
    const stop = TERMINAL_KEYS.indexOf('e.preventDefault();');
    expect(bail).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(-1);
    expect(bail).toBeLessThan(stop);
  });

  it('stops the event on the paths it does claim', () => {
    // preventDefault alone would leave the terminal seeing the chord as well — the same mistake
    // the canvas wheel made against mouse-tracking TUIs.
    expect(TERMINAL_KEYS).toContain('e.preventDefault();');
    expect(TERMINAL_KEYS).toContain('e.stopPropagation();');
  });

  /** The overlay state is read through a REF. The effect is keyed on `focusedId`; adding
   *  `overlayId` to its deps would tear down and re-register the capture-phase listener every
   *  time the overlay opened, which is exactly when a keypress is in flight. */
  it('reads the overlay through the ref, not a dependency', () => {
    expect(TERMINAL_KEYS).toContain('overlayIdRef.current');
    expect(MODE).toMatch(/\}, \[focusedId, dispatch\]\);/);
  });
});

/** Item 2's round trip. Both exits blur, or the keyboard stays inside a terminal the user has
 *  just stepped out of — including for the `E` that is supposed to bring the overlay back. */
describe('leaving hands the keyboard back', () => {
  it('blurs, closes the overlay and releases the focus', () => {
    expect(TERMINAL_KEYS).toContain('(document.activeElement as HTMLElement | null)?.blur();');
    expect(TERMINAL_KEYS).toContain("if (action === 'leave') dispatch(setOverlayNode(null));");
    expect(TERMINAL_KEYS).toContain('dispatch(focusNode(null));');
  });

  /**
   * `release-focus` must NOT also close an overlay.
   *
   * It only fires when there is no overlay open, so a `setOverlayNode(null)` there would be
   * harmless today and would silently become the old bug the moment the resolver changed. The
   * guard is what keeps the two exits distinguishable.
   */
  it('closes the overlay only on the leave path', () => {
    expect(TERMINAL_KEYS.match(/setOverlayNode\(null\)/g) ?? []).toHaveLength(1);
  });
});

describe('the canvas keys', () => {
  it('are gated on the canvas holding the keyboard', () => {
    // Every rule in `canvasKeyAction` is a bare key or a Shift key. While a node is focused they
    // are all just input, which is why this gate is the caller's and not the rule's.
    expect(CANVAS_KEYS.indexOf('if (focusedId) return;')).toBeGreaterThan(-1);
  });

  /**
   * Item 3's other half. The canvas listens in the CAPTURE phase, so it runs BEFORE the
   * minimap's own React handler — `stopPropagation` there would be too late, and the view would
   * move by both steps at once.
   */
  it('leaves the minimap\'s arrows to the minimap', () => {
    expect(CANVAS_KEYS).toContain("action.do === 'pan' && el?.closest?.('.canvas-minimap')");
  });

  /**
   * Both DOM vetoes are scoped to the ONE action they are about.
   *
   * A blanket bail on either element takes the other keys with it, and silently: bailing on the
   * whole event for anything inside the minimap kills Ctrl+= while it has focus, and bailing for
   * anything focusable kills every shortcut while the search box is empty and focused. Neither
   * shows up as an error — the keys just stop working somewhere nobody thought to try.
   */
  it('scopes each veto to its own action', () => {
    for (const veto of ['.canvas-minimap', 'FOCUSABLE_CHROME']) {
      const line = CANVAS_KEYS.split('\n').find((l) => l.includes(veto)) ?? '';
      expect({ veto, guarded: /action\.do === '(pan|step)'/.test(line) })
        .toEqual({ veto, guarded: true });
    }
  });

  /** Tab has to keep walking the controls, or the canvas is a surface you can enter and never
   *  leave with a keyboard. `[tabindex]` is what catches the minimap, which is a plain div. */
  it('lets Tab still reach the chrome', () => {
    expect(CANVAS_KEYS).toContain("action.do === 'step' && el?.closest?.(FOCUSABLE_CHROME)");
    const list = /const FOCUSABLE_CHROME = '([^']+)';/.exec(MODE);
    expect(list).not.toBeNull();
    for (const sel of ['button', 'input', 'textarea', '[tabindex]']) {
      expect(list![1]).toContain(sel);
    }
  });

  it('listens in the capture phase and removes what it adds', () => {
    expect(MODE).toContain("window.addEventListener('keydown', onKey, true);");
    expect(MODE.match(/window\.addEventListener\('keydown', onKey, true\);/g) ?? []).toHaveLength(2);
    expect(MODE.match(/window\.removeEventListener\('keydown', onKey, true\)/g) ?? []).toHaveLength(2);
  });

  /** The pan dispatch is RELATIVE, which is what keeps `panScreen` referentially stable — a
   *  handler that closed over the viewport would re-register this listener on every frame of a
   *  mouse pan. */
  it('pans through the relative action, never by reading the viewport', () => {
    expect(MODE).toContain('dispatch(panViewport({ dx, dy }));');
    expect(CANVAS_KEYS).toContain('panScreen(action.dx, action.dy);');
    expect(CANVAS_KEYS).not.toContain('vp.');
  });
});

/**
 * Every action the resolver can return must be acted on — derived from the union rather than
 * listed, so the next action added is covered the day it is written.
 *
 * This exists because two mutants survived a full round without it: the resolver returned
 * `{ do: 'step' }` and `{ do: 'zoom' }` and the handler dropped both on the floor. That is the
 * worst failure shape in this file — the event has ALREADY been `preventDefault`ed by the time
 * the dispatch runs, so an unhandled action is a key that is swallowed and does nothing at all.
 *
 * The compiler covers a MISSING arm (the `never` in the default case). Only a test can cover an
 * arm that is present and inert.
 */
describe('the canvas acts on every action it resolves', () => {
  const GESTURES = code(path.join(CANVAS, 'canvasGestures.ts'));
  const UNION = GESTURES.slice(
    GESTURES.indexOf('export type CanvasAction ='),
    GESTURES.indexOf('export function canvasKeyAction'),
  );
  const ACTIONS = [...UNION.matchAll(/\{ do: '(\w+)'([^}]*)\}/g)]
    .map((m) => ({ name: m[1], payload: m[2].trim() }));

  /** One `case` arm, from its label to the next label. */
  const armFor = (name: string): string => {
    const at = CANVAS_KEYS.indexOf(`case '${name}':`);
    if (at < 0) return '';
    const rest = CANVAS_KEYS.slice(at);
    const end = rest.slice(1).search(/\n\s*(case '|default)/);
    return end < 0 ? rest : rest.slice(0, end + 1);
  };

  it('found the union and the switch it is checking', () => {
    // Or every filter below is empty for the wrong reason.
    expect(ACTIONS.length).toBeGreaterThan(3);
    expect(ACTIONS.map((a) => a.name)).toContain('pan');
    expect(CANVAS_KEYS).toContain('switch (action.do)');
    // The compile-time half. Without it a NEW variant needs no arm and no test notices.
    expect(CANVAS_KEYS).toContain('const unhandled: never = action;');
  });

  it('gives every action an arm that calls something', () => {
    const inert = ACTIONS.filter((a) => !armFor(a.name).includes('(')).map((a) => a.name);
    expect(inert).toEqual([]);
  });

  it('uses the payload of every action that carries one', () => {
    // `{ do: 'step'; dir: StepDir }` acted on as `stepNode(1)` would always step forward, and
    // Shift+Tab would look like it worked while going the wrong way.
    const ignored = ACTIONS
      .filter((a) => a.payload && !armFor(a.name).includes('action.'))
      .map((a) => a.name);
    expect(ignored).toEqual([]);
  });

  it('has an arm per action and no arm without one', () => {
    const cases = [...CANVAS_KEYS.matchAll(/case '(\w+)':/g)].map((m) => m[1]).sort();
    expect(cases).toEqual(ACTIONS.map((a) => a.name).sort());
  });
});

/** Tab-stepping and the zoom keys — the sixth round. */
describe('stepping and zooming from the keyboard', () => {
  const STEP = callback(MODE, 'stepNode');
  const ZOOM = callback(MODE, 'zoomKey');

  it('found both callbacks', () => {
    expect(STEP).toContain('stepNodeId(');
    expect(ZOOM).toContain('zoomStep(');
  });

  /**
   * Stepping must follow the SIDEBAR's order, which it does by using the same array the sidebar
   * is built from. Sorting by position here would give the keyboard one order and the list
   * another — neither wrong enough to notice until you tried to follow one with the other.
   */
  it('steps in the model\'s own order', () => {
    expect(STEP).toContain('model.nodes.map((n) => n.terminalId)');
    expect(STEP).not.toMatch(/\.sort\(/);
  });

  /** Only flies when the node is not already framed, and never changes the zoom. Centring a
   *  node you can already see yanks the viewport for nothing — on a key people hold down. */
  it('flies only when the target is off screen, at the zoom the user chose', () => {
    expect(STEP).toContain('!isFullyVisible(vp, aimedNodeRect(n.rect, vp.z), size.w, size.h, FRAME_INSET)');
    expect(STEP).toContain('centreOn(aimedNodeRect(n.rect, vp.z), size.w, size.h, vp.z, metrics.zMax)');
  });

  /** Both calls POINT at the node, so both take the DRAWN box. The reserved rect carries up
   *  to a title bar of slack the node does not paint, which centres it high and makes the
   *  containment test trip on empty space — a fly-to for a node that was already fully
   *  visible, on a key that repeats. Naming `n.rect` bare here is the regression. */
  it('never aims at the reserved rect', () => {
    expect(STEP).not.toContain('isFullyVisible(vp, n.rect');
    expect(STEP).not.toContain('centreOn(n.rect');
  });

  it('selects the node it steps to', () => {
    expect(STEP).toContain('dispatch(selectNode(next));');
  });

  /** The keys reuse the BUTTONS' step, so the two cannot drift apart, and reset asks for the
   *  factor that lands on 1:1 rather than writing the zoom directly — which keeps it anchored
   *  on the viewport centre like every other zoom. */
  it('shares one zoom step with the toolbar, and resets to 1:1', () => {
    expect(ZOOM).toContain('ZOOM_STEP');
    expect(ZOOM).toContain('1 / ZOOM_STEP');
    expect(ZOOM).toContain('1 / vp.z');
    expect(ZOOM).not.toContain('setViewport');
  });
});

/** Item 3, the minimap half. */
describe('the minimap can hold the keyboard', () => {
  it('is in the tab order and says what it is', () => {
    expect(MINIMAP).toContain('tabIndex={0}');
    expect(MINIMAP).toContain('aria-label=');
    // `role="presentation"` hides an element from the accessibility tree, which is a
    // contradiction once it is focusable — it would be in the tab order and unnamed.
    expect(MINIMAP).not.toContain('role="presentation"');
  });

  it('takes focus on a click, so click-then-arrow works', () => {
    expect(MINIMAP).toContain('e.currentTarget.focus();');
  });

  it('shows when it is the thing the arrows will reach', () => {
    expect(CSS).toMatch(/\.canvas-minimap:focus-visible\s*\{[^}]*outline:/);
  });

  /** Its own scale, and it must be the minimap's — the whole distinction Tam asked for. Wired to
   *  `minimapPanStep`, not to `PAN_STEP_PX`, which would make it a second copy of the canvas's. */
  it('steps at the minimap\'s scale', () => {
    expect(MINIMAP).toContain('minimapPanStep(t, vp.z)');
    expect(MINIMAP).not.toContain('PAN_STEP_PX');
  });

  it('claims the arrows it handles', () => {
    // Without preventDefault the page would also scroll, and the two motions would fight.
    const onKeyDown = callback(MINIMAP, 'onKeyDown');
    expect(onKeyDown).not.toBe('');
    expect(onKeyDown).toContain('panShortcut(');
    expect(onKeyDown).toContain('e.preventDefault();');
  });
});

/** Item 4. */
describe('the viewport toolbar', () => {
  const TOOLBAR = MODE.slice(MODE.indexOf('<div className="canvas-toolbar">'), MODE.indexOf('</div>\n      )}'));

  it('found the toolbar it is reading', () => {
    expect(TOOLBAR).toContain('canvas-toolbar');
    expect(TOOLBAR).toContain('Arrange');
  });

  it('has a zoom pair and a view-all', () => {
    expect(TOOLBAR).toContain('onClick={() => zoomStep(ZOOM_STEP)}');
    expect(TOOLBAR).toContain('onClick={() => zoomStep(1 / ZOOM_STEP)}');
    expect(TOOLBAR).toContain('View All');
  });

  /** Zoom in and zoom out have to be exact inverses, or a round trip drifts the zoom. Asserted
   *  as the reciprocal of ONE constant rather than as two numbers that happen to multiply to 1. */
  it('zooms out by the reciprocal of the step it zooms in by', () => {
    expect(MODE).toMatch(/const ZOOM_STEP = [\d.]+;/);
    expect(TOOLBAR.match(/zoomStep\(/g) ?? []).toHaveLength(2);
    expect(TOOLBAR).toContain('1 / ZOOM_STEP');
  });

  /** The same destination Shift+1 flies to, through the same callback. A second "show me
   *  everything" that framed something slightly different would be worse than none. */
  it('shares fitAll with the keyboard shortcut', () => {
    expect(TOOLBAR).toContain('onClick={fitAll}');
  });

  /** A `−` in a 27px box is the only clue the keyboard chord exists, and it is the one people
   *  go looking for after learning the terminal's own font zoom. */
  it('names its keyboard shortcut on both zoom buttons', () => {
    expect(TOOLBAR).toContain('title="Zoom in (Ctrl +)"');
    expect(TOOLBAR).toContain('title="Zoom out (Ctrl -)"');
  });

  /** `zoomAt` returns the viewport unchanged once `clampZoom` bites, so at the clamps an enabled
   *  button is indistinguishable from a broken one. */
  it('disables each zoom button at its own clamp', () => {
    expect(TOOLBAR).toContain('disabled={vp.z <= Z_MIN}');
    expect(TOOLBAR).toContain('disabled={vp.z >= metrics.zMax}');
    expect(CSS).toMatch(/\.canvas-tbtn:disabled\s*\{/);
  });

  /** Anchored to the middle of the VIEWPORT, which is the only anchor a button has — the wheel
   *  has the cursor. Zooming about the world origin instead would throw the workspace off screen
   *  at any pan. */
  it('zooms about the middle of the viewport', () => {
    expect(MODE).toContain('zoomAt(vp, factor, size.w / 2, size.h / 2, metrics.zMax)');
  });
});

/**
 * Item 5. Derived from the real files rather than asserted as a hex value: what Tam asked for is
 * that the two kinds of row in the sidebar do not share a colour, and a test naming the colour
 * would pass the day both were changed to it.
 */
describe('the sidebar tells a group from a terminal', () => {
  const rule = (selector: string): string => {
    const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(CSS);
    return m ? m[1] : '';
  };
  const colourOf = (selector: string): string => {
    const m = /(?:^|;)\s*color:\s*([^;]+)/.exec(rule(selector));
    return m ? m[1].trim() : '';
  };

  it('found both rules it is comparing', () => {
    expect(colourOf('.canvas-sghead')).not.toBe('');
    expect(colourOf('.canvas-srow')).not.toBe('');
  });

  it('gives them different colours', () => {
    expect(colourOf('.canvas-sghead')).not.toBe(colourOf('.canvas-srow'));
  });

  /**
   * ...and a different HUE, not another grey.
   *
   * The two already differed before this change — `--text-secondary` against `--text-primary` —
   * and that is exactly what Tam reported as looking the same. A test that only demanded
   * "different" would have passed on the code he was complaining about.
   */
  it('uses a hue for the group, not a lighter or darker grey', () => {
    expect(colourOf('.canvas-sghead')).toContain('--canvas-group-fg');
    const declared = /--canvas-group-fg:\s*(#[0-9a-fA-F]{6})/.exec(CSS);
    expect(declared).not.toBeNull();
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(declared![1].slice(i, i + 2), 16));
    // A grey has all three channels equal; "not a grey" is a real spread between them.
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeGreaterThan(40);
  });
});
