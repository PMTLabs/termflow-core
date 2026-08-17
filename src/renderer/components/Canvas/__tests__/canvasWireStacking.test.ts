import path from 'path';
import { readSource } from '../../../utils/readSource';

/**
 * The two wire layers must actually straddle the nodes.
 *
 * `plan/013` Task 18 specified `.canvas-wires.over { z-index: 5 }`. The node stack in
 * `Canvas.css` is `.canvas-node` 2, `.canvas-port` 6, `.canvas-node.focused` 7 — so 5 put the
 * "above the nodes" layer BELOW the focused node and below every port. The masked ghost, whose
 * whole job is to stay visible where a wire crosses a terminal, would vanish on the one node the
 * user was working in, and nothing would have noticed: the wire is still on screen, drawn by the
 * under-layer everywhere else.
 *
 * **Derived from the stylesheet, not written down.** The numbers here are exactly the kind that
 * go stale on the change this test exists to catch — the next person to raise a node's z-index
 * for an unrelated reason silently re-breaks the ghost. So the bounds are computed from whatever
 * node rules the file actually contains, and a new one is covered the day it is written.
 */

const CSS = readSource(path.resolve(__dirname, '../Canvas.css'))
  .replace(/\/\*[\s\S]*?\*\//g, '');

interface Rule { selector: string; z: number }

function zIndexRules(): Rule[] {
  const out: Rule[] = [];
  for (const m of CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const head = m[1].trim();
    if (head.startsWith('@')) continue;
    const z = /(?:^|;)\s*z-index\s*:\s*(-?\d+)/.exec(m[2]);
    if (!z) continue;
    for (const one of head.split(',')) out.push({ selector: one.trim(), z: Number(z[1]) });
  }
  return out;
}

const RULES = zIndexRules();
const zOf = (selector: string): number => {
  const hit = RULES.find((r) => r.selector === selector);
  if (!hit) throw new Error(`no z-index rule for "${selector}" — the subject moved or was renamed`);
  return hit.z;
};

/** Every rule whose subject is a node or a part of one that paints ABOVE the node box. */
const nodeLayer = RULES.filter((r) =>
  /^\.canvas-node(\.|$|\s)/.test(r.selector) || r.selector === '.canvas-port',
).filter((r) => r.z >= 0 && !/overlaid/.test(r.selector));

describe('wire layer stacking', () => {
  it('finds the node rules it is bounding, so the check cannot pass vacuously', () => {
    // Guard against the failure mode this suite is most at risk of: a selector rename turns the
    // filter above into an empty list and every comparison below becomes trivially true.
    expect(nodeLayer.length).toBeGreaterThanOrEqual(3);
    expect(nodeLayer.map((r) => r.selector)).toEqual(
      expect.arrayContaining(['.canvas-node', '.canvas-port', '.canvas-node.focused']),
    );
  });

  it('draws the under-layer beneath every node, so a crossing wire is occluded', () => {
    const under = zOf('.canvas-wires');
    for (const rule of nodeLayer) {
      expect(under).toBeLessThan(rule.z);
    }
  });

  it('draws the over-layer above every node, INCLUDING a focused one and its ports', () => {
    const over = zOf('.canvas-wires.over');
    for (const rule of nodeLayer) {
      expect(over).toBeGreaterThan(rule.z);
    }
  });

  it('keeps the over-layer below the overlay backdrop', () => {
    // While a node is overlaid the canvas behind it is deliberately dimmed. Ghost wires painted
    // over that backdrop would be the one thing still at full contrast on a screen that is
    // meant to have receded.
    expect(zOf('.canvas-wires.over')).toBeLessThan(zOf('.canvas-overlay-backdrop'));
  });

  it('gives the hit layer a stroke wider than the wire it stands in for', () => {
    const width = (selector: string): number => {
      const m = new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`).exec(CSS);
      const w = /stroke-width\s*:\s*calc\((\d+(?:\.\d+)?)px/.exec(m?.[1] ?? '');
      if (!w) throw new Error(`no stroke-width for ${selector}`);
      return Number(w[1]);
    };
    // A hairline is not a hit target; the right-click band has to be far wider than the line.
    expect(width('.canvas-wire-hit')).toBeGreaterThan(width('.canvas-wire') * 3);
  });

  it('leaves both wire layers transparent to the pointer', () => {
    // The hit paths are a separate layer precisely so the visible wires never block a click on
    // a node underneath them.
    const block = /\.canvas-wires\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(block).toMatch(/pointer-events\s*:\s*none/);
  });
});

/**
 * The selected connection's controls, which have to sit above the nodes they are attached to.
 *
 * Both handles are placed exactly ON a node's border (`portPoint` returns a point on the edge),
 * so half of each one overlaps the node it belongs to. Drawn on the under-layer they would be
 * half-covered by that node — a grab target you can only hit one side of, which is the kind of
 * control people decide is broken rather than fiddly.
 */
describe('the selected connection layer', () => {
  it('draws the handles above every node and every port', () => {
    const handles = zOf('.canvas-wires.handles');
    for (const rule of nodeLayer) {
      expect({ selector: rule.selector, above: handles > rule.z })
        .toEqual({ selector: rule.selector, above: true });
    }
    // Above the masked ghost too, or a wire crossing this one would draw over its own handle.
    expect(handles).toBeGreaterThan(zOf('.canvas-wires.over'));
  });

  it('keeps them below the overlay backdrop', () => {
    // A node blown up to fill the screen is not the moment to be adjusting a wire behind it.
    expect(zOf('.canvas-wires.handles')).toBeLessThan(zOf('.canvas-overlay-backdrop'));
  });

  /**
   * `.canvas-wires` is `pointer-events: none` and the handles layer inherits it. Without an
   * explicit re-enable the controls are drawn, look interactive, and take no clicks at all.
   */
  it('re-enables the pointer on the controls themselves', () => {
    const block = /\.canvas-wire-handle,\s*\n?\.canvas-wire-badge\s*\{([^}]*)\}/.exec(CSS)?.[1];
    expect(block).toBeDefined();
    expect(block).toMatch(/pointer-events\s*:\s*all/);
  });

  /**
   * Every wire surface goes inert while a drag is in flight.
   *
   * `useWireDrag` finds its drop target with `elementFromPoint(...).closest('.canvas-node')`,
   * which answers with the TOPMOST element. A wire surface still taking the pointer shadows the
   * node underneath it, `closest` walks up through the SVG instead and finds nothing, and the
   * drop is refused over that patch with no error anywhere. The handles are the acute case —
   * they sit exactly on a node's border, which is exactly where a drop lands.
   */
  it('takes the pointer off every wire surface while linking', () => {
    const rule = /\.canvas-mode\.linking[\s\S]*?\{([^}]*pointer-events\s*:\s*none[^}]*)\}/.exec(CSS);
    expect(rule).not.toBeNull();
    const head = CSS.slice(CSS.lastIndexOf('}', rule!.index) + 1, rule!.index + rule![0].indexOf('{'));
    for (const sel of ['.canvas-wire-handle', '.canvas-wire-badge', '.canvas-wire-hit']) {
      expect({ sel, inert: head.includes(`.canvas-mode.linking ${sel}`) })
        .toEqual({ sel, inert: true });
    }
  });

  /**
   * A selected wire must not be dimmed by the hover focus.
   *
   * `.canvas-wire.cold` is 12% opacity and has the same specificity as `.canvas-wire.selected`,
   * so the ONLY thing deciding the winner is source order. A selection nobody can see is one
   * the user believes they lost — and then Delete removes a connection they stopped looking at.
   */
  it('declares the selected rule after the cold one, so it wins on source order', () => {
    const cold = CSS.indexOf('.canvas-wire.cold');
    const selected = CSS.indexOf('.canvas-wire.selected');
    expect(cold).toBeGreaterThan(-1);
    expect(selected).toBeGreaterThan(-1);
    expect(selected).toBeGreaterThan(cold);
  });
});
