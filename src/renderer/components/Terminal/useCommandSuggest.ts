import { useCallback, useRef, useState, type MutableRefObject } from 'react';
import type { TerminalEngine, SuggestAction } from '@termflow/terminal-core';
import { commandHistoryService } from '../../services/commandHistoryService';
import { moveSelection, PopupAnchor } from './suggestLogic';

export interface SuggestViewState {
  open: boolean;
  items: string[];
  selectedIndex: number;
  focused: boolean;
  anchor: PopupAnchor | null;
}

const CLOSED: SuggestViewState = {
  open: false,
  items: [],
  selectedIndex: 0,
  focused: false,
  anchor: null,
};

/** Owns the suggest popup's view state (backlog 011). The engine owns key
 *  interception and reports actions here; this hook owns what is shown and
 *  tells the engine the popup state back (closed/passive/focused). */
export function useCommandSuggest(engineRef: MutableRefObject<TerminalEngine | null>) {
  const [state, setState] = useState<SuggestViewState>(CLOSED);
  const stateRef = useRef(state);
  stateRef.current = state;

  const close = useCallback(() => {
    engineRef.current?.setSuggestPopupState('closed');
    setState(CLOSED);
  }, [engineRef]);

  const onInputLineChanged = useCallback(
    (text: string) => {
      if (!text.trim()) {
        close();
        return;
      }
      const items = commandHistoryService.match(text);
      if (items.length === 0) {
        close();
        return;
      }
      const anchor = engineRef.current?.getCursorPixelPosition() ?? null;
      // Typing always returns the popup to passive (spec: focused + typing -> passive).
      engineRef.current?.setSuggestPopupState('passive');
      setState({ open: true, items, selectedIndex: 0, focused: false, anchor });
    },
    [close, engineRef],
  );

  const onAction = useCallback(
    (action: SuggestAction) => {
      const s = stateRef.current;
      if (!s.open) return;
      switch (action) {
        case 'focus':
          engineRef.current?.setSuggestPopupState('focused');
          setState({ ...s, focused: true });
          break;
        case 'down':
          setState({ ...s, selectedIndex: moveSelection(s.items.length, s.selectedIndex, 'down') });
          break;
        case 'up':
          setState({ ...s, selectedIndex: moveSelection(s.items.length, s.selectedIndex, 'up') });
          break;
        case 'accept': {
          const cmd = s.items[s.selectedIndex];
          if (cmd) engineRef.current?.insertCommand(cmd);
          close();
          break;
        }
        case 'delete': {
          const cmd = s.items[s.selectedIndex];
          if (!cmd) break;
          commandHistoryService.remove(cmd);
          const items = s.items.filter((_, i) => i !== s.selectedIndex);
          if (items.length === 0) {
            close();
          } else {
            setState({ ...s, items, selectedIndex: Math.min(s.selectedIndex, items.length - 1) });
          }
          break;
        }
        case 'dismiss':
          if (s.focused) {
            engineRef.current?.setSuggestPopupState('passive');
            setState({ ...s, focused: false });
          } else {
            close();
          }
          break;
      }
    },
    [close, engineRef],
  );

  const pick = useCallback(
    (command: string) => {
      engineRef.current?.insertCommand(command);
      close();
    },
    [close, engineRef],
  );

  return { ...state, onInputLineChanged, onAction, pick, close };
}
