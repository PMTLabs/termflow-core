/**
 * *Insert snippet…* — the saved-snippet picker for a message textbox (plan 042 P1).
 *
 * **The same flyout the terminal's right-click menu carries, opened on its own** — `ContextMenu`'s
 * `standaloneSubmenu` path, exactly as `TerminalDisplay` opens it from the keyboard — but in
 * `pickOnly` mode: a row hands its text to `onInsert` and nothing else, so the panel that hosts this
 * button splices it at the caret and the message is never sent, never re-scanned and never
 * substituted on the way in. Copy/Edit/Delete/Add-New stay in Settings and the terminal menu.
 *
 * **Why the store is read off `window`, not imported.** The panels mount under a bare root with no
 * Provider (`AutomationEditor.tsx`'s `toast` explains the idiom), and their tests mount them the same
 * way. `import { store } from '../../../store'` is not a cheap import: `store/index.ts` pulls in
 * `StateManager`, which pulls in the whole terminal component tree down to `api/tauri-bridge.ts`,
 * whose module-level `listen(...)` calls need Tauri internals that only the editor lifecycle tests
 * mock. `store/index.ts` publishes the same singleton as `window.__REDUX_STORE__` the moment it
 * loads — which in the app is before any panel can render — and `hiddenAgentTerminals.ts` and
 * `App.tsx` already read it that way. `openSettings.ts` imports the store too, hence the lazy import.
 */
import React, { useCallback, useSyncExternalStore } from 'react';
import type { AppDispatch, RootState } from '../../../store';
import {
    recordSnippetUse,
    setSnippetsSortMode,
    setSnippetsViewMode,
} from '../../../store/slices/settingsSlice';
import type { Snippet } from '../../../store/slices/settingsSlice';
import { nextSnippetSortMode } from '../../../services/snippetSearch';
import { ContextMenu } from '../../Terminal/ContextMenu';
import { buildSnippetsMenuItem } from '../../Terminal/snippetsHistoryMenu';

interface AppStore {
    subscribe: (listener: () => void) => () => void;
    getState: () => RootState;
    dispatch: AppDispatch;
}

const appStore = (): AppStore | undefined =>
    (window as Window & { __REDUX_STORE__?: AppStore }).__REDUX_STORE__;

/** A STABLE empty snapshot: `useSyncExternalStore` re-renders forever on a fresh `[]` per read. */
const NO_SNIPPETS: Snippet[] = [];

const subscribe = (listener: () => void): (() => void) => appStore()?.subscribe(listener) ?? (() => {});
const readSnippets = (): Snippet[] => appStore()?.getState().settings.snippets ?? NO_SNIPPETS;
const readViewMode = () => appStore()?.getState().settings.snippetsViewMode ?? 'flat';
const readSortMode = () => appStore()?.getState().settings.snippetsSortMode ?? 'lastUsed';

export interface SnippetPickerButtonProps {
    /** Receives the picked snippet's exact `text`; the host splices it into its own field. */
    onInsert: (text: string) => void;
}

export const SnippetPickerButton: React.FC<SnippetPickerButtonProps> = ({ onInsert }) => {
    const snippets = useSyncExternalStore(subscribe, readSnippets);
    const viewMode = useSyncExternalStore(subscribe, readViewMode);
    const sortMode = useSyncExternalStore(subscribe, readSortMode);
    const [point, setPoint] = React.useState<{ x: number; y: number } | null>(null);
    const buttonRef = React.useRef<HTMLButtonElement | null>(null);
    // Closing removes the flyout's focused search box, which would park focus on `<body>` — the
    // state the editor documents as "Escape closes nothing until you click". Hand it back to the
    // button; after a pick, the host panel's `restoreCaret` then moves it on to the textarea.
    const close = useCallback(() => {
        setPoint(null);
        buttonRef.current?.focus();
    }, []);

    return (
        <>
            <button
                ref={buttonRef}
                type="button"
                className="au-token au-snippet-btn"
                aria-label="Insert a saved snippet"
                title="Insert a saved snippet at the caret. Search by name, text, tag, or initials."
                onClick={(event) => {
                    // Anchored under the button rather than at the pointer, so it opens in the same
                    // place whether it was clicked or reached by keyboard.
                    const rect = event.currentTarget.getBoundingClientRect();
                    setPoint({ x: rect.left, y: rect.bottom + 4 });
                }}
            >
                ✂️ Insert snippet…
            </button>
            {point && (
                <ContextMenu
                    x={point.x}
                    y={point.y}
                    // Above `.au-editor` (z-index 9990): the menu is portalled to `body` and would
                    // otherwise paint BEHIND the editor overlay it was opened from.
                    className="au-snippet-picker"
                    standaloneSubmenu={0}
                    items={[buildSnippetsMenuItem({
                        snippets,
                        viewMode,
                        sortMode,
                        pickOnly: true,
                        insert: onInsert,
                        onUse: (id) => appStore()?.dispatch(recordSnippetUse(id)),
                        onToggleViewMode: () => appStore()?.dispatch(
                            setSnippetsViewMode(viewMode === 'flat' ? 'folders' : 'flat'),
                        ),
                        onCycleSortMode: () => appStore()?.dispatch(
                            setSnippetsSortMode(nextSnippetSortMode(sortMode)),
                        ),
                        onOpenSettings: () => {
                            close();
                            void import('../../../services/openSettings')
                                .then(({ openSettingsTab }) => openSettingsTab('snippets'));
                        },
                    })]}
                    onClose={close}
                />
            )}
        </>
    );
};
