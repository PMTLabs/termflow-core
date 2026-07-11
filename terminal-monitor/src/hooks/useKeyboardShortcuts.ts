import { useEffect, useCallback, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../store/store';
import { selectTerminal } from '../store/slices/terminalsSlice';
import terminalApiService from '../services/terminalApiService';

interface ShortcutHandler {
  handler: (event: KeyboardEvent) => void;
  description: string;
}

interface ShortcutMap {
  [key: string]: ShortcutHandler;
}

export const useKeyboardShortcuts = () => {
  const dispatch = useDispatch<AppDispatch>();
  const terminals = useSelector(
    (state: RootState) => state.terminals.terminals
  );
  const selectedTerminalId = useSelector(
    (state: RootState) => state.terminals.selectedTerminalId
  );
  const shortcutsRef = useRef<ShortcutMap>({});

  // Helper function to get key combination string
  const getKeyCombo = useCallback((event: KeyboardEvent): string => {
    const keys: string[] = [];

    if (event.ctrlKey) keys.push('ctrl');
    if (event.altKey) keys.push('alt');
    if (event.shiftKey) keys.push('shift');
    if (event.metaKey) keys.push('meta');

    // Normalize key names
    let key = event.key.toLowerCase();
    if (key === ' ') key = 'space';
    if (key === 'escape') key = 'esc';

    keys.push(key);

    return keys.join('+');
  }, []);

  // Clear terminal output
  const clearTerminal = useCallback(() => {
    if (selectedTerminalId) {
      // Clear terminal via API if available
      console.log('Clearing terminal:', selectedTerminalId);
      // You might want to add a clearTerminal action to your slice
    }
  }, [selectedTerminalId]);

  // Copy terminal output
  const copyOutput = useCallback(() => {
    if (selectedTerminalId) {
      // Get terminal output and copy to clipboard
      const outputElement = document.querySelector('.xterm-screen');
      if (outputElement) {
        const text = outputElement.textContent || '';
        navigator.clipboard.writeText(text).then(() => {
          console.log('Terminal output copied to clipboard');
        });
      }
    }
  }, [selectedTerminalId]);

  // Paste to input
  const pasteToInput = useCallback(async () => {
    try {
      const text = await navigator.clipboard.readText();
      const inputElement = document.querySelector(
        'input[placeholder*="command"]'
      ) as HTMLInputElement;
      if (inputElement) {
        inputElement.value = text;
        inputElement.focus();
        // Dispatch input event to trigger React's onChange
        const event = new Event('input', { bubbles: true });
        inputElement.dispatchEvent(event);
      }
    } catch (err) {
      console.error('Failed to read clipboard:', err);
    }
  }, []);

  // Create new terminal
  const createNewTerminal = useCallback(() => {
    // This would need to be implemented based on your terminal creation logic
    console.log('Create new terminal shortcut triggered');
  }, []);

  // Close current terminal
  const closeTerminal = useCallback(() => {
    if (selectedTerminalId && window.confirm('Close current terminal?')) {
      // Dispatch delete terminal action
      console.log('Close terminal:', selectedTerminalId);
    }
  }, [selectedTerminalId]);

  // Navigate to next terminal
  const nextTerminal = useCallback(() => {
    if (terminals.length > 1 && selectedTerminalId) {
      const currentIndex = terminals.findIndex(
        (t) => t.id === selectedTerminalId
      );
      const nextIndex = (currentIndex + 1) % terminals.length;
      dispatch(selectTerminal(terminals[nextIndex].id));
    }
  }, [terminals, selectedTerminalId, dispatch]);

  // Navigate to previous terminal
  const previousTerminal = useCallback(() => {
    if (terminals.length > 1 && selectedTerminalId) {
      const currentIndex = terminals.findIndex(
        (t) => t.id === selectedTerminalId
      );
      const prevIndex =
        currentIndex === 0 ? terminals.length - 1 : currentIndex - 1;
      dispatch(selectTerminal(terminals[prevIndex].id));
    }
  }, [terminals, selectedTerminalId, dispatch]);

  // Open search
  const openSearch = useCallback(() => {
    // Focus on search input or open search dialog
    const searchInput = document.querySelector(
      'input[type="search"]'
    ) as HTMLInputElement;
    if (searchInput) {
      searchInput.focus();
    }
  }, []);

  // Close focused modal/dialog
  const closeFocusedModal = useCallback(() => {
    // Close any open dialog or modal
    const closeButton = document.querySelector(
      '[aria-label="close"]'
    ) as HTMLElement;
    if (closeButton) {
      closeButton.click();
    }
  }, []);

  // Initialize shortcuts
  useEffect(() => {
    shortcutsRef.current = {
      'ctrl+k': { handler: clearTerminal, description: 'Clear terminal' },
      'ctrl+shift+c': {
        handler: copyOutput,
        description: 'Copy terminal output',
      },
      'ctrl+shift+v': {
        handler: pasteToInput,
        description: 'Paste to command input',
      },
      'ctrl+t': {
        handler: createNewTerminal,
        description: 'Create new terminal',
      },
      'ctrl+w': {
        handler: closeTerminal,
        description: 'Close current terminal',
      },
      'ctrl+tab': { handler: nextTerminal, description: 'Next terminal' },
      'ctrl+shift+tab': {
        handler: previousTerminal,
        description: 'Previous terminal',
      },
      'ctrl+f': { handler: openSearch, description: 'Open search' },
      esc: { handler: closeFocusedModal, description: 'Close dialog/modal' },
    };
  }, [
    clearTerminal,
    copyOutput,
    pasteToInput,
    createNewTerminal,
    closeTerminal,
    nextTerminal,
    previousTerminal,
    openSearch,
    closeFocusedModal,
  ]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Don't trigger shortcuts when typing in input fields
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
        // Allow Escape key even in inputs
        if (event.key !== 'Escape') {
          return;
        }
      }

      const keyCombo = getKeyCombo(event);
      const shortcut = shortcutsRef.current[keyCombo];

      if (shortcut) {
        event.preventDefault();
        shortcut.handler(event);
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [getKeyCombo]);

  // Return shortcuts for documentation/help display
  return {
    shortcuts: Object.entries(shortcutsRef.current).map(
      ([key, { description }]) => ({
        key,
        description,
      })
    ),
  };
};
