/**
 * The Automations panel's whole data layer (plan 028 §5.3).
 *
 * **No Redux slice.** Nothing outside the Settings subtree reads automation rules — `PeersPanel`
 * puts peers in Redux only because `<GlobalPeerRequests>` needs them app-wide, and this feature has
 * no such consumer. State lives in the panel, which also means it is gone when the panel unmounts
 * and cannot go stale in the background.
 *
 * **The subscriptions are registered before the first fetch, and that ordering is load-bearing.**
 * The log is append-only with no second chance: an entry written between "we asked for the list"
 * and "we started listening" would be lost forever, and nothing downstream could tell. §10.27
 * asserts the order rather than trusting the reading order of this file.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AutomationLogEntry, AutomationRule } from '../../../types/electron';
import type { AutomationStatePayload } from '../../../services/automationEvents';
import {
    AUTOMATION_ACTIVITY,
    AUTOMATION_CHANGED,
    AUTOMATION_STATE,
} from '../../../services/automationEvents';
import { mergeEntries } from './activityLog';

/**
 * The log the panel holds in memory. The store keeps 200 per rule; holding more here would be a
 * buffer of rows the backend has already dropped.
 */
export const LOG_BUFFER_MAX = 200;

export interface LogScope {
    /** `null` = every rule ("All automations"). */
    ruleId: string | null;
    /**
     * Q8: the drawer is a recent-activity peek (newest first), the full log is a timeline you read
     * forward (oldest first). Both as drawn — they are different questions.
     */
    newestFirst: boolean;
}

export interface UseAutomations {
    rules: AutomationRule[];
    runtime: AutomationStatePayload;
    log: AutomationLogEntry[];
    logScope: LogScope | null;
    loading: boolean;
    /** The rule list could not be read. Distinct from "there are no rules". */
    error: string | null;
    /** The log could not be read. Separate from `error`: the log view replaces the list. */
    logError: string | null;
    /** The desktop bridge is absent — the browser host has no rule store to talk to. */
    unavailable: boolean;
    /** This window's label, passed to every mutating command so the log can name it. */
    origin: string;
    setLogScope: (scope: LogScope | null) => void;
    refresh: () => Promise<void>;
}

const EMPTY_RUNTIME: AutomationStatePayload = { rules: {} };

