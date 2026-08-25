/**
 * What "close this node" resolves to — the decision half of Tam's request:
 * "add the close button on the top right of node terminal to close the terminal, always
 * confirm unless there is no process on it".
 *
 * Both of the ways this goes wrong are silent at the call site, which is why the decision is a
 * pure function with its own tests rather than three conditions inside a click handler.
 */
import { decideCanvasClose, closeEventFor, closeEndedRequests, CLOSE_EVENTS } from '../canvasClose';

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

describe('closeEndedRequests — the toolbar\'s Close Ended button', () => {
  const node = (terminalId: string, tabId: string, paneId: string) => ({ terminalId, tabId, paneId });
  /** No caller of this function ever passes a live terminal — `endedNodes` is pre-filtered by
   *  the caller — but the request must still ask, defensively, rather than assume. */
  const NONE_ALIVE = () => false;

  it('closes a lone ended node as its tab', () => {
    const out = closeEndedRequests([node('tm-1', 'tb-1', 'pn-1')], () => 1, NONE_ALIVE);
    expect(out).toEqual([{ kind: 'tab', targetId: 'tb-1', confirm: false }]);
  });

  /**
   * THE case a naive per-node loop gets wrong: two ended panes sharing a multi-pane tab. A loop
   * that re-used a pane count taken before either closed would route the second one down the
   * pane flow on what is by then the tab's last pane — the exact "tab-shaped hole"
   * `decideCanvasClose` exists to avoid. Deciding once per tab sidesteps it: both panes accounted
   * for, both ended, the tab closes as ONE request rather than two pane closes.
   */
  it('closes a tab whose every pane has ended as ONE tab request, not one per pane', () => {
    const out = closeEndedRequests(
      [node('tm-1', 'tb-1', 'pn-1'), node('tm-2', 'tb-1', 'pn-2')],
      () => 2,
      NONE_ALIVE,
    );
    expect(out).toEqual([{ kind: 'tab', targetId: 'tb-1', confirm: false }]);
  });

  /** The live sibling is never a member of `endedNodes`, so the ended count can never reach the
   *  tab's total pane count — the tab itself must never appear as a request. */
  it('closes only the ended pane when a tab has a live sibling, and leaves the tab alone', () => {
    const out = closeEndedRequests([node('tm-1', 'tb-1', 'pn-1')], () => 2, NONE_ALIVE);
    expect(out).toEqual([{ kind: 'pane', targetId: 'pn-1', confirm: false }]);
  });

  it('decides each tab independently', () => {
    const out = closeEndedRequests(
      [node('tm-1', 'tb-1', 'pn-1'), node('tm-2', 'tb-2', 'pn-2'), node('tm-3', 'tb-2', 'pn-3')],
      (tabId) => (tabId === 'tb-1' ? 1 : 2),
      NONE_ALIVE,
    );
    expect(out).toEqual([
      { kind: 'tab', targetId: 'tb-1', confirm: false },
      { kind: 'tab', targetId: 'tb-2', confirm: false },
    ]);
  });

  it('returns nothing for an empty list', () => {
    expect(closeEndedRequests([], () => 1, NONE_ALIVE)).toEqual([]);
  });

  /** A tab with no tree at all counts as zero panes, same as `decideCanvasClose` — and a lone
   *  node against zero panes must still resolve to closing the tab, not get stranded. */
  it('treats zero panes in the tree the same as one', () => {
    const out = closeEndedRequests([node('tm-1', 'tb-1', 'pn-1')], () => 0, NONE_ALIVE);
    expect(out).toEqual([{ kind: 'tab', targetId: 'tb-1', confirm: false }]);
  });

  /** Defensive, not reachable through the toolbar today: `isAlive` is still consulted per node
   *  rather than assumed false, so a caller that passes a live terminal still gets asked. */
  it('still asks isAlive rather than assuming every ended node is dead', () => {
    const paneOut = closeEndedRequests([node('tm-1', 'tb-1', 'pn-1')], () => 2, () => true);
    expect(paneOut).toEqual([{ kind: 'pane', targetId: 'pn-1', confirm: true }]);

    const tabOut = closeEndedRequests([node('tm-1', 'tb-1', 'pn-1')], () => 1, () => true);
    expect(tabOut).toEqual([{ kind: 'tab', targetId: 'tb-1', confirm: true }]);
  });
});
