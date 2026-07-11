import React, { useEffect, useRef, useState, useCallback } from 'react';
import type { TerminalSearchOptions, TerminalSearchResult } from '@termflow/terminal-core';
import { formatMatchCount, isQueryValid } from './searchBarLogic';
import './TerminalSearchBar.css';

export interface TerminalSearchBarProps {
  // Run the query forward. incremental=true for as-you-type, false for "Next".
  onSearchNext: (query: string, opts: TerminalSearchOptions, incremental: boolean) => void;
  onSearchPrevious: (query: string, opts: TerminalSearchOptions) => void;
  onClear: () => void;
  onClose: () => void;
  // Subscribe to N-of-M updates; returns an unsubscribe function.
  subscribeResults: (cb: (r: TerminalSearchResult) => void) => () => void;
  // Changes on every Ctrl+F press; re-focuses + selects the input each time so a
  // repeat shortcut returns focus to the bar even when it's already open.
  focusToken: number;
}

export const TerminalSearchBar: React.FC<TerminalSearchBarProps> = ({
  onSearchNext,
  onSearchPrevious,
  onClear,
  onClose,
  subscribeResults,
  focusToken,
}) => {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<TerminalSearchResult>({ resultIndex: -1, resultCount: 0 });
  const inputRef = useRef<HTMLInputElement>(null);

  const opts: TerminalSearchOptions = { caseSensitive, wholeWord, regex };
  const valid = isQueryValid(query, regex);

  // Focus + select the input when the bar opens AND on every later Ctrl+F
  // (focusToken bumps each press), so a repeat shortcut pulls focus back here.
  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  // Feed the N-of-M counter.
  useEffect(() => subscribeResults(setResult), [subscribeResults]);

  // Re-run the search whenever the query or any option changes (as-you-type).
  useEffect(() => {
    if (!valid || query === '') {
      onClear();
      setResult({ resultIndex: -1, resultCount: 0 });
      return;
    }
    onSearchNext(query, opts, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, regex]);

  const goNext = useCallback(() => {
    if (valid && query) onSearchNext(query, opts, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, regex, valid]);

  const goPrev = useCallback(() => {
    if (valid && query) onSearchPrevious(query, opts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, caseSensitive, wholeWord, regex, valid]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Ctrl+F / Cmd+F while focused INSIDE the bar: the engine's intercept lives on
    // the terminal container (a sibling), so the event never reaches it and the
    // browser's native find dialog would open. Swallow it here and re-select the
    // query instead, so the shortcut behaves consistently anywhere in the app.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'f' || e.key === 'F')) {
      e.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
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
          onClick={() => setCaseSensitive((v) => !v)}
        >
          Aa
        </button>
        <button
          type="button"
          className={`tsb-toggle${wholeWord ? ' tsb-active' : ''}`}
          title="Match Whole Word"
          aria-pressed={wholeWord}
          onClick={() => setWholeWord((v) => !v)}
        >
          ab
        </button>
        <button
          type="button"
          className={`tsb-toggle${regex ? ' tsb-active' : ''}`}
          title="Use Regular Expression"
          aria-pressed={regex}
          onClick={() => setRegex((v) => !v)}
        >
          .*
        </button>
      </div>
      <button type="button" className="tsb-nav" title="Previous Match (Shift+Enter)" onClick={goPrev}>
        ↑
      </button>
      <button type="button" className="tsb-nav" title="Next Match (Enter)" onClick={goNext}>
        ↓
      </button>
      <button type="button" className="tsb-close" title="Close (Escape)" onClick={onClose}>
        ✕
      </button>
    </div>
  );
};
