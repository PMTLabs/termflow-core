/**
 * @jest-environment jsdom
 *
 * The previous-host marker on a tab: drawn only for `previous`, for a tab when any of its terminals
 * is on an older host, and gone once the shell that was there is replaced.
 */
import path from 'path';
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { HostGenerationMarker, PreviousHostForTerminals, PREVIOUS_HOST_TITLE } from '../HostGenerationMarker';
import {
  __resetHostGenerationsForTest,
  anyOnPreviousHost,
  refreshHostGenerations,
  TERMINAL_GENERATIONS,
} from '../../../services/hostGeneration';
import { readSource } from '../../../utils/readSource';
import type { HostGeneration } from '../../../types/electron';

/** The backend's announcement, captured so a test can fire it. */
let announce: (() => void) | null = null;
let listenedEvent: string | null = null;
jest.mock('@tauri-apps/api/event', () => ({
  listen: (name: string, cb: () => void) => {
    listenedEvent = name;
    announce = cb;
    return Promise.resolve(() => { announce = null; });
  },
}));

let container: HTMLDivElement;
let root: Root;
let generations: Record<string, HostGeneration>;
const getTerminalGenerations = jest.fn(async () => generations);

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const marker = () => container.querySelector('.tab-previous-host');

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  generations = {};
  getTerminalGenerations.mockClear();
  getTerminalGenerations.mockImplementation(async () => generations);
  (window as unknown as { electronAPI: unknown }).electronAPI = { getTerminalGenerations };
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  __resetHostGenerationsForTest();
  announce = null;
  listenedEvent = null;
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('marker_only_when_previous', () => {
  it('draws the marker and its tooltip for a previous host', () => {
    act(() => root.render(<HostGenerationMarker generation="previous" />));
    expect(container.querySelectorAll('.tab-previous-host')).toHaveLength(1);
    expect(marker()?.getAttribute('title')).toBe('Running on a previous version of the terminal service.');
    expect(PREVIOUS_HOST_TITLE).toBe('Running on a previous version of the terminal service.');
  });

  it.each<[string, HostGeneration | undefined]>([
    ['current', 'current'],
    ['not yet described', undefined],
    ['something the backend never sends', 'older' as unknown as HostGeneration],
  ])('draws nothing for %s', (_label, generation) => {
    act(() => root.render(<HostGenerationMarker generation={generation} />));
    expect(marker()).toBeNull();
    expect(container.textContent).toBe('');
  });
});

describe('the tab strip face', () => {
  const render = (ids: string[]) => act(() => root.render(<PreviousHostForTerminals terminalIds={ids} />));

  it('is marked when any terminal in the tab is on a previous host, and only then', async () => {
    generations = { 'tm-new': 'current', 'tm-old': 'previous' };
    render(['tm-new']);
    await flush();
    expect(marker()).toBeNull();

    render(['tm-new', 'tm-old']);
    await flush();
    expect(marker()).not.toBeNull();
    expect(marker()?.getAttribute('title')).toBe(PREVIOUS_HOST_TITLE);

    render(['tm-unknown']);
    expect(marker()).toBeNull();
  });

  it('listens to the backend announcement and clears once the shell is replaced', async () => {
    generations = { 'tm-pane': 'previous' };
    render(['tm-pane']);
    await flush();
    expect(listenedEvent).toBe(TERMINAL_GENERATIONS);
    expect(marker()).not.toBeNull();

    // The pane's shell is restarted: the same leaf is now served by the current host.
    generations = { 'tm-pane': 'current' };
    await act(async () => { announce?.(); await new Promise((r) => setTimeout(r, 0)); });
    expect(marker()).toBeNull();
  });

  it('keeps what it knew when a read fails, and lets the last read win over an older one', async () => {
    generations = { 'tm-pane': 'previous' };
    render(['tm-pane']);
    await flush();
    expect(anyOnPreviousHost(['tm-pane'])).toBe(true);

    getTerminalGenerations.mockRejectedValueOnce(new Error('backend busy'));
    await act(async () => { await refreshHostGenerations(); });
    expect(anyOnPreviousHost(['tm-pane'])).toBe(true);

    let releaseSlow: (value: Record<string, HostGeneration>) => void = () => {};
    getTerminalGenerations.mockImplementationOnce(() => new Promise((resolve) => { releaseSlow = resolve; }));
    let slow: Promise<void> = Promise.resolve();
    act(() => { slow = refreshHostGenerations(); });
    generations = { 'tm-pane': 'current' };
    await act(async () => { await refreshHostGenerations(); });
    releaseSlow({ 'tm-pane': 'previous' });
    await act(async () => { await slow; });
    expect(anyOnPreviousHost(['tm-pane'])).toBe(false);
  });
});

describe('wiring', () => {
  const TABS = path.resolve(__dirname, '..');
  const MANAGER = readSource(path.resolve(TABS, 'TabManager.tsx'));

  it('draws the marker inside the tab item, from the tab\'s own terminals', () => {
    const item = MANAGER.indexOf('className={`tab-item ');
    const close = MANAGER.indexOf('className="tab-close"');
    const mark = MANAGER.indexOf('<PreviousHostForTerminals terminalIds={tabTerminalIds} />');
    expect(item).toBeGreaterThan(-1);
    expect(mark).toBeGreaterThan(item);
    expect(mark).toBeLessThan(close);
  });

  it('is styled as an inline badge that overlays nothing', () => {
    const css = readSource(path.resolve(TABS, 'TabManager.css'));
    const rule = css.slice(css.indexOf('.tab-previous-host {'));
    const body = rule.slice(0, rule.indexOf('}'));
    expect(body).toContain('flex-shrink: 0');
    expect(body).not.toMatch(/position:\s*(absolute|fixed)/);
    expect(body).not.toContain('pointer-events');
  });
});
