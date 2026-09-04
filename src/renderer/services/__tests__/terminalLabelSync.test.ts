/**
 * @jest-environment jsdom
 *
 * Plan 028 §10.31. The picker's rows and every activity-log line show a terminal's NAME, and this
 * is the only thing that ever puts one there — the backend's `Terminal.name` is `Terminal-{shell}`
 * for every renderer-created terminal and has no live writer after spawn.
 *
 * Driven through the REAL reducers, like `paneOwnershipSync.test.ts` beside it, because the part
 * that regresses is nobody calling the diff, not the diff itself.
 */
import { configureStore } from '@reduxjs/toolkit';
import panesReducer, {
  addTabTree,
  insertPaneIntoTab,
  movePaneToTab,
  renamePanes,
  PaneNode,
} from '../../store/slices/panesSlice';
import tabsReducer, { addTab, updateTabTitle } from '../../store/slices/tabsSlice';
import { attachTerminalLabelSync, collectLeafLabels, reassertLabelAfterSpawn } from '../terminalLabelSync';
import { diffLeafValues } from '../leafValueDiff';

const leaf = (id: string, terminalId: string, name?: string): PaneNode => ({
  id,
  type: 'terminal',
  terminalId,
  ...(name ? { name } : {}),
});

const split = (id: string, children: PaneNode[]): PaneNode => ({
  id,
  type: 'split',
  direction: 'vertical',
  size: 50,
  children,
});

const makeStore = () => configureStore({ reducer: { panes: panesReducer, tabs: tabsReducer } });

const tab = (id: string, title: string) => addTab({ id, title, shellType: 'powershell' });

let setTerminalDisplayLabel: jest.Mock;
let store: ReturnType<typeof makeStore>;
let unsubscribe: () => void;

beforeEach(() => {
  setTerminalDisplayLabel = jest.fn().mockResolvedValue(undefined);
  (window as any).electronAPI = { setTerminalDisplayLabel };
  store = makeStore();
  unsubscribe = attachTerminalLabelSync(store as any);
});

afterEach(() => unsubscribe());

describe('attachTerminalLabelSync', () => {
  /**
   * THE case the reviewer caught in the ownership differ: a brand-new solo terminal that is never
   * split and never renamed. Suppressing its first push — which is what ownership does, correctly,
   * for itself — would leave it with no label for the life of the session, and that is most first
   * terminals.
   */
  it('pushes a brand-new solo terminal exactly once, with no split and no rename', () => {
    store.dispatch(tab('tb-solo', 'termflow-core'));
    store.dispatch(addTabTree({ tabId: 'tb-solo', tree: leaf('pn-solo', 'tm-solo') }));

    expect(setTerminalDisplayLabel).toHaveBeenCalledTimes(1);
    expect(setTerminalDisplayLabel).toHaveBeenCalledWith('tm-solo', 'termflow-core');
  });

  it('stays silent across ten unrelated dispatches once the label is settled', () => {
    store.dispatch(tab('tb-1', 'termflow-core'));
    store.dispatch(addTabTree({ tabId: 'tb-1', tree: leaf('pn-1', 'tm-1') }));
    setTerminalDisplayLabel.mockClear();

    for (let i = 0; i < 10; i += 1) {
      store.dispatch(updateTabTitle({ id: 'tb-1', title: 'termflow-core' }));
    }
    expect(setTerminalDisplayLabel).not.toHaveBeenCalled();
  });

  it('pushes once more when the tab is renamed, and only for that tab', () => {
    store.dispatch(tab('tb-a', 'core'));
    store.dispatch(tab('tb-b', 'docs'));
    store.dispatch(addTabTree({ tabId: 'tb-a', tree: leaf('pn-a', 'tm-a') }));
    store.dispatch(addTabTree({ tabId: 'tb-b', tree: leaf('pn-b', 'tm-b') }));
    setTerminalDisplayLabel.mockClear();

    store.dispatch(updateTabTitle({ id: 'tb-a', title: 'core · rebuilt' }));

    expect(setTerminalDisplayLabel).toHaveBeenCalledTimes(1);
    expect(setTerminalDisplayLabel).toHaveBeenCalledWith('tm-a', 'core · rebuilt');
  });

  /** A pane's own name outranks its tab's title — it is the more specific thing the user typed. */
  it('prefers a pane name over the tab title, and reverts when the pane name is cleared', () => {
    store.dispatch(tab('tb-s', 'core'));
    store.dispatch(
      addTabTree({
        tabId: 'tb-s',
        tree: split('pn-root', [leaf('pn-l', 'tm-l'), leaf('pn-r', 'tm-r')]),
      }),
    );
    setTerminalDisplayLabel.mockClear();

    store.dispatch(renamePanes({ paneId: 'pn-r', name: 'codex', tabId: 'tb-s' }));
    expect(setTerminalDisplayLabel).toHaveBeenCalledTimes(1);
    expect(setTerminalDisplayLabel).toHaveBeenCalledWith('tm-r', 'codex');

    setTerminalDisplayLabel.mockClear();
    store.dispatch(renamePanes({ paneId: 'pn-r', name: '', tabId: 'tb-s' }));
    expect(setTerminalDisplayLabel).toHaveBeenCalledWith('tm-r', 'core');
  });

  /**
   * A moved pane inherits its NEW tab's title. This is the case a lifecycle hook misses entirely —
   * the pane already has a mapping, so `TerminalPane` takes its reuse path and never re-binds.
   */
  it('re-labels a pane dragged into another tab', () => {
    store.dispatch(tab('tb-src', 'core'));
    store.dispatch(tab('tb-dst', 'docs'));
    store.dispatch(
      addTabTree({
        tabId: 'tb-src',
        tree: split('pn-src-root', [leaf('pn-src-a', 'tm-stay'), leaf('pn-src-b', 'tm-move')]),
      }),
    );
    store.dispatch(addTabTree({ tabId: 'tb-dst', tree: leaf('pn-dst', 'tm-dst') }));
    setTerminalDisplayLabel.mockClear();

    store.dispatch(
      movePaneToTab({
        sourceTabId: 'tb-src',
        sourcePaneId: 'pn-src-b',
        targetTabId: 'tb-dst',
        targetPaneId: 'pn-dst',
        zone: 'right',
      }),
    );

    expect(setTerminalDisplayLabel).toHaveBeenCalledTimes(1);
    expect(setTerminalDisplayLabel).toHaveBeenCalledWith('tm-move', 'docs');
  });

  /** A pane arriving from another window carries its old tab's label until this fires. */
  it('labels a cross-window drop with the receiving tab title', () => {
    store.dispatch(tab('tb-here', 'window B'));
    store.dispatch(addTabTree({ tabId: 'tb-here', tree: leaf('pn-here', 'tm-here') }));
    setTerminalDisplayLabel.mockClear();

    store.dispatch(
      insertPaneIntoTab({
        tabId: 'tb-here',
        targetPaneId: 'pn-here',
        zone: 'right',
        node: leaf('pn-incoming', 'tm-fromOtherWindow'),
      }),
    );

    expect(setTerminalDisplayLabel).toHaveBeenCalledWith('tm-fromOtherWindow', 'window B');
  });

  /** A tree committed before its tab exists must not push an empty label the backend would store. */
  it('pushes nothing for a leaf whose tab has no title yet', () => {
    store.dispatch(addTabTree({ tabId: 'tb-orphan', tree: leaf('pn-o', 'tm-o') }));
    expect(setTerminalDisplayLabel).not.toHaveBeenCalled();

    store.dispatch(tab('tb-orphan', 'arrived'));
    expect(setTerminalDisplayLabel).toHaveBeenCalledWith('tm-o', 'arrived');
  });
});

