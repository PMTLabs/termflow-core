/**
 * Editing a connection — the parts with no pure form.
 *
 * Tam: "when I connect the terminal to each other, I cannot change it, so allow user to change
 * the connection point across the terminal so I can reconnect the point to other terminal, or
 * user can click on the connection line and then delete it if they want."
 *
 * The DECISIONS are pure and tested elsewhere: `reconnectPair` and `anchorOf` in
 * `wireGeometry.test.ts`, the `delete-edge` routing in `canvasGestures.test.ts`, the selection
 * invariant in `canvasSlice.test.ts`, and the create-before-delete order in `canvasGraph.test.ts`.
 * What is left here is what only exists as code — which DOM attribute one file writes and
 * another reads, which handler runs first, and whether a control is wired to anything at all.
 *
 * Every match runs against source with comments stripped, for the reason `canvasCloseWiring`
 * records: three tests in this plan have now been satisfied by their own explanatory prose.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

const CANVAS = path.resolve(__dirname, '..');

function code(file: string): string {
  return readSource(path.join(CANVAS, file))
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const MODE = code('CanvasMode.tsx');
const WIRES = code('CanvasWires.tsx');
const DRAG = code('useWireDrag.ts');
const VIEWPORT = code('CanvasViewport.tsx');
const FRAME = code('CanvasGroupFrame.tsx');

/** One `<CanvasWires ... />` element, from its tag to the `/>` that closes it. */
const WIRES_PROPS = (() => {
  const at = MODE.indexOf('<CanvasWires');
  return at < 0 ? '' : MODE.slice(at, MODE.indexOf('/>', at));
})();

/** A single arrow callback, from `const <name> = useCallback(` to the line that closes it. */
function callback(src: string, name: string): string {
  const i = src.indexOf(`const ${name} = useCallback(`);
  return i < 0 ? '' : src.slice(i, src.indexOf('\n  }, [', i));
}

describe('found the source it is reading', () => {
  /** Or every assertion below passes vacuously against an empty string. */
  it('sliced the element and the callbacks it asserts about', () => {
    expect(WIRES_PROPS.startsWith('<CanvasWires')).toBe(true);
    expect(WIRES_PROPS).toContain('edges={edges}');
    expect(callback(MODE, 'dropEdge')).toContain('deleteEdge');
    expect(callback(DRAG, 'onPointerDownCapture')).toContain('startFrom');
  });
});

/**
 * The handle's DOM contract, read from both ends.
 *
 * `CanvasWires` writes `data-edge-id` and `data-end` onto each handle; `useWireDrag` reads them
 * back out with `getAttribute`. Nothing type-checks that pair — a rename on either side leaves a
 * handle that renders, looks grabbable, and starts no drag at all. So the test is the join.
 */
describe('the endpoint handles say what the drag reads', () => {
  it('writes the two attributes the drag looks for', () => {
    expect(WIRES).toContain('className="canvas-wire-handle"');
    expect(WIRES).toContain('data-edge-id={picked.edge.id}');
    expect(WIRES).toContain('data-end={end}');
  });

  it('reads back exactly those attributes', () => {
    expect(DRAG).toContain(".closest('.canvas-wire-handle')");
    expect(DRAG).toContain("getAttribute('data-edge-id')");
    expect(DRAG).toContain("getAttribute('data-end')");
  });

  /** Only `'from'` and `'to'` are legal, and an attribute is a string from the DOM rather than
   *  a typed value — a third spelling would silently become an anchor of `undefined`. */
  it('refuses an end it does not recognise', () => {
    expect(DRAG).toContain("end !== 'from' && end !== 'to'");
  });

  it('renders a handle for each end, named for the edge\'s own fields', () => {
    expect(WIRES).toContain("[['from', picked.ends.p1], ['to', picked.ends.p2]]");
  });
});

/**
 * The handle is tested BEFORE the port, and that order is the whole reason both gestures can
 * share one capture handler.
 *
 * Handles are drawn above the nodes and their ports (see `canvasWireStacking`), so a handle
 * sitting over a port is normal — an endpoint lands on the middle of a node's face, which is
 * exactly where that face's port dot is. Testing the port first would hand every such press to
 * "draw a new wire", and re-pointing a connection would be impossible on precisely the
 * arrangement it is most often needed for.
 */
