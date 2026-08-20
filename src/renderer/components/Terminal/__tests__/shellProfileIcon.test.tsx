/**
 * @jest-environment jsdom
 *
 * `ShellProfileIcon` (Req 6, `plan/020` §3) — the one answer to "what does this shell look like",
 * shared by the tab strip and the canvas sidebar.
 *
 * Two things needed pinning and neither had any coverage — nor did the `TabManager` warm-load
 * effect this replaced:
 *
 *  - **The resolution path itself.** Every existing test that mounts this component does so with
 *    an empty `shellProfiles`, so only the "no path → emoji" branch was ever exercised. The
 *    component's whole reason to exist — N tab and sidebar instances sharing ONE native icon
 *    extraction through `binaryIcons` — was untested.
 *  - **The emoji DEFAULT.** `emoji = '🖥️'` fires on `undefined`, and the tab strip passes
 *    `emoji={tab.icon}`. The code it replaced rendered NOTHING for a tab with no icon
 *    ([[default-parameter-hides-a-dropped-argument]]). Every tab-creation site sets an icon
 *    today, so this is dormant — but `detach.ts` can pass `sourceTab?.icon` for a tab that has
 *    already gone, and an old persisted session predates the field. Pinned deliberately, so the
 *    behaviour is a decision rather than a side effect of a default.
 */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { ShellProfileIcon } from '../ShellProfileIcon';

const PNG = 'data:image/png;base64,AAAA';

let getExecutableIcon: jest.Mock;

const storeWith = (profiles: Array<{ id: string; path: string }>) =>
  configureStore({
    reducer: { settings: (s = { shellProfiles: profiles }) => s },
  });

let container: HTMLDivElement;
let root: Root;

beforeAll(() => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

beforeEach(() => {
  jest.resetModules();
  getExecutableIcon = jest.fn(async () => PNG);
  (window as unknown as { electronAPI: unknown }).electronAPI = { getExecutableIcon };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (node: React.ReactNode, profiles: Array<{ id: string; path: string }> = []) =>
  act(() => { root.render(<Provider store={storeWith(profiles)}>{node}</Provider>); });

const img = () => container.querySelector<HTMLImageElement>('img.shell-profile-icon');
const glyph = () => container.querySelector<HTMLElement>('span.shell-profile-icon');

describe('ShellProfileIcon — the emoji fallback', () => {
  it('shows the caller\'s emoji when the shell has no known binary', () => {
    render(<ShellProfileIcon shellType="zsh" emoji="🐚" />);
    expect(glyph()?.textContent).toBe('🐚');
    expect(img()).toBeNull();
  });

  /**
   * THE BEHAVIOUR CHANGE, pinned rather than discovered later. The tab strip used to render
   * nothing at all in this case.
   */
  it('falls back to the generic glyph when the caller passes no emoji at all', () => {
    render(<ShellProfileIcon shellType="zsh" />);
    expect(glyph()?.textContent).toBe('🖥️');
  });

  // Its counterpart: a caller CAN still ask for nothing, explicitly, and get nothing. Without
  // this the default would be indistinguishable from "an emoji is mandatory".
  it('renders nothing when the caller explicitly asks for no emoji', () => {
    render(<ShellProfileIcon shellType="zsh" emoji="" />);
    expect(glyph()).toBeNull();
    expect(img()).toBeNull();
  });
});

/**
 * `binaryIcons`'s cache is deliberately SESSION-wide — one extraction per binary for the life of
 * the app — and a module-level cache is not reset between cases here. So every case below uses
 * its own path: sharing one would make the second test read the first test's cache entry and
 * assert nothing.
 */
describe('ShellProfileIcon — the real binary icon', () => {
  const PROFILES = [{ id: 'pwsh', path: 'C:/pwsh.exe' }];

  it('loads the shell\'s own icon and swaps the emoji for it', async () => {
    render(<ShellProfileIcon shellType="pwsh" emoji="🐚" />, PROFILES);
    // Before it resolves, the emoji stands in — a blank slot would be worse than a placeholder.
    expect(glyph()?.textContent).toBe('🐚');

    await act(async () => { await Promise.resolve(); });
    expect(img()?.src).toBe(PNG);
    expect(glyph()).toBeNull();
    expect(getExecutableIcon).toHaveBeenCalledWith('C:/pwsh.exe');
  });

  /**
   * The point of extracting this component. `binaryIcons` de-dupes per path, so mounting one
   * icon per tab AND one per sidebar row costs ONE native extraction, not one each — which is
   * what makes the per-instance load acceptable in the first place.
   */
  it('extracts a given binary\'s icon once, however many surfaces show it', async () => {
    render(
      <>
        <ShellProfileIcon shellType="pwsh" />
        <ShellProfileIcon shellType="pwsh" />
        <ShellProfileIcon shellType="pwsh" />
      </>,
      [{ id: 'pwsh', path: 'C:/shared-by-three.exe' }],
    );
    await act(async () => { await Promise.resolve(); });
    expect(getExecutableIcon).toHaveBeenCalledTimes(1);
    // And all three still get the icon — a de-dupe that only served the first caller would
    // leave the other two on the emoji forever.
    expect(container.querySelectorAll('img.shell-profile-icon')).toHaveLength(3);
  });

  // A path that cannot be extracted must not be retried on every mount, or a workspace full of
  // one bad profile turns every render into a failed native call.
  it('does not retry a binary whose icon never resolves', async () => {
    getExecutableIcon.mockResolvedValue(null);
    render(<ShellProfileIcon shellType="pwsh" />, [{ id: 'pwsh', path: 'C:/broken.exe' }]);
    await act(async () => { await Promise.resolve(); });
    render(<ShellProfileIcon shellType="pwsh" />, [{ id: 'pwsh', path: 'C:/broken.exe' }]);
    await act(async () => { await Promise.resolve(); });
    expect(getExecutableIcon).toHaveBeenCalledTimes(1);
    expect(glyph()?.textContent).toBe('🖥️');
  });

  // The `alive` flag. A sidebar row unmounts on a filter keystroke, and a resolve landing after
  // that would set state on a dead component — a warning today, and the shape of a leak.
  it('survives its icon resolving after it has unmounted', async () => {
    const errors: unknown[] = [];
    const spy = jest.spyOn(console, 'error').mockImplementation((...a) => { errors.push(a); });
    render(<ShellProfileIcon shellType="pwsh" />, [{ id: 'pwsh', path: 'C:/slow.exe' }]);
    act(() => { root.render(<Provider store={storeWith([])}><span /></Provider>); });
    await act(async () => { await Promise.resolve(); });
    expect(errors).toEqual([]);
    spy.mockRestore();
  });
});
