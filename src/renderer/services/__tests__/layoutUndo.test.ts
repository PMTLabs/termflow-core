/**
 * @jest-environment jsdom
 *
 * plan/025 §2.2. `layoutUndo` mirrors its one slot to `localStorage`, so this
 * suite needs jsdom (per the project's test setup pattern for anything
 * touching `localStorage`/`window`).
 */
import {
  pushUndo, peekUndo, takeUndo, clearUndo, subscribeUndo, __resetLayoutUndoForTests,
} from '../layoutUndo';
import { layoutUndoKey } from '../windowScope';
import { WorkspaceSnapshot } from '../workspaceSnapshot';

function makeSnapshot(overrides?: Partial<WorkspaceSnapshot>): WorkspaceSnapshot {
  return {
    tabs: [{ id: 'tb-a', title: 'A', shellType: 'default', isActive: true } as any],
    activeTabId: 'tb-a',
    paneTree: null,
    activePaneId: null,
    treesByTabId: {},
    activePaneByTabId: {},
    maximizedPaneByTabId: {},
    tabPanes: {},
    terminalCwds: {},
    capturedAt: Date.now(),
    label: 'a snapshot',
    ...overrides,
  };
}

const emptySnapshot = (): WorkspaceSnapshot => makeSnapshot({ tabs: [], activeTabId: null });

describe('layoutUndo', () => {
  beforeEach(() => {
    localStorage.clear();
    __resetLayoutUndoForTests();
  });

  it('peekUndo returns null when nothing has been pushed', () => {
    expect(peekUndo()).toBeNull();
  });

  it('push then peek returns the snapshot WITHOUT consuming it', () => {
    const s = makeSnapshot({ label: 'first' });
    pushUndo(s);
    expect(peekUndo()).toEqual(s);
    // Still there on a second read.
    expect(peekUndo()).toEqual(s);
  });

  it('take returns the snapshot and clears the slot', () => {
    const s = makeSnapshot({ label: 'first' });
    pushUndo(s);
    expect(takeUndo()).toEqual(s);
    expect(peekUndo()).toBeNull();
    expect(takeUndo()).toBeNull();
  });

  it('holds at most ONE snapshot — a second push replaces the first', () => {
    pushUndo(makeSnapshot({ label: 'first' }));
    pushUndo(makeSnapshot({ label: 'second' }));
    expect(peekUndo()?.label).toBe('second');
  });

  it('refuses to push an empty workspace', () => {
    pushUndo(emptySnapshot());
    expect(peekUndo()).toBeNull();
  });

  it('an empty push does not clobber whatever was already in the slot', () => {
    pushUndo(makeSnapshot({ label: 'kept' }));
    pushUndo(emptySnapshot());
    expect(peekUndo()?.label).toBe('kept');
  });

  it('mirrors the slot to localStorage under layoutUndoKey(), and take/clear remove it', () => {
    const s = makeSnapshot({ label: 'mirrored' });
    pushUndo(s);
    const raw = localStorage.getItem(layoutUndoKey());
    expect(raw).not.toBeNull();
    expect(JSON.parse(raw as string).label).toBe('mirrored');

    takeUndo();
    expect(localStorage.getItem(layoutUndoKey())).toBeNull();

    pushUndo(makeSnapshot({ label: 'mirrored again' }));
    clearUndo();
    expect(localStorage.getItem(layoutUndoKey())).toBeNull();
  });

  it('survives a reload: hydrates from localStorage on first access after the in-memory slot is gone', () => {
    pushUndo(makeSnapshot({ label: 'before reload' }));
    // Simulate a page reload: the module-scope variable is gone, but localStorage
    // is not. `__resetLayoutUndoForTests` puts the slot back to "unhydrated",
    // exactly the state a fresh page load starts in.
    __resetLayoutUndoForTests();
    expect(peekUndo()?.label).toBe('before reload');
  });

  it('a corrupt localStorage entry degrades to "nothing to undo" rather than throwing', () => {
    localStorage.setItem(layoutUndoKey(), '{not valid json');
    __resetLayoutUndoForTests();
    expect(() => peekUndo()).not.toThrow();
    expect(peekUndo()).toBeNull();
  });

  it('subscribeUndo fires on push/take/clear, and unsubscribe stops further notifications', () => {
    const fn = jest.fn();
    const unsubscribe = subscribeUndo(fn);

    pushUndo(makeSnapshot());
    expect(fn).toHaveBeenCalledTimes(1);

    takeUndo();
    expect(fn).toHaveBeenCalledTimes(2);

    pushUndo(makeSnapshot());
    clearUndo();
    expect(fn).toHaveBeenCalledTimes(4);

    unsubscribe();
    pushUndo(makeSnapshot());
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('does not notify subscribers when a push is refused for being empty', () => {
    const fn = jest.fn();
    subscribeUndo(fn);
    pushUndo(emptySnapshot());
    expect(fn).not.toHaveBeenCalled();
  });
});