describe('a press on a handle is not a press on a port', () => {
  it('resolves the handle first', () => {
    const start = callback(DRAG, 'onPointerDownCapture');
    const handle = start.indexOf('startFromHandle(');
    const port = start.indexOf('startFromPort(');
    expect(handle).toBeGreaterThan(-1);
    expect(port).toBeGreaterThan(-1);
    expect(handle).toBeLessThan(port);
  });

  /**
   * A handle press that never moved must do NOTHING.
   *
   * The same non-moved branch on a port opens the shell-profile menu and spawns a terminal
   * (item 4). Falling through to it here would mean tapping a connection you had just selected
   * created a new shell — the most surprising outcome available on this surface.
   */
  it('never opens the spawn menu from a handle', () => {
    const guard = DRAG.indexOf('if (!l.reconnect) {');
    const spawn = DRAG.indexOf('onPortClickRef.current?.(');
    expect(guard).toBeGreaterThan(-1);
    expect(spawn).toBeGreaterThan(guard);
  });
});

/**
 * What the drop does with the server's answer.
 *
 * `reconnectEdge` reports whether the old row was really deleted. Dropping it from the mirror
 * unconditionally would hide a connection the server still holds — invisible for the rest of the
 * session, and back on the canvas after the next restart with nothing to explain it.
 */
describe('the reconnect drop follows the server', () => {
  it('removes the old row only when the server removed it', () => {
    expect(DRAG).toContain('if (done.removedId) dispatch(removeEdge(done.removedId));');
    expect(DRAG).toContain('dispatch(addEdge(done.edge));');
  });

  it('refuses a drop the pure rule refused', () => {
    // `reconnectPair` returns null for a self-edge and for a drop that changed nothing. Either
    // one continuing into `reconnectEdge` would delete a wire the user still wants.
    const pair = DRAG.indexOf('const pair = reconnectPair(edge, end, to);');
    const bail = DRAG.indexOf('if (!pair) return;');
    const call = DRAG.indexOf('reconnectEdge(edge, pair.from, pair.to)');
    expect(pair).toBeGreaterThan(-1);
    expect(bail).toBeGreaterThan(pair);
    expect(call).toBeGreaterThan(bail);
  });

  /** The selection follows the wire, or the handles vanish mid-adjustment and a second nudge
   *  needs a fresh click on a line that just moved. */
  it('keeps the moved connection selected', () => {
    expect(DRAG).toContain('dispatch(selectEdge(done.edge.id));');
  });
});

/** Clicking the line selects it; the three ways to delete all go through one place. */
describe('the connection is selectable and deletable', () => {
  it('selects on a click on the hit band', () => {
    expect(WIRES).toContain('className="canvas-wire-hit"');
    expect(WIRES).toContain('onClick={() => onWireClick?.(w.edge)}');
    expect(WIRES_PROPS).toContain('onWireClick={(edge) => dispatch(selectEdge(edge.id))}');
  });

  it('draws the hit band for every wire, not only when a menu handler is passed', () => {
    // It used to be conditional on `onWireContextMenu`. With the click carrying the selection,
    // a wire without that prop would be a wire that cannot be selected at all.
    expect(WIRES).not.toContain('onWireContextMenu && wires.map');
  });

  it('wires the delete badge to the same removal the key uses', () => {
    expect(WIRES).toContain('className="canvas-wire-badge"');
    expect(WIRES).toContain('onClick={() => onWireDelete?.(picked.edge)}');
    expect(WIRES_PROPS).toContain('onWireDelete={(edge) => dropEdge(edge.id)}');
    expect(MODE).toContain("case 'delete-edge': dropEdge(selectedEdgeId!); break;");
  });

  /** The store is touched only once the server has forgotten the row — the same rule the
   *  reconnect drop follows, for the same reason. */
  it('removes from the mirror only after the server confirms', () => {
    const drop = callback(MODE, 'dropEdge');
    expect(drop).toContain('void deleteEdge(id).then((ok) => {');
    expect(drop).toContain('if (ok) dispatch(removeEdge(id));');
  });

  it('reads both selection flags into the resolver', () => {
    expect(MODE).toContain('{ node: !!selectedId, edge: !!selectedEdgeId }');
  });
});

/**
 * A press on a wire or its controls is not a press on empty canvas.
 *
 * `CanvasViewport` treats anything not in `BACKGROUND_BAIL` as background: it starts a pan and
 * dispatches `clearSelection`. A wire left out of that list would be selected by the click and
 * deselected by the same press — a connection that cannot be selected at all, with no error
 * anywhere to say why.
 */
describe('the wire controls are not background', () => {
  it('bails on the hit band and on both controls', () => {
    const bail = /const BACKGROUND_BAIL =([\s\S]*?);/.exec(VIEWPORT)?.[1] ?? '';
    expect(bail).toContain('.canvas-node');            // found the real constant
    for (const sel of ['.canvas-wire-hit', '.canvas-wire-handle', '.canvas-wire-badge']) {
      expect({ sel, listed: bail.includes(sel) }).toEqual({ sel, listed: true });
    }
  });

  it('names classes the wires actually render', () => {
    // The join again: `BACKGROUND_BAIL` is matched with `closest`, so a class that no longer
    // exists is a silent no-op rather than an error.
    for (const sel of ['canvas-wire-hit', 'canvas-wire-handle', 'canvas-wire-badge']) {
      expect({ sel, rendered: WIRES.includes(`"${sel}"`) }).toEqual({ sel, rendered: true });
    }
  });
});

