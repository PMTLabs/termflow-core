/**
 * Which terminals run on a terminal host older than this build — published app-wide.
 *
 * A host outlives an update, so a restored tab can be served by the previous build's host. The
 * backend knows which host serves each terminal and answers `get_terminal_generations` with a
 * leaf id → `'current' | 'previous'` map; this module keeps the leaves that came back `previous`
 * and lets the tab strip ask whether any of a tab's leaves is one of them.
 *
 * A module singleton, the shape `automationArmed.ts` uses for the same reason: the tab strip is
 * rebuilt often and must not each hold a subscription and a fetch of its own. The snapshot a tab
 * reads is a boolean, so a change to some other tab's host wakes nothing here.
 *
 * Only the word `previous` marks a tab. A terminal missing from the map (no host yet, or a read
 * that failed) is not marked: the backend already folds "cannot be shown to be current" into
 * `previous`, so an absent entry is not that case and must not be painted as it.
 */
import { useCallback, useSyncExternalStore } from 'react';

/** Emitted by the backend when a terminal is registered on a host or forgotten. It carries
 *  nothing; the answer to it is a fresh `getTerminalGenerations()`. Mirrors
 *  `TERMINAL_GENERATIONS_EVENT` in `src-tauri/src/state/host_generation.rs`. */
export const TERMINAL_GENERATIONS = 'terminal:generations';

const NONE: ReadonlySet<string> = new Set();

let previousLeaves: ReadonlySet<string> = NONE;
const listeners = new Set<() => void>();
let started = false;
/** Guards a read against an older one landing after it. */
let fetchSeq = 0;

function emit(): void {
    listeners.forEach((listener) => listener());
}

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a.size !== b.size) return false;
    for (const id of a) if (!b.has(id)) return false;
    return true;
}

/** Take a reading from the backend. Safe to call concurrently: the last one asked for wins. */
export async function refreshHostGenerations(): Promise<void> {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI;
    if (!api?.getTerminalGenerations) return;
    const seq = ++fetchSeq;
    try {
        const generations = await api.getTerminalGenerations();
        if (seq !== fetchSeq) return;
        const next = new Set(
            Object.entries(generations ?? {})
                .filter(([, generation]) => generation === 'previous')
                .map(([leaf]) => leaf),
        );
        if (sameSet(previousLeaves, next)) return;
        previousLeaves = next.size === 0 ? NONE : next;
        emit();
    } catch {
        // Keep the last reading. A failed read is no evidence that nothing is on an older host, and
        // clearing the markers on one bad call would hide exactly what the user needs to see.
    }
}

/**
 * Subscribe to the backend's announcements, then take the first reading — in that order, so a
 * change between asking and listening is not lost. Never torn down: one registration per window.
 */
async function ensureStarted(): Promise<void> {
    if (started) return;
    started = true;
    try {
        const { listen } = await import('@tauri-apps/api/event');
        await listen(TERMINAL_GENERATIONS, () => {
            void refreshHostGenerations();
        });
    } catch {
        // Not running under Tauri (the browser host, or a unit test with no event API). The read
        // below still gives a static answer.
    }
    await refreshHostGenerations();
}

function subscribe(listener: () => void): () => void {
    void ensureStarted();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** True when any of `terminalIds` runs on an older host. */
export function anyOnPreviousHost(terminalIds: readonly string[]): boolean {
    return terminalIds.some((id) => previousLeaves.has(id));
}

/**
 * Whether any terminal in a tab runs on an older host — the tab strip's question. A tab with
 * several panes is marked when one of them is: the marker says the tab holds an old shell, and
 * which pane it is shows on the pane.
 *
 * Keyed on the joined ids rather than the array, which the caller rebuilds on every render.
 */
export function useAnyOnPreviousHost(terminalIds: readonly string[]): boolean {
    const key = terminalIds.join(' ');
    const getSnapshot = useCallback(() => anyOnPreviousHost(key === '' ? [] : key.split(' ')), [key]);
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Forget everything, so a test starts from nothing. */
export function __resetHostGenerationsForTest(): void {
    previousLeaves = NONE;
    started = false;
    fetchSeq = 0;
    listeners.clear();
}