export function useAutomations(): UseAutomations {
    const [rules, setRules] = useState<AutomationRule[]>([]);
    const [runtime, setRuntime] = useState<AutomationStatePayload>(EMPTY_RUNTIME);
    const [log, setLog] = useState<AutomationLogEntry[]>([]);
    const [logScope, setLogScope] = useState<LogScope | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [logError, setLogError] = useState<string | null>(null);
    const [unavailable, setUnavailable] = useState(false);
    const [origin, setOrigin] = useState('main');

    // The effect below re-runs when the scope changes, and an in-flight response from the previous
    // scope must not land in the new one's buffer.
    const scopeRef = useRef<LogScope | null>(null);
    scopeRef.current = logScope;

    // A MONOTONIC GENERATION, not an `alive` boolean, and the difference is not cosmetic.
    //
    // A shared `aliveRef` cannot tell effect instances apart. React double-invokes effects under
    // StrictMode, and any remount does the same thing more slowly: instance 1 sets it false on
    // cleanup, instance 2 immediately sets it true, and instance 1's in-flight response then finds
    // a `true` flag that was set for somebody else and commits itself over the top. A counter
    // cannot be confused that way, because the value each caller captured is unique to it. This is
    // the guard `SettingsPage.tsx` already uses for its launch-at-login and file-manager readbacks,
    // for exactly this reason.
    const genRef = useRef(0);

    const fetchRules = useCallback(async () => {
        const gen = genRef.current;
        const api = window.electronAPI;
        if (!api?.listAutomations || !api.getAutomationRuntime) {
            setUnavailable(true);
            setLoading(false);
            return;
        }
        try {
            const [list, state] = await Promise.all([
                api.listAutomations(),
                api.getAutomationRuntime(),
            ]);
            if (genRef.current !== gen) return;
            setRules(list);
            setRuntime(state);
            setError(null);
        } catch (e) {
            if (genRef.current !== gen) return;
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (genRef.current === gen) setLoading(false);
        }
    }, []);

    const fetchLog = useCallback(async () => {
        const gen = genRef.current;
        const scope = scopeRef.current;
        const api = window.electronAPI;
        if (!scope || !api?.loadAutomationLog) return;
        try {
            const rows = await api.loadAutomationLog(
                scope.ruleId,
                scope.newestFirst,
                LOG_BUFFER_MAX,
            );
            if (genRef.current !== gen || scopeRef.current !== scope) return;
            // Merged rather than replaced: an `automation:activity` event can arrive while this
            // request is in flight, and the entry it stands for must not be dropped by a response
            // that was assembled before it existed.
            setLog((prev) => mergeEntries(prev, rows, scope.newestFirst, LOG_BUFFER_MAX));
            setLogError(null);
        } catch (e) {
            if (genRef.current !== gen || scopeRef.current !== scope) return;
            // This used to be swallowed, on the reasoning that "the list already reports the
            // connection". It does not: the log is a FULL-WIDTH REPLACEMENT of the list, so the
            // list's error line is not on screen at all while the log is showing — and the log then
            // rendered "Nothing logged yet. Entries appear as soon as the rule makes a decision",
            // which is a confident, specific lie about a store that is refusing to answer. §7.8
            // assigns the `Disabled` state to the panel AND the log view, separately, for this
            // reason.
            setLogError(e instanceof Error ? e.message : String(e));
        }
    }, []);

    // --- Subscriptions, then the first fetch. In that order, always. ---
    useEffect(() => {
        const gen = ++genRef.current;
        const isCurrent = () => genRef.current === gen;
        // Collected AS THEY ARRIVE rather than assigned once at the end. `Promise.all` rejects on
        // the first failure and abandons the other results, so one `listen` that failed used to
        // strand the one or two that had already succeeded: their unlisten functions were never
        // bound to anything, and those subscriptions outlived the component with nothing able to
        // reach them.
        const unlisteners: Array<() => void> = [];

        const track = async (
            listen: (
                name: string,
                handler: (event: { payload: unknown }) => void,
            ) => Promise<() => void>,
            name: string,
            handler: (event: { payload: unknown }) => void,
        ) => {
            const un = await listen(name, (event) => {
                // A listener belonging to a superseded instance must not act, even in the window
                // between this instance being retired and its unlisten landing.
                if (isCurrent()) handler(event);
            });
            unlisteners.push(un);
        };

        void (async () => {
            try {
                const { listen } = await import('@tauri-apps/api/event');
                const { getCurrentWindow } = await import('@tauri-apps/api/window');
                // The dynamic import is the one long suspension point where this instance can be
                // replaced, and nothing below is worth doing for an instance that already has been.
                if (!isCurrent()) return;
                setOrigin(getCurrentWindow().label);

                await Promise.all([
                    track(listen, AUTOMATION_CHANGED, () => {
                        void fetchRules();
                        void fetchLog();
                    }),
                    track(listen, AUTOMATION_STATE, (event) => {
                        const payload = event.payload as AutomationStatePayload | undefined;
                        if (payload && typeof payload === 'object' && 'rules' in payload) {
                            setRuntime(payload);
                        }
                    }),
                    track(listen, AUTOMATION_ACTIVITY, () => {
                        void fetchLog();
                    }),
                ]);
                if (!isCurrent()) {
                    unlisteners.splice(0).forEach((un) => un());
                    return;
                }
            } catch {
                // Not running under Tauri (the browser host, or a unit test with no event API).
                // Whatever did register is already in `unlisteners`, so cleanup still drops it.
            }
            if (isCurrent()) await fetchRules();
        })();

        return () => {
            // Bumping the generation is what retires this instance: every guard above compares
            // against the value it captured, so nothing from here on can commit.
            genRef.current += 1;
            unlisteners.splice(0).forEach((un) => un());
        };
    }, [fetchRules, fetchLog]);

    // Opening the log, or switching scope, drops the old buffer before fetching the new one —
    // otherwise "this rule" would briefly show another rule's history under a heading naming this
    // one, which is worse than showing nothing.
    useEffect(() => {
        if (!logScope) {
            setLog([]);
            setLogError(null);
            return;
        }
        setLog([]);
        setLogError(null);
        void fetchLog();
    }, [logScope, fetchLog]);

    return {
        rules,
        runtime,
        log,
        logScope,
        loading,
        error,
        logError,
        unavailable,
        origin,
        setLogScope,
        refresh: fetchRules,
    };
}
