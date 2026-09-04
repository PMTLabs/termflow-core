/**
 * Which automation rules are armed on which terminal — published app-wide (`plan/028` item D).
 *
 * **Why this exists at all.** `Settings/Automations/useAutomations.ts` already subscribes to the
 * same two events, and its own header says why it may not be reused here: *"No Redux slice.
 * Nothing outside the Settings subtree reads automation rules."* That sentence was true until item
 * D, which asks four surfaces outside Settings — the tab strip, the pane title, the pane's context
 * menu and Canvas Mode — to say when a terminal is being watched. Four private copies of that hook
 * would mean four subscriptions, four fetches on every rule edit, and four chances to disagree
 * about what "armed" means, which is exactly the divergence `automationEvents.ts` was written to
 * make impossible one layer down.
 *
 * WHY A MODULE SINGLETON AND NOT A CONTEXT. The four consumers are not in one React tree: two of
 * the menus are `createPortal`ed to `document.body`, and Canvas Mode renders in its own tab. A
 * provider would have to wrap the app root and still be re-entered by the portals. This is the
 * shape `surfaceChrome.ts` already uses for a live per-terminal fact that crosses tree boundaries,
 * and it is copied from there deliberately, down to the `useSyncExternalStore` snapshot rules.
 *
 * WHY THE SNAPSHOTS ARE NARROW. Every canvas node subscribes, and `automation:state` is emitted up
 * to once a second while any rule is live. So the per-terminal snapshot is an ARRAY WHOSE IDENTITY
 * IS PRESERVED when nothing observable changed, and the tab's snapshot is a NUMBER. Without both,
 * one rule ticking would re-render the whole tab strip and every node on the canvas every second,
 * for a value that did not change. Same reasoning as `useSurfaceChromeAvailable`'s boolean.
 *
 * WHAT "ARMED" MEANS HERE. A terminal is armed by a rule when the engine reports a pair for it —
 * `runtime.rules[ruleId][terminalId]`. That is the engine's own answer and not a re-derivation of
 * it: a disabled rule is absent from the payload entirely, and a rule whose criterion currently
 * matches nothing reports an empty pair map. Deciding it here from `rule.enabled` + `targetIds`
 * would be a second implementation of targeting that drifts the first time the criteria change.
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { AutomationRule } from '../types/electron';
import type { AutomationRuntimePairState, AutomationStatePayload } from './automationEvents';
import { AUTOMATION_CHANGED, AUTOMATION_STATE } from './automationEvents';

/** One rule watching one terminal, paired with that terminal's own runtime state. */
export interface ArmedAutomation {
    rule: AutomationRule;
    pair: AutomationRuntimePairState;
}

/**
 * The snapshot for a terminal with nothing armed on it.
 *
 * A module constant, not a fresh `[]` per call: `useSyncExternalStore` compares snapshots with
 * `Object.is`, so returning a new empty array would re-render every unarmed consumer on every
 * store change — which, on a canvas with one automated terminal among thirty, is all of them.
 */
const EMPTY: ArmedAutomation[] = [];

let rules: AutomationRule[] = [];
let runtime: AutomationStatePayload = { rules: {} };
let index = new Map<string, ArmedAutomation[]>();
let origin = 'main';

const listeners = new Set<() => void>();

let started = false;
/** Guards a refetch against an older one landing after it. */
let fetchSeq = 0;
/** Bumped by every `automation:state` event, so a refetch can tell whether it is about to
 *  overwrite a runtime snapshot that is NEWER than the one it asked for. */
let runtimeStamp = 0;

function emit(): void {
    listeners.forEach((listener) => listener());
}

/**
 * True when two armed-lists describe the same thing.
 *
 * `rule` is compared BY IDENTITY and `pair` BY FIELD, and the split is the point rather than an
 * inconsistency. The rule array is replaced only by a refetch, which happens on `automation:changed`
 * — a user edit, and rare; every rule object is then new and every consumer should re-render, which
 * identity gives for free. The pair objects are replaced by `automation:state`, up to once a second
 * for as long as anything is live, and almost always with the same values. That is the flood this
 * function exists to absorb.
 */
