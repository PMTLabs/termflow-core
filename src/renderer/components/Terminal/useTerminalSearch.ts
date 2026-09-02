import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { TerminalEngine, TerminalSearchOptions, TerminalSearchResult } from '@termflow/terminal-core';
import { isQueryValid } from './searchBarLogic';

/**
 * The in-terminal search bar's state, LIFTED out of `TerminalSearchBar` (`plan/027` §1.3).
 *
 * WHY IT HAD TO MOVE. The Canvas overlay draws a terminal at 1:1 while its pane is
 * `visibility:hidden`, so the pane's copy of the bar is unreachable there and `input.focus()`
 * on it is a silent no-op. Rendering a SECOND `TerminalSearchBar` on the overlay was not a
 * viable shape while the bar owned its own state:
 *
 *  - the as-you-type effect runs on MOUNT with `query === ''`, takes the empty arm and calls
 *    `engine.clearSearch()` — so a second instance mounting wiped the first one's live search;
 *  - both instances subscribed to the terminal-wide `onDidChangeResults`, so each would display
 *    the other's N-of-M counts.
 *
 * So this is the same move `useCommandSuggest` already made, for the same reason
 * (`surfaceChrome.ts` header): *one hook, one state, two possible homes*. The bar is now purely
 * presentational, has no effect that touches the engine, and is therefore safe to render on the
 * pane and the overlay at once — exactly the property that already lets `ScrollToBottomButton`
 * and `CommandSuggestPopup` do it.
 *
 * EVERY CALLBACK IS STABLE, and that is load-bearing rather than tidiness: this state is
 * published through `surfaceChrome`, whose `same()` compares published callbacks by IDENTITY to
 * decide whether a write is observable. A callback rebuilt per render would make every publish a
 * change and re-render every node on the canvas on every keystroke. `next`/`previous` therefore
 * read the live query and options through a ref instead of closing over them.
 */
export interface SearchViewState {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  /** Live N-of-M from the SearchAddon. */
  result: TerminalSearchResult;
  /** Bumps on every open request; the bar re-focuses + selects on each change. */
  focusToken: number;
  setQuery: (q: string) => void;
  toggleCaseSensitive: () => void;
  toggleWholeWord: () => void;
  toggleRegex: () => void;
  next: () => void;
  previous: () => void;
  close: () => void;
}

/**
 * What the OWNER of the state gets back: the view plus the trigger.
 *
 * `openSearch` is deliberately NOT part of `SearchViewState`: the view state is what a surface
 * needs in order to DRAW the bar, and the bar has no button that opens itself. The trigger is
 * published as its own `surfaceChrome` field because its callers — the engine's Ctrl+F listener,
 * both context menus, the canvas overlay's hotkey — never render anything.
 */
export interface TerminalSearchApi extends SearchViewState {
  /** Open the bar and pull focus into it; a repeat press re-focuses an already-open bar. */
  openSearch: () => void;
}

const NO_RESULT: TerminalSearchResult = { resultIndex: -1, resultCount: 0 };

/**
 * Owns the search bar's view state for one terminal.
 *
 * Takes the engine by REF, like `useCommandSuggest`, because `TerminalDisplay` constructs the
 * engine in an effect that runs after this hook's own: reading `engineRef.current` at call time
 * rather than at render time is what lets the two be declared in either order.
 *
 * `terminalId` is taken as well, and it is not decoration: it is the identity this state belongs
 * to, and none of the state below unmounts when that identity changes (see the reset effect).
 */
