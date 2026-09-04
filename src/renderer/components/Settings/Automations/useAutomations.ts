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
    error: string | null;
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
    const [unavailable, setUnavailable] = useState(false);
    const [origin, setOrigin] = useState('main');

    // The effect below re-runs when the scope changes, and an in-flight response from the previous
    // scope must not land in the new one's buffer.
    const scopeRef = useRef<LogScope | null>(null);
    scopeRef.current = logScope;
    const aliveRef = useRef(true);

    const fetchRules = useCallback(async () => {
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
            if (!aliveRef.current) return;
            setRules(list);
            setRuntime(state);
            setError(null);
        } catch (e) {
            if (!aliveRef.current) return;
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (aliveRef.current) setLoading(false);
        }
    }, []);

    const fetchLog = useCallback(async () => {
        const scope = scopeRef.current;
        const api = window.electronAPI;
        if (!scope || !api?.loadAutomationLog) return;
        try {
            const rows = await api.loadAutomationLog(
                scope.ruleId,
                scope.newestFirst,
                LOG_BUFFER_MAX,
            );
            if (!aliveRef.current || scopeRef.current !== scope) return;
            // Merged rather than replaced: an `automation:activity` event can arrive while this
            // request is in flight, and the entry it stands for must not be dropped by a response
            // that was assembled before it existed.
            setLog((prev) => mergeEntries(prev, rows, scope.newestFirst, LOG_BUFFER_MAX));
        } catch {
            /* the list already reports the connection; a log failure is not worth a second banner */
        }
    }, []);

    // --- Subscriptions, then the first fetch. In that order, always. ---
    useEffect(() => {
        aliveRef.current = true;
        let unlisteners: Array<() => void> = [];
        let cancelled = false;

        void (async () => {
            try {
                const { listen } = await import('@tauri-apps/api/event');
                const { getCurrentWindow } = await import('@tauri-apps/api/window');
                if (!cancelled) setOrigin(getCurrentWindow().label);
                const subs = await Promise.all([
                    listen(AUTOMATION_CHANGED, () => {
                        void fetchRules();
                        void fetchLog();
                    }),
                    listen(AUTOMATION_STATE, (event: { payload: unknown }) => {
                        const payload = event.payload as AutomationStatePayload | undefined;
                        if (payload && typeof payload === 'object' && 'rules' in payload) {
                            setRuntime(payload);
                        }
                    }),
                    listen(AUTOMATION_ACTIVITY, () => {
                        void fetchLog();
                    }),
                ]);
                if (cancelled) {
                    subs.forEach((un) => un());
                    return;
                }
                unlisteners = subs;
            } catch {
                // Not running under Tauri (the browser host, or a unit test with no event API).
                // The panel still fetches once and renders whatever the bridge gives it.
            }
            if (!cancelled) await fetchRules();
        })();

        return () => {
            cancelled = true;
            aliveRef.current = false;
            unlisteners.forEach((un) => un());
        };
    }, [fetchRules, fetchLog]);

    // Opening the log, or switching scope, drops the old buffer before fetching the new one —
    // otherwise "this rule" would briefly show another rule's history under a heading naming this
    // one, which is worse than showing nothing.
    useEffect(() => {
        if (!logScope) {
            setLog([]);
            return;
        }
        setLog([]);
        void fetchLog();
    }, [logScope, fetchLog]);

    return {
        rules,
        runtime,
        log,
        logScope,
        loading,
        error,
        unavailable,
        origin,
        setLogScope,
        refresh: fetchRules,
    };
}
