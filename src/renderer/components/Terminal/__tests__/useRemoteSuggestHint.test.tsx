/**
 * @jest-environment jsdom
 *
 * `useRemoteSuggestHint` (plan 061). The rule itself is pinned in remoteSuggestHint.test.ts;
 * this file pins what only a mounted hook can get wrong: ORDER (a host mark that lands before
 * the 2 s foreground poll notices ssh), SUBSCRIPTION (an engine created after the last mark,
 * a remount, disposal), and per-tab isolation.
 *
 * The engine is a fake that honours the same `onPromptMark` contract the real one is tested
 * against in packages/terminal-core engine.suggest.test.ts: fires once on subscribe with the
 * current state, then on every mark, and hands back a disposer.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import type { PromptMarkState, TerminalEngine } from '@termflow/terminal-core';
import { resetRemoteHintDismissals } from '../remoteSuggestHint';

const mockSsh = new Set<string>();
const mockTrackerListeners = new Set<() => void>();
jest.mock('../../../services/AgentSchemeTracker', () => ({
  agentSchemeTracker: {
    isSshForeground: (id: string) => mockSsh.has(id),
    subscribe: (listener: () => void) => {
      mockTrackerListeners.add(listener);
      return () => { mockTrackerListeners.delete(listener); };
    },
  },
}));

import { useRemoteSuggestHint } from '../useRemoteSuggestHint';

class FakeEngine {
  state: PromptMarkState = { seen: false, kind: 'local' };
  listeners = new Set<(s: PromptMarkState) => void>();
  onPromptMark(listener: (s: PromptMarkState) => void): () => void {
    this.listeners.add(listener);
    listener({ ...this.state });
    return () => { this.listeners.delete(listener); };
  }
  mark(state: PromptMarkState): void {
    this.state = state;
    for (const l of [...this.listeners]) l({ ...state });
  }
}

const asEngine = (e: FakeEngine | null) => e as unknown as TerminalEngine | null;

function setSsh(id: string, on: boolean): void {
  if (on) mockSsh.add(id); else mockSsh.delete(id);
  for (const l of [...mockTrackerListeners]) l();
}

const Probe: React.FC<{ id: string; engine: FakeEngine | null; generation: number }> = ({ id, engine, generation }) => {
  const ref = React.useRef<TerminalEngine | null>(null);
  ref.current = asEngine(engine);
  const { show, dismiss } = useRemoteSuggestHint(id, ref, generation);
  return (
    <div data-id={id} data-show={String(show)}>
      <button data-dismiss={id} onClick={dismiss} />
    </div>
  );
};

const makeStore = (commandSuggestions: boolean) =>
  configureStore({ reducer: { settings: (s: { commandSuggestions: boolean } = { commandSuggestions }) => s } });

let container: HTMLDivElement;
let root: Root;

function render(ui: React.ReactElement, enabled = true): void {
  act(() => { root.render(<Provider store={makeStore(enabled)}>{ui}</Provider>); });
}
const shown = (id: string): boolean =>
  container.querySelector(`[data-id="${id}"]`)!.getAttribute('data-show') === 'true';
const click = (id: string): void => {
  act(() => { (container.querySelector(`[data-dismiss="${id}"]`) as HTMLButtonElement).click(); });
};

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  mockSsh.clear();
  mockTrackerListeners.clear();
  resetRemoteHintDismissals();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useRemoteSuggestHint', () => {
  it('shows for a hooked local shell with ssh in front, and hides when the host sends a mark', () => {
    const engine = new FakeEngine();
    render(<Probe id="tm-1" engine={engine} generation={1} />);
    act(() => engine.mark({ seen: true, kind: 'local' }));
    expect(shown('tm-1')).toBe(false); // ssh not in front yet
    act(() => setSsh('tm-1', true));
    expect(shown('tm-1')).toBe(true);
    act(() => engine.mark({ seen: true, kind: 'host' })); // the host's first prompt mark
    expect(shown('tm-1')).toBe(false);
  });

  it('never shows when the host mark arrived BEFORE ssh was observed (poll lag)', () => {
    const engine = new FakeEngine();
    render(<Probe id="tm-1" engine={engine} generation={1} />);
    act(() => engine.mark({ seen: true, kind: 'local' }));
    act(() => engine.mark({ seen: true, kind: 'host' })); // pre-hooked host prompts immediately
    act(() => setSsh('tm-1', true)); // ...and the poll only now sees ssh
    expect(shown('tm-1')).toBe(false);
  });

  it('hides when ssh exits, and a second ssh episode offers it again', () => {
    const engine = new FakeEngine();
    render(<Probe id="tm-1" engine={engine} generation={1} />);
    act(() => engine.mark({ seen: true, kind: 'local' }));
    act(() => setSsh('tm-1', true));
    expect(shown('tm-1')).toBe(true);
    act(() => { setSsh('tm-1', false); engine.mark({ seen: true, kind: 'local' }); }); // local prompt back
    expect(shown('tm-1')).toBe(false);
    act(() => setSsh('tm-1', true)); // ssh to another host
    expect(shown('tm-1')).toBe(true);
  });

  it('does not show for a tab whose local shell never proved it renders prompts', () => {
    const engine = new FakeEngine();
    render(<Probe id="tm-1" engine={engine} generation={1} />);
    act(() => setSsh('tm-1', true)); // gate unseen: input is not being dropped, nothing to fix
    expect(shown('tm-1')).toBe(false);
  });

  it('is hidden while the setting is off', () => {
    const engine = new FakeEngine();
    render(<Probe id="tm-1" engine={engine} generation={1} />, false);
    act(() => engine.mark({ seen: true, kind: 'local' }));
    act(() => setSsh('tm-1', true));
    expect(shown('tm-1')).toBe(false);
  });

  it('picks up an engine created AFTER the last mark (late readiness)', () => {
    const engine = new FakeEngine();
    engine.state = { seen: true, kind: 'host' }; // the mark landed before anyone subscribed
    act(() => setSsh('tm-1', true));
    render(<Probe id="tm-1" engine={null} generation={0} />);
    expect(shown('tm-1')).toBe(false); // no engine: nothing to base a decision on
    render(<Probe id="tm-1" engine={engine} generation={1} />);
    expect(shown('tm-1')).toBe(false); // subscribe replayed the host mark
    expect(engine.listeners.size).toBe(1);
  });

  it('resubscribes for a new engine generation and disposes the old subscription', () => {
    const first = new FakeEngine();
    const second = new FakeEngine();
    render(<Probe id="tm-1" engine={first} generation={1} />);
    expect(first.listeners.size).toBe(1);
    render(<Probe id="tm-1" engine={second} generation={2} />);
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    act(() => root.unmount());
    expect(second.listeners.size).toBe(0);
    root = createRoot(container); // so afterEach can unmount a live root
  });

  it('dismissal is per tab and survives a remount of the same terminal', () => {
    const engine = new FakeEngine();
    render(
      <>
        <Probe id="tm-1" engine={engine} generation={1} />
        <Probe id="tm-2" engine={engine} generation={1} />
      </>,
    );
    act(() => engine.mark({ seen: true, kind: 'local' }));
    act(() => { setSsh('tm-1', true); setSsh('tm-2', true); });
    expect(shown('tm-1')).toBe(true);
    expect(shown('tm-2')).toBe(true);

    click('tm-1');
    expect(shown('tm-1')).toBe(false);
    expect(shown('tm-2')).toBe(true); // another tab is untouched

    act(() => root.unmount());
    root = createRoot(container);
    render(
      <>
        <Probe id="tm-1" engine={engine} generation={1} />
        <Probe id="tm-2" engine={engine} generation={1} />
      </>,
    );
    expect(shown('tm-1')).toBe(false); // still dismissed after the remount
    expect(shown('tm-2')).toBe(true);
  });

  it('reads the foreground per terminal id, not "the first process" for every pane', () => {
    const engine = new FakeEngine();
    render(
      <>
        <Probe id="tm-1" engine={engine} generation={1} />
        <Probe id="tm-2" engine={engine} generation={1} />
      </>,
    );
    act(() => engine.mark({ seen: true, kind: 'local' }));
    act(() => setSsh('tm-2', true));
    expect(shown('tm-1')).toBe(false);
    expect(shown('tm-2')).toBe(true);
  });
});
