/**
 * @jest-environment jsdom
 */
import { terminalService } from '../TerminalService';

describe('TerminalService.getTerminalIdForProcess', () => {
  it('returns the terminalId mapped to a given processId', () => {
    terminalService.registerExistingTerminal('tm-getpid-1', 'pc-getpid-1');
    expect(terminalService.getTerminalIdForProcess('pc-getpid-1')).toBe('tm-getpid-1');
  });

  it('returns undefined for an unknown processId', () => {
    expect(terminalService.getTerminalIdForProcess('pc-unknown-xyz')).toBeUndefined();
  });
});

describe('TerminalService console-window adoption', () => {
  let adoptConsoleWindow: jest.Mock;

  beforeEach(() => {
    adoptConsoleWindow = jest.fn().mockResolvedValue(undefined);
    (window as any).electronAPI = {
      adoptConsoleWindow,
      createTerminal: jest.fn().mockResolvedValue('pc-adopt-1'),
    };
  });

  it('adopts on a fresh spawn', async () => {
    await terminalService.createTerminal('tm-adopt-1');
    expect(adoptConsoleWindow).toHaveBeenCalledWith('pc-adopt-1');
  });

  // The owner must track the pane's CURRENT window, so attaching an existing
  // PTY into another window has to re-adopt — adopting only at spawn would
  // leave a detached pane's dialogs owned by the window it came from.
  it('re-adopts when an existing process is bound into this window', () => {
    terminalService.registerExistingTerminal('tm-adopt-2', 'pc-adopt-2');
    expect(adoptConsoleWindow).toHaveBeenCalledWith('pc-adopt-2');
  });

  it('survives a bridge without the command (browser/non-Windows)', () => {
    (window as any).electronAPI = {};
    expect(() => terminalService.registerExistingTerminal('tm-adopt-3', 'pc-adopt-3')).not.toThrow();
  });

  it('swallows a rejected adopt — it must never break process binding', () => {
    adoptConsoleWindow.mockRejectedValue(new Error('no hwnd'));
    expect(() => terminalService.registerExistingTerminal('tm-adopt-4', 'pc-adopt-4')).not.toThrow();
    expect(terminalService.getTerminalIdForProcess('pc-adopt-4')).toBe('tm-adopt-4');
  });
});

describe('TerminalService.createTerminal owning-tab plumbing', () => {
  let createTerminal: jest.Mock;

  beforeEach(() => {
    createTerminal = jest.fn().mockResolvedValue('pc-owner-1');
    (window as any).electronAPI = {
      createTerminal,
      adoptConsoleWindow: jest.fn().mockResolvedValue(undefined),
    };
  });

  // Design 011 §6: the owner must reach the backend AT SPAWN. Without it the
  // Rust owning_tab_id is null for every UI-created terminal and the
  // split-pane activity fix cannot work.
  it('forwards the owning tab id to the bridge', async () => {
    await terminalService.createTerminal(
      'tm-owner-leaf', 'default', 'Terminal', undefined, 120, 40, 'tb-owner-tab',
    );
    expect(createTerminal).toHaveBeenCalledWith(
      'default', 'Terminal', undefined, 'tm-owner-leaf', 120, 40, 'tb-owner-tab', undefined,
    );
  });

  // A root/solo pane owns itself; callers that pass nothing must still work
  // (the backend treats `undefined` as "unknown" and falls back to the leaf).
  it('omits the owner when the caller does not know one', async () => {
    await terminalService.createTerminal('tb-solo-1');
    expect(createTerminal).toHaveBeenCalledWith(
      'default', undefined, undefined, 'tb-solo-1', undefined, undefined, undefined, undefined,
    );
  });

  // Design 014 §A2.1, and the same trap 011 §6 named for `owningTabId`: the
  // session key must reach the backend AT SPAWN. A pane migrated from a pre-014
  // build has a fresh `tm-` leaf but its armed host session is still keyed by
  // the old `tb-` id, so dropping this argument orphans that session — silently,
  // because a fresh spawn looks exactly like a successful one.
  it('forwards a migrated session key to the bridge', async () => {
    await terminalService.createTerminal(
      'tm-migrated-leaf', 'default', 'Terminal', undefined, 120, 40, 'tb-owner-tab', 'tb-legacy01',
    );
    expect(createTerminal).toHaveBeenCalledWith(
      'default', 'Terminal', undefined, 'tm-migrated-leaf', 120, 40, 'tb-owner-tab', 'tb-legacy01',
    );
  });

  // Every pane created on this build: the host key follows the leaf, so there is
  // nothing legacy to carry and the argument must stay absent rather than being
  // defaulted to the leaf (which would make a real migration indistinguishable).
  it('omits the session key for a pane created on this build', async () => {
    await terminalService.createTerminal(
      'tm-fresh-leaf', 'default', undefined, undefined, undefined, undefined, 'tb-owner-tab',
    );
    const call = createTerminal.mock.calls[0];
    expect(call[7]).toBeUndefined();
  });
});

