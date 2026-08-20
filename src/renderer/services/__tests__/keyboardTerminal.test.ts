/**
 * `plan/021` R2 — where globally-dispatched text goes.
 *
 * The bug these pin: `InputHandler`'s paste and clear-terminal actions resolved their target
 * by walking the pane tree for `panes.activePaneId`. Canvas Mode is a TAB, so while it is open
 * that walk reaches a tab the user is not looking at — the clipboard went nowhere, or into
 * some other terminal entirely.
 */
import { resolveKeyboardTerminalId, KeyboardTerminalState } from '../keyboardTerminal';
import type { PaneNode } from '../../store/slices/panesSlice';

/** A split tab: two panes, `pane-b` focused. */
const TREE: PaneNode = {
  id: 'root',
  type: 'split',
  direction: 'horizontal',
  children: [
    { id: 'pane-a', type: 'terminal', terminalId: 'tm-a' },
    { id: 'pane-b', type: 'terminal', terminalId: 'tm-b' },
  ],
};

const TABS = [
  { id: 'tb-work', shellType: 'pwsh' },
  { id: 'tb-canvas', shellType: 'canvas' },
  { id: 'tb-settings', shellType: 'settings' },
];

function state(over: {
  activePaneId?: string | null;
  paneTree?: PaneNode | null;
  focusedId?: string | null;
  activeTabId?: string | null;
}): KeyboardTerminalState {
  return {
    panes: {
      activePaneId: over.activePaneId === undefined ? 'pane-b' : over.activePaneId,
      paneTree: over.paneTree === undefined ? TREE : over.paneTree,
    },
    canvas: { focusedId: over.focusedId ?? null },
    tabs: { activeTabId: over.activeTabId ?? 'tb-work', tabs: TABS },
  };
}

describe('resolveKeyboardTerminalId', () => {
  it('resolves the active pane in an ordinary tab', () => {
    expect(resolveKeyboardTerminalId(state({}))).toBe('tm-b');
    expect(resolveKeyboardTerminalId(state({ activePaneId: 'pane-a' }))).toBe('tm-a');
  });

  it('resolves the FOCUSED CANVAS NODE while Canvas Mode is on screen', () => {
    // The regression. Note the pane tree still says `tm-b` — the assertion is that the canvas
    // wins, not merely that something non-null comes back.
    const s = state({ activeTabId: 'tb-canvas', focusedId: 'tm-a' });
    expect(resolveKeyboardTerminalId(s)).toBe('tm-a');
    expect(resolveKeyboardTerminalId(s)).not.toBe('tm-b');
  });

  it('resolves nothing when the canvas is up with no node focused', () => {
    // No fall-through: the keyboard is in no terminal, and delivering the clipboard to the
    // pane tree would put it in a terminal the user cannot see.
    expect(resolveKeyboardTerminalId(state({ activeTabId: 'tb-canvas', focusedId: null })))
      .toBeNull();
  });

  it('ignores a stale canvas focus once another tab is on screen', () => {
    // `CanvasMode` clears `focusedId` on unmount, but this must not DEPEND on that: the
    // question is what the user can see, and its sibling `overlayId` deliberately survives
    // the same round trip (`plan/020` §4).
    expect(resolveKeyboardTerminalId(state({ activeTabId: 'tb-work', focusedId: 'tm-a' })))
      .toBe('tm-b');
  });

  it('is not fooled by another virtual tab', () => {
    // Settings is virtual too, and it is NOT the canvas — so a remembered canvas focus must not
    // be handed out while Settings is on screen.
    //
    // The pane state here is the one Settings actually produces, and getting that right is the
    // point: virtual tabs are never seeded into `treesByTabId`, and `setActiveTabId` mirrors
    // `paneTree` from that map, so BOTH pane fields are null — exactly as they are for the
    // canvas. A fixture that left the pane tree populated would assert an answer (`tm-b`) that
    // production can never produce, and would quietly stop guarding anything.
    const s = state({ activeTabId: 'tb-settings', focusedId: 'tm-a', activePaneId: null, paneTree: null });
    expect(resolveKeyboardTerminalId(s)).toBeNull();
    expect(resolveKeyboardTerminalId(s)).not.toBe('tm-a');
  });

  it('resolves nothing without an active pane or a tree', () => {
    expect(resolveKeyboardTerminalId(state({ activePaneId: null }))).toBeNull();
    expect(resolveKeyboardTerminalId(state({ paneTree: null }))).toBeNull();
  });

  it('resolves nothing when the active pane is not in the tree', () => {
    expect(resolveKeyboardTerminalId(state({ activePaneId: 'pane-gone' }))).toBeNull();
  });

  it('resolves a solo root pane', () => {
    const solo: PaneNode = { id: 'root', type: 'terminal', terminalId: 'tb-1' };
    expect(resolveKeyboardTerminalId(state({ paneTree: solo, activePaneId: 'root' })))
      .toBe('tb-1');
  });
});
