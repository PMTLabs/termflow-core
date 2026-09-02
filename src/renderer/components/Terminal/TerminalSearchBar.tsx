import React, { useEffect, useRef } from 'react';
import { isFindShortcut } from '@termflow/terminal-core';
import type { SearchViewState } from './useTerminalSearch';
import { formatMatchCount, isQueryValid } from './searchBarLogic';
import './TerminalSearchBar.css';

/**
 * The in-terminal find bar. PURELY PRESENTATIONAL since `plan/027` §1.3 — every piece of state
 * it draws, and the only effects that touch the engine, live in `useTerminalSearch`.
 *
 * That is what makes it safe to render on two surfaces at once. While it owned its own state,
 * a second instance mounting on the Canvas overlay ran the as-you-type effect with an empty
 * query and called `clearSearch()`, wiping the live search the pane's instance was showing.
 * Now the only things left here are an `inputRef`, the focus effect and key handling — no
 * engine call, nothing another instance can undo.
 */
export interface TerminalSearchBarProps {
  search: SearchViewState;
}

export const TerminalSearchBar: React.FC<TerminalSearchBarProps> = ({ search }) => {
  const {
    query, caseSensitive, wholeWord, regex, result, focusToken,
    setQuery, toggleCaseSensitive, toggleWholeWord, toggleRegex, next, previous, close,
  } = search;
  const inputRef = useRef<HTMLInputElement>(null);
  // Same test as everywhere else in the app (TerminalDisplay.tsx:116): what "the find shortcut"
  // is differs by platform, and this bar has to ask the same question the two listeners around
  // it ask.
  const isMac = typeof navigator !== 'undefined' && !!navigator.platform?.includes('Mac');

  const valid = isQueryValid(query, regex);

  // Focus + select the input when the bar opens AND on every later Ctrl+F
  // (focusToken bumps each press), so a repeat shortcut pulls focus back here.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Escape closes from ANYWHERE in the bar — the input, a toggle, either nav button. It is
    // the one binding the whole bar shares, and it steals nothing: no control here treats
    // Escape as its own activation.
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    // Ctrl+F / Cmd+F while focused INSIDE the bar. In a PANE the engine's intercept is
    // bound to the terminal container — a SIBLING of this bar, not an ancestor
    // (TerminalEngine.ts wires it on the pane container) — so the event never reaches it
    // and the WebView's native find dialog would open instead. Swallow it here and
    // re-select the query, so the shortcut behaves the same anywhere in the app.
    //
    // The predicate is IMPORTED rather than spelled out again, and that is a fix, not tidying:
    // a hand-written `(e.ctrlKey || e.metaKey)` disagreed with `isFindShortcut` on macOS, where
    // plain Ctrl+F is deliberately NOT find. The overlay's `useSearchHotkey` therefore ignores
    // it, it arrives here, and this arm used to preventDefault the system's forward-char
    // binding and select-all the query mid-edit. One predicate, one answer, on every surface.
    //
    // NOT gated to the input, unlike Enter below: the whole point of this arm is that nothing
    // else between the bar and the WebView will swallow the combo, and that is just as true
    // when focus is on a toggle button. Unlike Enter it suppresses no button activation.
    if (isFindShortcut(e, isMac)) {
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    // Enter belongs to the INPUT alone. This handler is bound on the BAR, so without the
    // target test a keyboard user who tabs to Match Case / Whole Word / Regex / ↑ / ↓ / ✕ and
    // presses Enter had the button's activation preventDefault()ed and the search advanced
    // instead: the toggle never flipped and the close button never closed.
    if (e.key === 'Enter' && e.target === inputRef.current) {
      e.preventDefault();
      if (e.shiftKey) previous();
      else next();
    }
  };

  return (
    <div className="terminal-search-bar" onKeyDown={onKeyDown}>
      <input
        ref={inputRef}
        className={`tsb-input${valid ? '' : ' tsb-input-invalid'}`}
        type="text"
        placeholder="Find"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        spellCheck={false}
        aria-label="Find in terminal"
      />
      <span className="tsb-count">{formatMatchCount(result)}</span>
      <div className="tsb-toggles">
        <button
          type="button"
          className={`tsb-toggle${caseSensitive ? ' tsb-active' : ''}`}
          title="Match Case"
          aria-pressed={caseSensitive}
          onClick={toggleCaseSensitive}
        >
          Aa
        </button>
        <button
          type="button"
          className={`tsb-toggle${wholeWord ? ' tsb-active' : ''}`}
          title="Match Whole Word"
          aria-pressed={wholeWord}
          onClick={toggleWholeWord}
        >
          ab
        </button>
        <button
          type="button"
          className={`tsb-toggle${regex ? ' tsb-active' : ''}`}
          title="Use Regular Expression"
          aria-pressed={regex}
          onClick={toggleRegex}
        >
          .*
        </button>
      </div>
      <button type="button" className="tsb-nav" title="Previous Match (Shift+Enter)" onClick={previous}>
        ↑
      </button>
      <button type="button" className="tsb-nav" title="Next Match (Enter)" onClick={next}>
        ↓
      </button>
      <button type="button" className="tsb-close" title="Close (Escape)" onClick={close}>
        ✕
      </button>
    </div>
  );
};
