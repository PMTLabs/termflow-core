/** @jest-environment jsdom */
import { configureStore } from '@reduxjs/toolkit';
import panesReducer, { addTabTree, type PaneNode } from '../../store/slices/panesSlice';
import tabsReducer, { addTab, setTabTitleColor } from '../../store/slices/tabsSlice';
import {
  attachTerminalTitleColorSync,
  collectLeafTitleColors,
} from '../terminalTitleColorSync';

const leaf = (id: string, terminalId: string): PaneNode => ({ id, type: 'terminal', terminalId });
const makeStore = () => configureStore({ reducer: { panes: panesReducer, tabs: tabsReducer } });

describe('collectLeafTitleColors', () => {
  it('maps every coloured and uncoloured tab leaf to its tab colour or an explicit empty clear', () => {
    const colors = collectLeafTitleColors({
      'tb-red': leaf('pn-red', 'tm-red'),
      'tb-blue': leaf('pn-blue', 'tm-blue'),
      'tb-none': leaf('pn-none', 'tm-none'),
    }, [
      { id: 'tb-red', titleColor: '#ef4444' },
      { id: 'tb-blue', titleColor: '#3b82f6' },
      { id: 'tb-none' },
    ]);

    expect([...colors.entries()]).toEqual([
      ['tm-red', '#ef4444'],
      ['tm-blue', '#3b82f6'],
      ['tm-none', ''],
    ]);
  });

  it('omits a leaf that left this window rather than spelling its departure as a clear', () => {
    const colors = collectLeafTitleColors({ 'tb-here': leaf('pn-here', 'tm-here') }, [
      { id: 'tb-here', titleColor: '#8b5cf6' },
      { id: 'tb-left', titleColor: '#f97316' },
    ]);

    expect(colors.has('tm-left')).toBe(false);
    expect(colors.get('tm-here')).toBe('#8b5cf6');
  });
});

describe('attachTerminalTitleColorSync', () => {
  let setTerminalTitleColor: jest.Mock;
  let unsubscribe: () => void;

  beforeEach(() => {
    setTerminalTitleColor = jest.fn().mockResolvedValue(undefined);
    (window as any).electronAPI = { setTerminalTitleColor };
  });

  afterEach(() => unsubscribe?.());

  it('pushes only leaves whose colour changed, including an explicit empty-string clear', () => {
    const store = makeStore();
    unsubscribe = attachTerminalTitleColorSync(store as any);
    store.dispatch(addTab({ id: 'tb-a', title: 'A', shellType: 'bash', titleColor: '#ef4444' }));
    store.dispatch(addTab({ id: 'tb-b', title: 'B', shellType: 'bash', titleColor: '#3b82f6' }));
    store.dispatch(addTab({ id: 'tb-c', title: 'C', shellType: 'bash', titleColor: '#f97316' }));
    store.dispatch(addTabTree({ tabId: 'tb-a', tree: leaf('pn-a', 'tm-a') }));
    store.dispatch(addTabTree({ tabId: 'tb-b', tree: leaf('pn-b', 'tm-b') }));
    store.dispatch(addTabTree({ tabId: 'tb-c', tree: leaf('pn-c', 'tm-c') }));
    setTerminalTitleColor.mockClear();

    // TWO different post-change colours, not one: a single changed value is
    // satisfied by an implementation that forwards the right leaf but a
    // hard-coded colour. `tb-c` is left alone so "only what changed" still has
    // something to be true of.
    store.dispatch(setTabTitleColor({ id: 'tb-a', titleColor: '#22c55e' }));
    store.dispatch(setTabTitleColor({ id: 'tb-b', titleColor: undefined }));
    store.dispatch(setTabTitleColor({ id: 'tb-c', titleColor: '#8b5cf6' }));

    expect(setTerminalTitleColor.mock.calls).toEqual([
      ['tm-a', '#22c55e'],
      ['tm-b', ''],
      ['tm-c', '#8b5cf6'],
    ]);
  });

  /**
   * `terminalLabelSync` declines a leaf's FIRST push when the value is already
   * empty, and this does the same for the same reason: a newly registered
   * `Terminal` already starts at `None`, so clearing it costs one invoke per
   * pane at every startup and changes nothing. (`paneOwnership`, the differ's
   * other caller, also suppresses some first sights but on a DIFFERENT
   * question — whether a live process exists — not on an empty value.) A leaf
   * cleared LATER is a change rather than a first sight, so it still pushes;
   * the test above pins that half.
   */
  it('does not spend an invoke clearing a leaf that was never coloured', () => {
    const store = makeStore();
    unsubscribe = attachTerminalTitleColorSync(store as any);

    store.dispatch(addTab({ id: 'tb-plain', title: 'Plain', shellType: 'bash' }));
    store.dispatch(addTabTree({ tabId: 'tb-plain', tree: leaf('pn-plain', 'tm-plain') }));

    expect(setTerminalTitleColor).not.toHaveBeenCalled();
  });

  // Two colours here too: this is the only assertion on what a FIRST push
  // carries, so with one colour a constant would satisfy it.
  it.each(['#14b8a6', '#e11d48'])('still pushes a coloured leaf on first sight (%s)', (colour) => {
    const store = makeStore();
    unsubscribe = attachTerminalTitleColorSync(store as any);

    store.dispatch(addTab({ id: 'tb-lit', title: 'Lit', shellType: 'bash', titleColor: colour }));
    store.dispatch(addTabTree({ tabId: 'tb-lit', tree: leaf('pn-lit', 'tm-lit') }));

    expect(setTerminalTitleColor.mock.calls).toEqual([['tm-lit', colour]]);
  });
});