export function useTerminalSearch(
  engineRef: MutableRefObject<TerminalEngine | null>,
  terminalId: string,
): TerminalSearchApi {
  const [open, setOpen] = useState(false);
  const [query, setQueryState] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<TerminalSearchResult>(NO_RESULT);
  const [focusToken, setFocusToken] = useState(0);

  // The live query and options, for the callbacks that must not change identity when they
  // change. `next`/`previous` are published through `surfaceChrome` and compared by reference.
  const liveRef = useRef({ query, caseSensitive, wholeWord, regex });
  liveRef.current = { query, caseSensitive, wholeWord, regex };

  /**
   * RESET when the terminal underneath changes — the search belongs to the TERMINAL, not to this
   * component instance.
   *
   * `TerminalDisplay` is rendered without a key and `TerminalPane`'s reuse path lets `terminalId`
   * change on the SAME instance (`useSurfaceRelocation.ts`, review 098 A1). Nothing here unmounts
   * when it does: the engine effect tears down terminal A's engine and builds B's, while the bar
   * stays open showing A's query and the result subscription — keyed `[open, engineRef]`, neither
   * of which changed — stays attached to A's SearchAddon, so B's bar counts A's matches. Closing
   * is also what RE-ESTABLISHES the subscription: `open` going false disposes it, and the next
   * open attaches to whichever engine the ref holds by then.
   *
   * Keyed on `terminalId` and deliberately NOT on `useSurfaceRelocation`'s `engineGeneration`,
   * the other identity in this component. That one means "`engineRef.current` is populated and
   * belongs to the current terminalId" — the precondition a RELOCATION effect has to wait for,
   * and the one this effect must not. It is bumped by the engine effect AFTER that effect has
   * built B's engine, so keying on it would leave a commit in which the ref is already B and the
   * bar still holds A's query; `terminalId` changes on the render that starts the swap. (It is
   * also declared below this hook's call site, so it is not in scope here at all.)
   *
   * No engine call, unlike `close()`: this effect runs BEFORE the engine effect that swaps the
   * ref, so `engineRef.current` here is still the OUTGOING engine — which that effect's cleanup
   * unmounts moments later — and at mount it is null. The reset's job is to stop the bar
   * describing a terminal it is no longer over.
   */
  useEffect(() => {
    setOpen(false);
    setQueryState('');
    setCaseSensitive(false);
    setWholeWord(false);
    setRegex(false);
    setResult(NO_RESULT);
  }, [terminalId]);

  /**
   * Subscribed only WHILE THE BAR IS OPEN, and that is not an optimisation.
   *
   * The engine is built by an effect declared below this hook's call site, so on the first pass
   * `engineRef.current` is still null — a `[]`-keyed subscription would silently never attach and
   * the counter would sit at "0 of 0" forever. Keying on `open` reproduces exactly what the old
   * bar did by mounting: it subscribes at the first Ctrl+F, by which time the engine exists.
   */
  useEffect(() => {
    if (!open) return undefined;
    const sub = engineRef.current?.onSearchResults(setResult);
    return () => sub?.dispose();
  }, [open, engineRef]);

  /**
   * As-you-type. Re-runs on every change of the query or any option, incrementally, so the
   * highlight follows the keystrokes; an empty or unparseable query clears instead of throwing.
   *
   * Gated on `open` for the reason above: while the bar is closed there is nothing to feed and,
   * at mount, no engine to feed it to.
   */
  useEffect(() => {
    if (!open) return;
    if (!isQueryValid(query, regex) || query === '') {
      engineRef.current?.clearSearch();
      setResult(NO_RESULT);
      return;
    }
    engineRef.current?.searchNext(query, { caseSensitive, wholeWord, regex }, true);
  }, [open, query, caseSensitive, wholeWord, regex, engineRef]);

  const setQuery = useCallback((q: string) => setQueryState(q), []);
  const toggleCaseSensitive = useCallback(() => setCaseSensitive((v) => !v), []);
  const toggleWholeWord = useCallback(() => setWholeWord((v) => !v), []);
  const toggleRegex = useCallback(() => setRegex((v) => !v), []);

  const next = useCallback(() => {
    const { query: q, caseSensitive: c, wholeWord: w, regex: r } = liveRef.current;
    if (!q || !isQueryValid(q, r)) return;
    const o: TerminalSearchOptions = { caseSensitive: c, wholeWord: w, regex: r };
    engineRef.current?.searchNext(q, o, false);
  }, [engineRef]);

  const previous = useCallback(() => {
    const { query: q, caseSensitive: c, wholeWord: w, regex: r } = liveRef.current;
    if (!q || !isQueryValid(q, r)) return;
    const o: TerminalSearchOptions = { caseSensitive: c, wholeWord: w, regex: r };
    engineRef.current?.searchPrevious(q, o);
  }, [engineRef]);

  /**
   * Close, and reset EVERY field the bar drew — which is exactly what the old bar did by
   * unmounting, and the whole reason to say so here.
   *
   * Lifting the state out of the component removed the reset that came free with unmounting, so
   * it has to be performed deliberately or closing silently becomes "hide", and the next open
   * inherits a query and three toggles the user last used minutes ago. Query and flags reset
   * TOGETHER: resetting one and keeping the others is the only outcome that matches neither the
   * old behaviour nor a deliberate new one.
   *
   * (Re-opening with a preserved query would in fact work — `open` is in the as-you-type effect's
   * dependencies, so the search would re-run. Preserving it is a defensible product change; it is
   * just not the one this plan asked for, so the old behaviour stands.)
   *
   * Keyboard focus goes back to the engine so the shell is typeable again the instant the bar is
   * gone.
   */
  const close = useCallback(() => {
    engineRef.current?.clearSearch();
    setOpen(false);
    setQueryState('');
    setCaseSensitive(false);
    setWholeWord(false);
    setRegex(false);
    setResult(NO_RESULT);
    engineRef.current?.focus();
  }, [engineRef]);

  /**
   * The focus token bumps on EVERY request, not just the first: a second Ctrl+F while the bar is
   * already open must pull focus back out of the terminal, and `setOpen(true)` alone is a no-op
   * then, so nothing would re-run the bar's focus effect.
   */
  const openSearch = useCallback(() => {
    setOpen(true);
    setFocusToken((t) => t + 1);
  }, []);

  return {
    open,
    query,
    caseSensitive,
    wholeWord,
    regex,
    result,
    focusToken,
    setQuery,
    toggleCaseSensitive,
    toggleWholeWord,
    toggleRegex,
    next,
    previous,
    close,
    openSearch,
  };
}
