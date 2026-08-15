/**
 * @jest-environment jsdom
 *
 * Wiring for review 099 T2-F2: dispatching a real reparent through the real
 * pane reducers must tell the backend the pane's new owning tab. The sibling
 * suite (paneOwnership.test.ts) covers the diff rules in isolation; this covers
 * the part that actually regressed — nobody calling them.
 */
import { configureStore } from '@reduxjs/toolkit';
import panesReducer, {
  addTabTree,
  insertPaneIntoTab,
  movePaneToTab,
  PaneNode,
} from '../../store/slices/panesSlice';
import { attachPaneOwnershipSync } from '../paneOwnership';

const leaf = (id: string, terminalId: string): PaneNode => ({ id, type: 'terminal', terminalId });

const split = (id: string, children: PaneNode[]): PaneNode => ({
  id,
  type: 'split',
  direction: 'vertical',
  size: 50,
  children,
});

const makeStore = () => configureStore({ reducer: { panes: panesReducer } });

let setTerminalOwningTab: jest.Mock;
let store: ReturnType<typeof makeStore>;
let unsubscribe: () => void;

beforeEach(() => {
  setTerminalOwningTab = jest.fn().mockResolvedValue(undefined);
  (window as any).electronAPI = { setTerminalOwningTab };
  // No pane is bound to a live PTY in this window unless a test says otherwise.
  (window as any).terminalService = { getProcessId: () => undefined };
  store = makeStore();
  unsubscribe = attachPaneOwnershipSync(store as any);
});

afterEach(() => unsubscribe());

describe('attachPaneOwnershipSync', () => {
  it('reports a same-window drag of a split pane into another tab', () => {
    store.dispatch(addTabTree({
      tabId: 'tb-drag-src',
      tree: split('pn-src-root', [leaf('pn-src-a', 'tb-drag-src'), leaf('pn-src-b', 'tm-dragged')]),
    }));
    store.dispatch(addTabTree({ tabId: 'tb-drag-dst', tree: leaf('pn-dst', 'tb-drag-dst') }));
    expect(setTerminalOwningTab).not.toHaveBeenCalled();

    // Exactly what PaneDragController.commitDrop dispatches on a cross-tab drop.
    store.dispatch(movePaneToTab({
      sourceTabId: 'tb-drag-src',
      sourcePaneId: 'pn-src-b',
      targetTabId: 'tb-drag-dst',
      targetPaneId: 'pn-dst',
      zone: 'right',
    }));

    expect(setTerminalOwningTab).toHaveBeenCalledTimes(1);
    expect(setTerminalOwningTab).toHaveBeenCalledWith('tm-dragged', 'tb-drag-dst');
  });

  it('reports a cross-window drop, whose pane is attached before it is inserted', () => {
    // applyCrossWindowPayload attaches the live PTY first, THEN dispatches — that
    // binding is how this window tells an incoming pane from a fresh split.
    (window as any).terminalService = {
      getProcessId: (id: string) => (id === 'tm-fromOtherWindow' ? 'pc-live' : undefined),
    };
    store.dispatch(addTabTree({ tabId: 'tb-window-b', tree: leaf('pn-wb', 'tb-window-b') }));
    expect(setTerminalOwningTab).not.toHaveBeenCalled();

    store.dispatch(insertPaneIntoTab({
      tabId: 'tb-window-b',
      targetPaneId: 'pn-wb',
      zone: 'right',
      node: leaf('pn-incoming', 'tm-fromOtherWindow'),
    }));

    expect(setTerminalOwningTab).toHaveBeenCalledTimes(1);
    expect(setTerminalOwningTab).toHaveBeenCalledWith('tm-fromOtherWindow', 'tb-window-b');
  });

  it('stays quiet when a tab tree changes without any pane changing tab', () => {
    store.dispatch(addTabTree({ tabId: 'tb-quiet', tree: leaf('pn-q', 'tb-quiet') }));
    store.dispatch(addTabTree({
      tabId: 'tb-quiet',
      tree: split('pn-q-root', [leaf('pn-q', 'tb-quiet'), leaf('pn-q2', 'tm-new-split')]),
    }));
    expect(setTerminalOwningTab).not.toHaveBeenCalled();
  });

  it('never fires twice for the same move', () => {
    store.dispatch(addTabTree({
      tabId: 'tb-once-src',
      tree: split('pn-o-root', [leaf('pn-o-a', 'tb-once-src'), leaf('pn-o-b', 'tm-once')]),
    }));
    store.dispatch(addTabTree({ tabId: 'tb-once-dst', tree: leaf('pn-o-dst', 'tb-once-dst') }));
    store.dispatch(movePaneToTab({
      sourceTabId: 'tb-once-src',
      sourcePaneId: 'pn-o-b',
      targetTabId: 'tb-once-dst',
      targetPaneId: 'pn-o-dst',
      zone: 'bottom',
    }));
    // A later, unrelated tree change must not re-announce the settled owner.
    store.dispatch(addTabTree({ tabId: 'tb-unrelated', tree: leaf('pn-u', 'tb-unrelated') }));

    expect(setTerminalOwningTab).toHaveBeenCalledTimes(1);
  });
});
