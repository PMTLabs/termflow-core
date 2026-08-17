/**
 * @jest-environment jsdom
 *
 * The agent-detection hook, which now has two consumers: the pane's floating `AgentChip` and
 * Canvas Mode's node-header chip. It was extracted from the first when the second needed it,
 * and extraction is exactly when untested subtleties get quietly dropped — all three of the
 * ones below are load-bearing and none of them is visible in the shape of the code.
 *
 * Drives `react-dom/client` + `React.act` directly; the repo has no `@testing-library/react`.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { useDetectedAgent } from '../useDetectedAgent';

const listeners = new Set<() => void>();
/**
 * Keyed by terminalId, like the real tracker.
 *
 * The first version of this fixture ignored the argument and answered one global value. Every
 * test below still passed — and the mount-time reconcile could be deleted without any of them
 * noticing, because `useState`'s lazy initializer covers the FIRST mount on its own. What
 * `sync()` actually exists for is a terminalId that changes under a mounted hook, and a mock
 * that cannot tell two terminals apart can never show that.
 */
const detected = new Map<string, string>();
const detectedExe = new Map<string, string>();

jest.mock('../../../services/AgentSchemeTracker', () => ({
  agentSchemeTracker: {
    getDetectedAgentForTerminal: (id: string) => detected.get(id) ?? null,
    getDetectedAgentExeForTerminal: (id: string) => detectedExe.get(id) ?? null,
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
  },
}));

/** Icon resolution, held open so the test decides when — and whether — it lands. */
let pending: Array<{ key: string; resolve: (url: string | null) => void }> = [];
jest.mock('../../../services/agentIconService', () => ({
  getAgentIcon: (exe: string | null, agent: string | null) =>
    new Promise<string | null>((resolve) => { pending.push({ key: `${agent}:${exe}`, resolve }); }),
}));

const notify = () => act(() => { listeners.forEach((fn) => fn()); });
/** Settle one outstanding icon resolve by the agent it was asked for. */
const land = async (key: string, url: string | null) => {
  const p = pending.find((x) => x.key === key);
  await act(async () => { p?.resolve(url); });
};

let container: HTMLDivElement;
let root: Root;
let seen: Array<{ agent: string | null; icon: string | null }>;

const Probe: React.FC<{ terminalId: string }> = ({ terminalId }) => {
  const v = useDetectedAgent(terminalId);
  seen.push(v);
  return <span data-agent={v.agent ?? ''} data-icon={v.icon ?? ''} />;
};

const last = () => seen[seen.length - 1];

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  listeners.clear();
  pending = [];
  seen = [];
  detected.clear();
  detectedExe.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const mount = (terminalId = 'tm-1') =>
  act(() => { root.render(<Probe terminalId={terminalId} />); });

describe('reading the tracker', () => {
  /**
   * The tracker POLLS. A chip mounted between two polls would show nothing until the next one
   * — up to a full poll interval of a node plainly running `claude` showing no chip. On a first
   * mount this is `useState`'s lazy initializer's job, not the effect's; the case the effect
   * owns is the one below.
   */
  it('has the current value on the first render, without waiting for a notify', () => {
    detected.set('tm-1', 'claude');
    mount();
    expect(last().agent).toBe('claude');
    expect(listeners.size).toBe(1);
  });

  /**
   * The case the mount-time `sync()` is actually for, and the only one that can fail without
   * it: `terminalId` changing under a hook that is already mounted. `useState`'s initializer
   * runs once ever, so without the reconcile the chip keeps naming the PREVIOUS terminal's
   * agent until the tracker happens to poll — and a canvas node whose pane is reused shows a
   * confidently wrong answer in the meantime.
   */
  it('re-reads when the terminal it is watching changes, without waiting for a notify', () => {
    detected.set('tm-1', 'claude');
    detected.set('tm-2', 'codex');
    mount('tm-1');
    expect(last().agent).toBe('claude');

    act(() => { root.render(<Probe terminalId="tm-2" />); });
    expect(last().agent).toBe('codex');
  });

  it('follows the tracker when detection changes', () => {
    mount();
    expect(last().agent).toBeNull();

    detected.set('tm-1', 'codex');
    notify();
    expect(last().agent).toBe('codex');

    // And back: an agent that exits must clear, or the chip outlives what it names.
    detected.delete('tm-1');
    notify();
    expect(last().agent).toBeNull();
  });

  it('unsubscribes on unmount', () => {
    mount();
    expect(listeners.size).toBe(1);
    act(() => root.unmount());
    expect(listeners.size).toBe(0);
  });
});

describe('resolving the icon', () => {
  it('shows the icon once it lands', async () => {
    detected.set('tm-1', 'claude');
    detectedExe.set('tm-1', 'C:/bin/claude.exe');
    mount();
    expect(last().icon).toBeNull();          // nothing until it resolves

    await land('claude:C:/bin/claude.exe', 'data:image/png;base64,AAA');
    expect(last().icon).toBe('data:image/png;base64,AAA');
  });

  /**
   * The one that looks fine in a screenshot and is wrong in motion: without the reset, an
   * agent swap keeps painting the OLD binary's icon next to the NEW agent's name for as long
   * as the new icon takes to resolve — so the chip names one tool and pictures another.
   */
  it('drops the previous icon the moment the agent changes', async () => {
    detected.set('tm-1', 'claude');
    detectedExe.set('tm-1', 'C:/bin/claude.exe');
    mount();
    await land('claude:C:/bin/claude.exe', 'ICON-CLAUDE');
    expect(last().icon).toBe('ICON-CLAUDE');

    detected.set('tm-1', 'codex');
    detectedExe.set('tm-1', 'C:/bin/codex.exe');
    notify();
    expect(last().agent).toBe('codex');
    expect(last().icon).toBeNull();

    await land('codex:C:/bin/codex.exe', 'ICON-CODEX');
    expect(last().icon).toBe('ICON-CODEX');
  });

  /**
   * Icon resolution is async and unordered — it reads a binary off disk and caches it. A slow
   * resolve for the agent that WAS running must not overwrite the icon of the one running now,
   * which is what the `alive` flag in the cleanup is for.
   */
  it('ignores a resolve that lands after the agent moved on', async () => {
    detected.set('tm-1', 'claude');
    detectedExe.set('tm-1', 'C:/bin/claude.exe');
    mount();

    detected.set('tm-1', 'codex');
    detectedExe.set('tm-1', 'C:/bin/codex.exe');
    notify();
    await land('codex:C:/bin/codex.exe', 'ICON-CODEX');
    expect(last().icon).toBe('ICON-CODEX');

    // The first request finally answers, long after its agent stopped being the current one.
    await land('claude:C:/bin/claude.exe', 'ICON-CLAUDE');
    expect(last().icon).toBe('ICON-CODEX');
  });

  it('ignores a resolve that lands after unmount', async () => {
    detected.set('tm-1', 'claude');
    detectedExe.set('tm-1', 'C:/bin/claude.exe');
    mount();
    const before = seen.length;
    act(() => root.unmount());

    await land('claude:C:/bin/claude.exe', 'ICON-CLAUDE');
    // A setState on an unmounted tree is a warning, not a throw — so the assertion is that no
    // further render happened at all, not that nothing was logged.
    expect(seen.length).toBe(before);
  });
});