/**
 * The controls are authored in screen pixels inside a counter-scaled group.
 *
 * `r` and `transform` are SVG attributes, so the `--node-chrome-k` variable the stylesheet uses
 * everywhere else cannot reach them — the scale has to arrive as a number. Without it the
 * handles are a speck at one end of the zoom range and a dinner plate at the other.
 */
describe('the controls hold their size on screen', () => {
  it('takes the counter-scale as a prop and applies it to every control', () => {
    expect(WIRES_PROPS).toContain('chromeK={chromeScale(vp.z)}');
    expect(WIRES).toContain('scale(${chromeK})');
    // Both handles and the badge, or one of them scales with the world.
    expect(WIRES.match(/scale\(\$\{chromeK\}\)/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('steps the label aside for the badge by the same scale', () => {
    expect(WIRES).toContain('w.mid[1] - (w.selected ? LABEL_LIFT * chromeK : 0)');
  });
});

/**
 * Everything that POINTS AT a node uses its drawn box, not the slot the layout gave it.
 *
 * A node draws `headSlack(z)` shorter than its `rect` above zoom 1 (`paintedNodeH`), and two of
 * Tam's reports were consumers that did not know. This is the join between the one definition
 * and its users, and nothing type-checks it: `Rect` in, `Rect` out, and a caller passing the
 * layout rect compiles and renders and is wrong by twenty world units.
 */
describe('the node draws where the geometry says it does', () => {
  const NODE = code('CanvasNode.tsx');

  /** The node itself must not restate the arithmetic, or the definition it is supposed to be
   *  the source of stops being one. */
  it('takes its own height from paintedNodeH', () => {
    expect(NODE).toContain('const nodeH = paintedNodeH(h, zoom, isChip);');
    expect(NODE).toContain('height: nodeH,');
    // The chip branch moved INTO the function; a second one here would shadow it.
    expect(NODE).not.toContain('isChip ? CHIP_H : nodeH');
  });

  /**
   * Tam: "at a certain zoom level, the connection point doesn't touch the terminal at the
   * bottom." `portPoint(r, 's')` returns `rect.y + rect.h`, so the fix is upstream of the wire
   * code entirely — feed it the drawn box and all four faces land on the node.
   */
  it('builds the wire and mask maps from the drawn box', () => {
    expect(MODE).toContain('const box = paintedNodeRect(n.rect, vp.z, tiers[n.terminalId] === \'chip\');');
    expect(MODE).toContain('all[n.terminalId] = box;');
    expect(MODE).toContain('painted[n.terminalId] = box;');
    // Both maps, or the 30% ghost is masked to a taller rectangle than the node it is over.
    expect(MODE).not.toContain('all[n.terminalId] = n.rect;');
  });

  /** The drag's ghost has to start where the wire it creates will, so it takes the SAME map
   *  rather than reaching into the model for a layout rect. */
  it('gives the drag the same rects the wires are drawn from', () => {
    expect(MODE).toContain('useWireDrag(wireRects,');
    expect(DRAG).toContain('const rectOf = (id: string) => latest.current.rects[id];');
    expect(DRAG).not.toContain('model.nodes.find');
  });
});

/**
 * The group frame paints on its DRAWN rect — Tam's second report, three screenshots of one
 * group at three zooms.
 *
 * The rule itself is pure and tested in `canvasLayout.test.ts`; this is only that the component
 * uses it, and uses it for all four numbers. Applying it to `left`/`top` alone would move the
 * border without resizing it, which is a frame that has slid off its own terminals.
 */
describe('the frame is painted on the drawn rect', () => {
  it('positions and sizes from drawnFrameRect', () => {
    expect(FRAME).toContain('const box = drawnFrameRect(group.rect, zoom);');
    expect(FRAME).toContain('style={{ left: box.x, top: box.y, width: box.w, height: box.h }}');
  });

  /** The chip is a different element with a different job: it counter-scales as a whole and is
   *  anchored to the group's world corner, so the padding rule has nothing to say about it. */
  it('leaves the collapsed chip anchored to the layout rect', () => {
    expect(FRAME).toContain('left: x + (chipOffset?.dx ?? 0)');
    expect(FRAME.indexOf('const box = drawnFrameRect'))
      .toBeGreaterThan(FRAME.indexOf('left: x + (chipOffset?.dx ?? 0)'));
  });
});