// Review 109 H1: a re-entrant restart/create for the SAME leaf (double Restart
// click, Ctrl+R key-repeat while the banner is still up) must not reach the
// backend twice — two spawns for one leaf register two Terminal rows under
// the same renderer_terminal_id, breaking the terminal_history PRIMARY KEY.
describe('TerminalService.createTerminal single-flight per leaf', () => {
  let createTerminal: jest.Mock;
  let resolveSpawn: (id: string) => void;

  beforeEach(() => {
    createTerminal = jest.fn().mockImplementation(
      () => new Promise<string>((resolve) => { resolveSpawn = resolve; }),
    );
    (window as any).electronAPI = {
      createTerminal,
      adoptConsoleWindow: jest.fn().mockResolvedValue(undefined),
    };
  });

  it('coalesces two concurrent creates for the same leaf into one backend spawn', async () => {
    const p1 = terminalService.createTerminal('tm-singleflight-1', 'default');
    const p2 = terminalService.createTerminal('tm-singleflight-1', 'default');

    expect(createTerminal).toHaveBeenCalledTimes(1);

    resolveSpawn('pc-singleflight-1');
    const [id1, id2] = await Promise.all([p1, p2]);

    expect(id1).toBe('pc-singleflight-1');
    expect(id2).toBe('pc-singleflight-1');
  });

  it('allows a new create for the same leaf after the prior one settles', async () => {
    const p1 = terminalService.createTerminal('tm-singleflight-2', 'default');
    resolveSpawn('pc-singleflight-2a');
    await p1;

    createTerminal.mockImplementation(
      () => new Promise<string>((resolve) => { resolveSpawn = resolve; }),
    );
    const p2 = terminalService.createTerminal('tm-singleflight-2', 'default');
    resolveSpawn('pc-singleflight-2b');
    await p2;

    expect(createTerminal).toHaveBeenCalledTimes(2);
  });

  it('clears the in-flight entry on failure so a retry is not poisoned forever', async () => {
    createTerminal.mockRejectedValueOnce(new Error('spawn failed'));
    await expect(terminalService.createTerminal('tm-singleflight-3', 'default')).rejects.toThrow('spawn failed');

    createTerminal.mockResolvedValueOnce('pc-singleflight-3');
    await expect(terminalService.createTerminal('tm-singleflight-3', 'default')).resolves.toBe('pc-singleflight-3');
    expect(createTerminal).toHaveBeenCalledTimes(2);
  });
});

describe('TerminalService.stashPromptGate (backlog 011 hot-swap reattach seed)', () => {
  it('stashes a gate that takePromptGateHandoff drains exactly once', () => {
    terminalService.stashPromptGate('tb-seed-1', { seen: true, armed: false });
    expect(terminalService.takePromptGateHandoff('tb-seed-1')).toEqual({ seen: true, armed: false });
    // Single-use — the engine only reads it on its first mount.
    expect(terminalService.takePromptGateHandoff('tb-seed-1')).toBeUndefined();
  });

  it('clears a pending stash when passed null (hookless shell → no gate)', () => {
    terminalService.stashPromptGate('tb-seed-2', { seen: true, armed: false });
    terminalService.stashPromptGate('tb-seed-2', null);
    expect(terminalService.takePromptGateHandoff('tb-seed-2')).toBeUndefined();
  });
});