function sameArmed(a: ArmedAutomation[], b: ArmedAutomation[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((entry, i) => {
        const other = b[i];
        return (
            entry.rule === other.rule
            && entry.pair.state === other.pair.state
            && entry.pair.lastFiredAt === other.pair.lastFiredAt
            && entry.pair.firedCount === other.pair.firedCount
            && entry.pair.missing === other.pair.missing
        );
    });
}

/**
 * Rebuild `index` from `rules` + `runtime`, then notify.
 *
 * Rules are walked in the panel's own order — `sortOrder`, then name — so "the first rule" is the
 * same rule on every surface. The badge shows one name and a `+N`, so which one it picks is a
 * user-visible decision and must not fall out of object key order.
 */
function reindex(): void {
    const next = new Map<string, ArmedAutomation[]>();
    const ordered = [...rules].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
    );
    for (const rule of ordered) {
        const pairs = runtime.rules[rule.id];
        if (!pairs) continue;
        for (const [terminalId, pair] of Object.entries(pairs)) {
            const list = next.get(terminalId);
            if (list) list.push({ rule, pair });
            else next.set(terminalId, [{ rule, pair }]);
        }
    }
    for (const [terminalId, list] of next) {
        const prev = index.get(terminalId);
        if (prev && sameArmed(prev, list)) next.set(terminalId, prev);
    }
    index = next;
    emit();
}

/** Re-read the rule list and the runtime payload. Safe to call concurrently. */
export async function refreshAutomationArmed(): Promise<void> {
    const api = typeof window === 'undefined' ? undefined : window.electronAPI;
    if (!api?.listAutomations || !api.getAutomationRuntime) return;
    const seq = ++fetchSeq;
    const stampAtRequest = runtimeStamp;
    try {
        const [list, state] = await Promise.all([
            api.listAutomations(),
            api.getAutomationRuntime(),
        ]);
        if (seq !== fetchSeq) return;
        rules = list;
        // The one-shot read is only used when no LIVE event overtook it. `get_automation_runtime`
        // answers "the state when you asked"; an `automation:state` that arrived while it was in
        // flight is strictly newer, and committing the response over it would roll the display
        // back by up to a second — visibly, on a rule that had just fired.
        if (runtimeStamp === stampAtRequest) runtime = state;
        reindex();
    } catch {
        // Leave the last good index in place. A failed read is not evidence that nothing is armed,
        // and painting it as such would clear indicators across the whole app on one bad call.
    }
}

/**
 * Subscribe to the events, then take the first reading — in that order, always, and for the reason
 * `useAutomations` states: the window between "we asked" and "we started listening" is a
 * transition nothing downstream can recover.
 *
 * **Never torn down.** The unlisteners are deliberately dropped: this is one app-lifetime
 * registration per window, not a component's. Ref-counting it against subscribers would stop and
 * restart the whole thing as menus open and close, and each restart re-fetches — the opposite of
 * why the subscription was lifted here.
 */
async function ensureStarted(): Promise<void> {
    if (started) return;
    started = true;
    try {
        const { listen } = await import('@tauri-apps/api/event');
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        origin = getCurrentWindow().label;
        await Promise.all([
            listen(AUTOMATION_CHANGED, () => {
                void refreshAutomationArmed();
            }),
            listen(AUTOMATION_STATE, (event: { payload: unknown }) => {
                const payload = event.payload as AutomationStatePayload | undefined;
                if (payload && typeof payload === 'object' && 'rules' in payload) {
                    runtimeStamp += 1;
                    runtime = payload;
                    reindex();
                }
            }),
        ]);
    } catch {
        // Not running under Tauri (the browser host, or a unit test with no event API). The fetch
        // below still runs, so a static reading is available even with no live updates.
    }
    await refreshAutomationArmed();
}

