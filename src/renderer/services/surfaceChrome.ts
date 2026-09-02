/**
 * A terminal's floating CHROME, published so a surface other than its pane can draw it
 * (`plan/020` §5).
 *
 * `surfaceHosts` moves a terminal's *surface* between the pane and a Canvas node. Its chrome —
 * the scroll-to-bottom button and the command-history popup — did not follow: both are React
 * siblings of `.terminal-display` inside `TerminalDisplay`, so they stayed in the pane, off
 * screen, while the terminal itself was on the canvas. The Canvas overlay is that terminal at
 * 1:1 and is meant to be worked in, so it was the one surface where the absence was felt.
 *
 * WHY A REGISTRY AND NOT A PORTAL. Portaling the chrome out of `TerminalDisplay` is the obvious
 * move and it is closed: `terminalDisplayRelocationWiring.test.ts` asserts the source contains
 * no `createPortal`, because design/012 D1 killed the portal in rev 4 and reviews 089/090 found
 * the render shape unbuildable. So the state travels and the components are rendered by whoever
 * is showing the terminal — the same shape `surfaceHosts` already uses, for the same reason: a
 * live per-terminal fact that crosses a React tree boundary outside the data flow.
 *
 * WHY NOT A SECOND HOOK. `useCommandSuggest` cannot simply be instantiated again on the canvas
 * side: the engine holds ONE `onInputLineChanged`/`onSuggestAction` pair, wired at construction
 * to `TerminalDisplay`'s instance. Two consumers would mean two popups disagreeing about the
 * selected index. One hook, one state, two possible homes.
 *
 * SINGLE OWNER PER KEY, enforced with an opaque owner token rather than by value: the published
 * state changes on nearly every keystroke, so it carries no identity to check a stale cleanup
 * against (the failure `clearSurfaceHost`'s signature exists to prevent). The token is created
 * once per publishing component instance.
 *
 * Writes are NO-OPS when nothing observable changed. Every canvas node subscribes, so a write
 * that notifies for an unchanged value re-renders the whole workspace — and `atBottom` alone is
 * recomputed on every scroll event of every terminal.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { SuggestViewState } from '../components/Terminal/useCommandSuggest';
import type { SearchViewState } from '../components/Terminal/useTerminalSearch';

/** What a surface needs in order to draw a terminal's chrome and act on it. */
export interface SurfaceChromeState {
  /** False while the user has scrolled away from the live tail. */
  atBottom: boolean;
  /** The command-history popup's view state, straight from `useCommandSuggest`. */
  suggest: SuggestViewState;
  /**
   * The search bar's view state — one owner, drawn by whichever surface is showing
   * (`plan/027` §1.4).
   *
   * Same shape and same reason as `suggest`: the bar is presentational, so the pane and the
   * overlay can both render one, but only `TerminalDisplay` may own the state — two owners means
   * two as-you-type effects clearing each other's search.
   */
  search: SearchViewState;
  /** Jump to the live tail and take the keyboard back. */
  scrollToBottom: () => void;
  /** Accept a suggestion — inserts it into the shell and closes the popup. */
  pickSuggestion: (command: string) => void;
  /**
   * Open the TERMINAL's context menu — Copy, Paste, Clear, Selection mode — at a point in
   * VIEWPORT coordinates (`plan/021` R2).
   *
   * The menu itself is still rendered by `TerminalDisplay`, and that is not an accident:
   * `ContextMenu` portals to `document.body` and positions itself `fixed` at the literal
   * coordinates it is given, so where it is rendered FROM has no bearing on where it appears.
   * Only the trigger had to travel — the menu's items act on the engine, which is the same
   * engine either way.
   */
  openContextMenu: (x: number, y: number) => void;
  /**
   * Restart this pane's shell in place, and dismiss the session-closed notice (`plan/024` Req 4).
   *
   * Handlers rather than a flag, for the same reason `scrollToBottom` and `openContextMenu` are:
   * only the PANE can perform them. A restart reuses the profile, the working directory the shell
   * died in and the migrated session key, all of which live in `TerminalPane` — so the overlay
   * asks for the action instead of reimplementing it, and there is exactly one restart in the app.
   *
   * The FACT that a session ended does not travel this way: it is in `sessionExit`, because a
   * canvas node must draw itself muted whether or not anything is publishing its chrome, and
   * every node subscribing here to learn it would wake the whole canvas on every scroll.
   */
  restartSession: () => void;
  dismissSessionClosed: () => void;
  /**
   * Open + focus search for this terminal (`plan/027` §1.4). The TRIGGER only; the bar itself is
   * drawn by whichever surface is showing, from `search` above.
   *
   * Published separately from `search` because its callers render nothing: the canvas overlay's
   * Ctrl+F binding, the terminal content menu's Find item and `PaneContextMenu`'s. The engine's
   * own Ctrl+F listener does not come through here — it is wired only when `paneChrome` is true,
   * which is false on every canvas host (design/012 D16), and that gap is exactly what the
   * overlay's element-bound hotkey fills.
   */
  openSearch: () => void;
}