/**
 * External review 101, F2 — the WIRING, not the rule.
 *
 * `paneOwnershipSync.test.ts` covers what `reassertOwnerAfterSpawn` decides.
 * This covers the part that regressed the last time around: nobody calling it.
 * `createTerminal` is the single choke point every renderer create passes
 * through, and the moment it returns is the first moment the backend has the
 * terminal registered — which is exactly what a mid-spawn pane move needs.
 */
describe('TerminalService.createTerminal re-asserts pane ownership after the spawn', () => {
  const { attachPaneOwnershipSync } = require('../paneOwnership');
  const panesReducer = require('../../store/slices/panesSlice').default;
  const { addTabTree, insertPaneIntoTab } = require('../../store/slices/panesSlice');
  const { configureStore } = require('@reduxjs/toolkit');

  let setTerminalOwningTab: jest.Mock;
  let unsubscribe: () => void;

  beforeEach(() => {
    setTerminalOwningTab = jest.fn().mockResolvedValue(undefined);
    (window as any).electronAPI = {
      createTerminal: jest.fn().mockResolvedValue('pc-reassert-1'),
      setTerminalOwningTab,
    };
    const store = configureStore({ reducer: { panes: panesReducer } });
    unsubscribe = attachPaneOwnershipSync(store);
    // The pane is born under tb-src, then dragged to tb-dst while its create is
    // still in flight — so the owner the spawn carries is already stale by the
    // time the backend registers the terminal.
    store.dispatch(addTabTree({ tabId: 'tb-src', tree: { id: 'pn-a', type: 'terminal', terminalId: 'tm-reassert' } }));
    store.dispatch(addTabTree({ tabId: 'tb-dst', tree: { id: 'pn-b', type: 'terminal', terminalId: 'tb-dst' } }));
    store.dispatch(insertPaneIntoTab({
      tabId: 'tb-dst',
      targetPaneId: 'pn-b',
      zone: 'right',
      node: { id: 'pn-a', type: 'terminal', terminalId: 'tm-reassert' },
    }));
    setTerminalOwningTab.mockClear();
  });

  afterEach(() => unsubscribe());

  it('pushes the tree\'s current owner, not the one the spawn carried', async () => {
    await terminalService.createTerminal('tm-reassert', 'default', undefined, undefined, undefined, undefined, 'tb-src');
    expect(setTerminalOwningTab).toHaveBeenCalledWith('tm-reassert', 'tb-dst');
  });
});

/**
 * A fresh spawn is announced so RunningActivityTracker can hold this shell's startup banner
 * back from the unseen bell (see SPAWN_GRACE_MS). The tracker cannot work this out for itself:
 * output is all it sees, and a banner looks exactly like anything else a program prints.
 */
describe('TerminalService publishes pty:spawn for a FRESH spawn only', () => {
  const spawns: Array<{ processId?: string; terminalId?: string }> = [];
  const onSpawn = (e: Event) => spawns.push((e as CustomEvent).detail);

  beforeEach(() => {
    spawns.length = 0;
    window.addEventListener('pty:spawn', onSpawn);
    (window as any).electronAPI = {
      createTerminal: jest.fn().mockResolvedValue('pc-spawn-1'),
      adoptConsoleWindow: jest.fn().mockResolvedValue(undefined),
    };
  });

  afterEach(() => window.removeEventListener('pty:spawn', onSpawn));

  it('announces the spawn with both ids', async () => {
    await terminalService.createTerminal('tm-spawn-1');
    expect(spawns).toEqual([{ processId: 'pc-spawn-1', terminalId: 'tm-spawn-1' }]);
  });

  /**
   * The half that decides where the dispatch lives. Binding in `bindProcess` would cover this
   * path too — and it must not: a cross-window attach and a hot-swap reattach bind a PTY that
   * has been running for minutes, so its output is activity the user may genuinely have missed,
   * not a banner they just asked for. Granting it a grace would swallow a real notification.
   */
  it('stays silent when an already-running process is merely bound into this window', () => {
    terminalService.registerExistingTerminal('tm-spawn-2', 'pc-spawn-2');
    terminalService.attachExistingTerminal('tm-spawn-3', 'pc-spawn-3');
    expect(spawns).toEqual([]);
  });
});
