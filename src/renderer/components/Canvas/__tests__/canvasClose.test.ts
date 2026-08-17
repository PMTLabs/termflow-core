/**
 * What "close this node" resolves to — the decision half of Tam's request:
 * "add the close button on the top right of node terminal to close the terminal, always
 * confirm unless there is no process on it".
 *
 * Both of the ways this goes wrong are silent at the call site, which is why the decision is a
 * pure function with its own tests rather than three conditions inside a click handler.
 */
import { decideCanvasClose, closeEventFor, CLOSE_EVENTS } from '../canvasClose';

const NODE = { terminalId: 'tm-1', tabId: 'tb-1', paneId: 'pn-1' };

/** Nothing is alive. Written as a named constant so a test that means "no process" cannot be
 *  read as "the default". */
const DEAD = () => false;
const LIVE = () => true;

describe('pane close vs tab close', () => {
  /**
   * The one that eats a tab.
   *
   * `panesSlice.closePane` special-cases the root: `state.paneTree = null`. So sending a solo
   * node down the pane path does not close "the pane" — it empties the tab and leaves a strip
   * entry with no terminal in it and no way to get one back. The canvas is where this is easy
   * to hit, because it draws every tab's panes as one field of identical nodes and nothing on
   * screen distinguishes a tab's only pane from one of four.
   */
  it('routes a tab\'s only pane to the TAB flow', () => {
    expect(decideCanvasClose(NODE, 1, LIVE).kind).toBe('tab');
    // A tab with no tree at all — a never-split tab before `TerminalContainer` seeds it —
    // counts as zero panes and must land in the same place, not in a third state.
    expect(decideCanvasClose(NODE, 0, LIVE).kind).toBe('tab');
  });

  it('routes one of several panes to the PANE flow', () => {
    expect(decideCanvasClose(NODE, 2, LIVE).kind).toBe('pane');
    expect(decideCanvasClose(NODE, 7, LIVE).kind).toBe('pane');
  });

  /** The id the event carries is not the same field for the two flows, and the wrong one is a
   *  no-op rather than a crash: `PaneManager`'s tree guard simply never matches, so the click
   *  does nothing at all. */
  it('carries the id its flow is keyed on', () => {
    expect(decideCanvasClose(NODE, 3, LIVE).targetId).toBe('pn-1');
    expect(decideCanvasClose(NODE, 1, LIVE).targetId).toBe('tb-1');
  });
});

describe('confirm unless there is no process', () => {
  it('asks when the terminal is alive and does not when it is dead', () => {
    expect(decideCanvasClose(NODE, 2, LIVE).confirm).toBe(true);
    expect(decideCanvasClose(NODE, 2, DEAD).confirm).toBe(false);
    // Independent of which flow it took — a dead solo terminal must not be confirmed either.
    expect(decideCanvasClose(NODE, 1, DEAD).confirm).toBe(false);
  });

  /**
   * The trap this exists for: `CanvasNodeModel.isRunning` is right there on the node and is
   * projected from `tab.isRunning` (`buildModel` says so). On a split tab every node carries
   * the same value, so a close button reading it would confirm for a dead pane whenever any
   * SIBLING was busy, and skip the confirm on a live pane whose tab looked idle.
   *
   * Asserting the ARGUMENT, not just the result: passing `tabId` here would give exactly the
   * same booleans above under a stub that ignores its input.
   */
  it('asks about this terminal, not this tab', () => {
    const asked: string[] = [];
    decideCanvasClose(NODE, 2, (id) => { asked.push(id); return true; });
    expect(asked).toEqual(['tm-1']);
  });
});

describe('the event a decision becomes', () => {
  it('maps all four combinations', () => {
    const ev = (panes: number, alive: boolean) =>
      closeEventFor(decideCanvasClose(NODE, panes, alive ? LIVE : DEAD));

    expect(ev(2, true)).toEqual({ type: 'ui:requestPaneClose', detail: { paneId: 'pn-1' } });
    expect(ev(2, false)).toEqual({ type: 'ui:forcePaneClose', detail: { paneId: 'pn-1' } });
    expect(ev(1, true)).toEqual({ type: 'ui:requestTabClose', detail: { tabId: 'tb-1' } });
    expect(ev(1, false)).toEqual({ type: 'ui:forceTabClose', detail: { tabId: 'tb-1' } });
  });

  /**
   * The detail KEY differs between the flows, and a mapping that hard-coded `paneId` would
   * pass every `type` assertion above while delivering a payload no listener reads. The four
   * event names are equally load-bearing: three of them are pre-existing contracts owned by
   * `PaneManager`, `TabManager` and `App`, so a typo is not caught by a compiler.
   */
  it('names the key each listener actually reads', () => {
    expect(CLOSE_EVENTS.pane.idKey).toBe('paneId');
    expect(CLOSE_EVENTS.tab.idKey).toBe('tabId');
    expect(Object.keys(closeEventFor(decideCanvasClose(NODE, 5, LIVE)).detail)).toEqual(['paneId']);
    expect(Object.keys(closeEventFor(decideCanvasClose(NODE, 1, LIVE)).detail)).toEqual(['tabId']);
  });
});