interface Entry {
  owner: object;
  state: SurfaceChromeState;
}

const chrome = new Map<string, Entry>();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach((listener) => listener());
}

/** Identity first — the common case, since the list comes straight out of `useState` and is the
 *  same array until the suggestions actually change. */
function sameItems(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((s, i) => s === b[i]);
}

/**
 * True when the two carry the same observable value.
 *
 * `suggest` is compared field by field rather than by identity because `useCommandSuggest`
 * returns a spread — a fresh object on every render of the pane — while the fields inside it
 * are the stable ones held in `useState`. Comparing the wrapper would make every write a change
 * and defeat the whole no-op rule.
 *
 * `items` goes one step further and is compared BY VALUE. Today's publisher happens to hand over
 * the array it holds in state, so identity would do; a publisher that maps or filters on the way
 * out would not, and the failure is silent and global — every canvas node re-rendering on every
 * scroll event, with nothing to point at. A few string compares on a list that never exceeds the
 * popup's own page size is the cheaper side of that trade.
 *
 * `search` is compared THE SAME WAY, field by field including its callbacks, for the same
 * reason: `useTerminalSearch` returns a fresh wrapper on every render of the pane. A field left
 * out here is not a missed re-render — it is a STALE CLOSURE the overlay goes on calling, with
 * nothing else in the app to notice (`plan/027` §1.4).
 */
function same(a: SurfaceChromeState, b: SurfaceChromeState): boolean {
  return (
    a.atBottom === b.atBottom
    && a.scrollToBottom === b.scrollToBottom
    && a.pickSuggestion === b.pickSuggestion
    && a.openContextMenu === b.openContextMenu
    && a.restartSession === b.restartSession
    && a.dismissSessionClosed === b.dismissSessionClosed
    && a.openSearch === b.openSearch
    && a.suggest.open === b.suggest.open
    && a.suggest.selectedIndex === b.suggest.selectedIndex
    && a.suggest.focused === b.suggest.focused
    && a.suggest.anchor === b.suggest.anchor
    && sameItems(a.suggest.items, b.suggest.items)
    && a.search.open === b.search.open
    && a.search.query === b.search.query
    && a.search.caseSensitive === b.search.caseSensitive
    && a.search.wholeWord === b.search.wholeWord
    && a.search.regex === b.search.regex
    && a.search.focusToken === b.search.focusToken
    && a.search.result.resultIndex === b.search.result.resultIndex
    && a.search.result.resultCount === b.search.result.resultCount
    && a.search.setQuery === b.search.setQuery
    && a.search.toggleCaseSensitive === b.search.toggleCaseSensitive
    && a.search.toggleWholeWord === b.search.toggleWholeWord
    && a.search.toggleRegex === b.search.toggleRegex
    && a.search.next === b.search.next
    && a.search.previous === b.search.previous
    && a.search.close === b.search.close
  );
}

/**
 * Publish `state` as the chrome for `terminalId`, owned by `owner`.
 *
 * A different owner takes the slot over, which is what a remount looks like: the new instance
 * publishes before the old one's cleanup runs, and the identity check on `clear` is what stops
 * that cleanup wiping the live registration.
 */
export function setSurfaceChrome(terminalId: string, owner: object, state: SurfaceChromeState): void {
  const prev = chrome.get(terminalId);
  if (prev && prev.owner === owner && same(prev.state, state)) return;
  chrome.set(terminalId, { owner, state });
  emit();
}