describe('reassertLabelAfterSpawn', () => {
  /**
   * The race `reassertOwnerAfterSpawn` closes for ownership, which bites labels harder: the owner
   * is at least sent as a spawn parameter, so its re-assert only corrects a move. No label is sent
   * at spawn, so a terminal whose create returned after the subscription already advanced its map
   * would have no label at all.
   */
  it('re-sends the current label after the create returns', () => {
    store.dispatch(tab('tb-a', 'core'));
    store.dispatch(addTabTree({ tabId: 'tb-a', tree: leaf('pn-1', 'tm-x') }));
    setTerminalDisplayLabel.mockClear();

    reassertLabelAfterSpawn('tm-x');

    expect(setTerminalDisplayLabel).toHaveBeenCalledWith('tm-x', 'core');
  });

  it('sends nothing for a leaf this window does not hold', () => {
    store.dispatch(tab('tb-a', 'core'));
    store.dispatch(addTabTree({ tabId: 'tb-a', tree: leaf('pn-1', 'tm-x') }));
    setTerminalDisplayLabel.mockClear();

    reassertLabelAfterSpawn('tm-gone');

    expect(setTerminalDisplayLabel).not.toHaveBeenCalled();
  });
});

describe('collectLeafLabels', () => {
  it('walks nested splits and skips split nodes and leafless panes', () => {
    const trees = {
      'tb-1': split('r', [
        leaf('a', 'tm-a'),
        split('r2', [leaf('b', 'tm-b', 'codex'), { id: 'c', type: 'terminal' } as PaneNode]),
      ]),
      'tb-2': null,
    };
    const labels = collectLeafLabels(trees, [
      { id: 'tb-1', title: 'core' },
      { id: 'tb-2', title: 'empty' },
    ]);
    expect([...labels.entries()]).toEqual([
      ['tm-a', 'core'],
      ['tm-b', 'codex'],
    ]);
  });

  /** A whitespace-only pane name is not a name — it must fall through, never be pushed. */
  it('treats a whitespace-only pane name as absent', () => {
    const labels = collectLeafLabels({ 'tb-1': leaf('a', 'tm-a', '   ') }, [
      { id: 'tb-1', title: 'core' },
    ]);
    expect(labels.get('tm-a')).toBe('core');
  });
});

/**
 * The extraction itself. `paneOwnership`'s own suite proves the wrapper is behaviour-preserving;
 * these are the two properties the wrapper and `terminalLabelSync` disagree about, so neither
 * caller's suite can cover both.
 */
describe('diffLeafValues', () => {
  it('honours the first-sight predicate in both directions', () => {
    const next = new Map([['tm-a', 'x']]);
    expect(diffLeafValues(null, next, () => true)).toEqual([{ rendererTerminalId: 'tm-a', value: 'x' }]);
    expect(diffLeafValues(null, next, () => false)).toEqual([]);
  });

  it('reports a changed value even when first sight would be suppressed', () => {
    const previous = new Map([['tm-a', 'x']]);
    const next = new Map([['tm-a', 'y']]);
    expect(diffLeafValues(previous, next, () => false)).toEqual([
      { rendererTerminalId: 'tm-a', value: 'y' },
    ]);
  });

  it('reports nothing for an unchanged value or a leaf that disappeared', () => {
    const previous = new Map([
      ['tm-a', 'x'],
      ['tm-gone', 'x'],
    ]);
    expect(diffLeafValues(previous, new Map([['tm-a', 'x']]), () => true)).toEqual([]);
  });
});