/** Subscribe to any change. Starts the app-wide feed on the first caller. */
export function subscribeAutomationArmed(listener: () => void): () => void {
    void ensureStarted();
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** What is armed on `terminalId` right now, WITHOUT subscribing — for a click handler. */
export function getArmedAutomations(terminalId: string): ArmedAutomation[] {
    return index.get(terminalId) ?? EMPTY;
}

/** The rule list as last read. Identity is stable between refetches. */
export function getAutomationRules(): AutomationRule[] {
    return rules;
}

/** The whole runtime payload, for `AutomationEditor`'s `runtime` prop. */
export function getAutomationRuntime(): AutomationStatePayload {
    return runtime;
}

/** This window's label, for the log line every mutation writes. */
export function getAutomationOrigin(): string {
    return origin;
}

/**
 * The rules armed on `terminalId`, live.
 *
 * `null` opts out and always reads empty — a pane with no terminal has no id to ask about, and a
 * hook cannot be called conditionally.
 */
export function useArmedAutomations(terminalId: string | null): ArmedAutomation[] {
    const getSnapshot = useCallback(
        () => (terminalId === null ? EMPTY : index.get(terminalId) ?? EMPTY),
        [terminalId],
    );
    return useSyncExternalStore(subscribeAutomationArmed, getSnapshot, getSnapshot);
}

/** How many DISTINCT rules are armed across `terminalIds`. */
export function countArmedAcross(terminalIds: readonly string[]): number {
    const seen = new Set<string>();
    for (const terminalId of terminalIds) {
        for (const armed of index.get(terminalId) ?? EMPTY) seen.add(armed.rule.id);
    }
    return seen.size;
}

/**
 * How many distinct rules are armed anywhere in this set of terminals — the tab strip's question.
 *
 * A NUMBER, not the entries, and that is what makes subscribing affordable on a surface that
 * re-renders every tab together: `useSyncExternalStore` compares with `Object.is`, so a rule
 * ticking from *armed* to *just fired* returns the same count and wakes nothing.
 *
 * The caller passes a fresh array on every render (it comes out of a tree walk), so the snapshot
 * callback is keyed on the JOINED ids rather than the array. Keying it on the array itself would
 * rebuild the callback every render, and `useSyncExternalStore` re-subscribes whenever it changes.
 */
export function useArmedAutomationCount(terminalIds: readonly string[]): number {
    const key = terminalIds.join(' ');
    const getSnapshot = useCallback(
        () => countArmedAcross(key === '' ? [] : key.split(' ')),
        [key],
    );
    return useSyncExternalStore(subscribeAutomationArmed, getSnapshot, getSnapshot);
}

/**
 * Test-only: install a reading directly, bypassing the bridge.
 *
 * `started` is latched so the real feed never boots in a suite — a test that seeds a value and then
 * has an async fetch land over it is a flake nobody can reproduce.
 */
export function __seedAutomationArmedForTest(
    seedRules: AutomationRule[],
    seedRuntime: AutomationStatePayload,
): void {
    started = true;
    rules = seedRules;
    runtime = seedRuntime;
    reindex();
}

/** Test-only: drop everything, including the started latch and the subscribers. */
export function __resetAutomationArmedForTest(): void {
    rules = [];
    runtime = { rules: {} };
    index = new Map();
    origin = 'main';
    started = false;
    fetchSeq = 0;
    runtimeStamp = 0;
    listeners.clear();
}

/**
 * The whole rule list, live.
 *
 * For `GlobalAutomationEditor`, which needs the rule OBJECT and not just the fact that something is
 * armed. Identity is stable between refetches, so a consumer re-renders on a rule edit and on
 * nothing else — the runtime ticks do not replace this array.
 */
export function useAutomationRules(): AutomationRule[] {
    return useSyncExternalStore(subscribeAutomationArmed, getAutomationRules, getAutomationRules);
}

/**
 * The whole runtime payload, live — the editor's `runtime` prop.
 *
 * Deliberately NOT indexed by rule id here: `AutomationEditorProps.runtime` documents at length why
 * it takes the whole payload and indexes it by the DRAFT's own id, because a rule saved from inside
 * the editor mints an id the caller never sees.
 */
export function useAutomationRuntimeState(): AutomationStatePayload {
    return useSyncExternalStore(
        subscribeAutomationArmed,
        getAutomationRuntime,
        getAutomationRuntime,
    );
}