/** Unregister `owner`'s chrome — IDENTITY-CHECKED, so a stale cleanup cannot wipe a slot
 *  another instance has since taken over. */
export function clearSurfaceChrome(terminalId: string, owner: object): void {
  if (chrome.get(terminalId)?.owner !== owner) return;
  chrome.delete(terminalId);
  emit();
}

/** Subscribe to any registry change. Returns the unsubscribe. */
export function subscribeSurfaceChrome(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * This terminal's chrome, or `null` when nothing is publishing it.
 *
 * `null` is the normal state for a terminal that has never been mounted, and for the window
 * between a `TerminalDisplay` unmounting and the next one publishing. Consumers render nothing.
 *
 * Pass `null` for `terminalId` to opt out. Every canvas node calls this and only the overlaid
 * one draws anything, so an opted-out node's snapshot is a constant — `useSyncExternalStore`
 * compares with `Object.is` and never re-renders it. Without that, a scroll in one terminal
 * would wake every node on the canvas to compute a value it does not use.
 */
export function useSurfaceChrome(terminalId: string | null): SurfaceChromeState | null {
  const getSnapshot = useCallback(
    () => (terminalId === null ? null : chrome.get(terminalId)?.state ?? null),
    [terminalId],
  );
  return useSyncExternalStore(subscribeSurfaceChrome, getSnapshot, getSnapshot);
}

/**
 * Whether ANYTHING is currently publishing chrome for `terminalId` — PRESENCE ONLY.
 *
 * `PaneContextMenu`'s Find item is the caller this exists for (`plan/027` R2). Reading
 * `getSurfaceChrome` at render, as it first did, freezes the answer for as long as the menu is
 * open: the item stays greyed out after the pane's terminal finishes starting and becomes
 * searchable, and stays enabled after an MCP client closes that terminal — then silently does
 * nothing when clicked, because the click re-reads the registry and finds nothing.
 *
 * A BOOLEAN snapshot is what makes subscribing affordable, and that is the whole design here:
 * `useSyncExternalStore` compares snapshots with `Object.is`, so a publish that merely changed
 * the query or `atBottom` returns the same `true` and re-renders nothing. Only availability
 * actually flipping wakes the consumer. Subscribing with `useSurfaceChrome` instead would
 * deliver every write in the registry — the chrome is republished on nearly every keystroke —
 * which is exactly the per-keystroke re-render the menu avoided by not subscribing at all.
 *
 * `null` opts out and always reads `false`, exactly as `useSurfaceChrome`'s `null` does: a pane
 * with no terminal has no id to ask about, and a hook cannot be called conditionally.
 */
export function useSurfaceChromeAvailable(terminalId: string | null): boolean {
  const getSnapshot = useCallback(
    () => (terminalId !== null && chrome.has(terminalId)),
    [terminalId],
  );
  return useSyncExternalStore(subscribeSurfaceChrome, getSnapshot, getSnapshot);
}

/**
 * This terminal's chrome WITHOUT subscribing — for a click handler that reads once.
 *
 * `PaneContextMenu` is the caller this exists for (`plan/027` §2.2). It only needs the value at
 * the moment a menu item is clicked, and `useSurfaceChrome` would sign it up for every write in
 * the registry: the chrome is republished on nearly every keystroke, so the hook would re-render
 * an open menu constantly for a value it reads once.
 *
 * What it must NOT be used for is deciding what the menu DRAWS. An item that looks live but
 * calls nothing is worse than a disabled one, and a value read at render never changes again
 * while the menu is open — `useSurfaceChromeAvailable` above is the render-time half, and this
 * is the click-time one. The `?.` at a call site is what covers the gap between them.
 */
export function getSurfaceChrome(terminalId: string): SurfaceChromeState | null {
  return chrome.get(terminalId)?.state ?? null;
}

/** Test-only alias of `getSurfaceChrome`, kept because the existing suites read by this name. */
export function __getSurfaceChromeForTest(terminalId: string): SurfaceChromeState | null {
  return getSurfaceChrome(terminalId);
}

/** Test-only: drop all registrations and subscribers between cases. */
export function __resetSurfaceChromeForTest(): void {
  chrome.clear();
  listeners.clear();
}
