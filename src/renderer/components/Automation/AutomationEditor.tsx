/**
 * The rule editor (plan 028 §6, mockup §03/§04/§05/§07).
 *
 * A portalled, near-fullscreen modal over Settings, owning a small purpose-built node canvas. It is
 * one screen with four regions — palette, canvas, inspector, drawer — and **one draft**, from which
 * every one of them is derived (§6.2).
 *
 * ## Three things here are load-bearing rather than decorative
 *
 * **1. The keyboard is borrowed, ref-counted, and given back by an effect cleanup.**
 * `InputHandler` registers Ctrl+W, Ctrl+1–9, Ctrl+Shift+D/W/Enter, Alt+[/], Ctrl+V, Ctrl+, and F11
 * on `window` in the CAPTURE phase, so without this a Ctrl+W typed into the editor closes a tab
 * behind it. Never the boolean `disable()`: a boolean cannot hold overlapping ownership and would be
 * cleared by the first of two owners to leave, leaving the app permanently deaf.
 *
 * **2. `useDialogA11y` is the ONLY Escape handler.** The first draft had two — the dialog's own
 * container listener *and* a window-capture one — and capture runs root→target before any bubble
 * listener regardless of nesting, so pressing Escape to cancel a `ConfirmDialog` opened *inside* the
 * editor would have closed **the editor** instead. The window-capture listener that remains is
 * scoped to Ctrl+S and nothing else.
 *
 * **3. Save can refuse, and the guard hears it.** `registerAutomationEditorGuard` hands the page a
 * `save()` that resolves `false` when the write did not happen. A `save(): void` could neither be
 * awaited nor decline, so a rejected save would still have let the navigation through and destroyed
 * the draft — the exact blocker the guard exists to prevent, reintroduced through its own remedy.
 *
 * **4. A save never loses work, and never sends a rule the store would refuse.** Validation gates
 * the *Enable* toggle; a Save is not refused, but it is not unconditional either. `save_rule`
 * rejects an **enabled** rule that has a blocking problem (R10 — an empty message makes `deliver`
 * press a bare Enter into whatever is running), so clearing the Message on a live rule to retype it
 * would have met that refusal mid-edit with *Discard* as the only exit. The editor writes the draft
 * whole and drops the one thing that cannot survive the trip: it saves such a rule **switched off**,
 * says which problem cost it, and leaves it one click from running again. §07: *"losing work to a
 * validation rule is its own bug."*
 */
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type {
    AutomationLogEntry,
    AutomationRule,
    DryRunReport,
    WatchableTerminal,
} from '../../types/electron';
import type { AutomationStatePayload } from '../../services/automationEvents';
import { store } from '../../store';
import { addToast } from '../../store/slices/uiSlice';
import { suspendGlobalShortcuts } from '../../services/InputHandler';
import {
    clearAutomationEditorGuard,
    registerAutomationEditorGuard,
} from '../../services/automationEditorGuard';
import { ConfirmDialog } from '../UI/ConfirmDialog';
import { useDialogA11y } from '../UI/useDialogA11y';
import { automationRowState } from '../Settings/Automations/automationState';
import { blockingProblems, problems as validate } from './automationValidation';
import { faceFor, ruleSummary, stateFor } from './automationDerive';
import type { NodeFace, NodeState } from './automationDerive';
import type { StepKind } from './automationSteps';
import { STEP_ORDER, canAddStep } from './automationSteps';
import type { NodePos } from './automationDraft';
import { draftFromRule, draftReducer, isDirty } from './automationDraft';
import { AuCanvas } from './AuCanvas';
import { AuPalette } from './AuPalette';
import { AuInspector } from './AuInspector';
import { AuDrawer } from './AuDrawer';
import type { DrawerTab } from './AuDrawer';
import { useAuPaletteDrag } from './useAuPaletteDrag';
import './AutomationEditor.css';

/** How many recent lines the drawer's Activity peek holds. The full log lives in Settings. */
const DRAWER_LOG_LIMIT = 40;

/**
 * How often the terminal roster is re-read while the editor is open.
 *
 * "A few seconds" is a promise the UI makes out loud — `MonitorPanel` renders
 * *"Open right now N · refreshed every few seconds"* — so this is what makes that sentence true.
 * The engine's own targeting tick runs at 2 s, so nothing here is the bottleneck.
 */
const ROSTER_POLL_MS = 3000;

export interface AutomationEditorProps {
    /** The rule or draft to edit. `id: ''` means it has never been saved. */
    rule: AutomationRule;
    /** A brand-new rule opens on an empty canvas; a template or an existing rule does not. */
    freshCanvas: boolean;
    /**
        * The WHOLE runtime payload, indexed here by the draft's own id rather than by the caller.
        *
        * The panel used to index it: `pairs={runtime.rules[view.draft.id]}`. A new draft's id is `''`
        * until the first save mints one, and the minted id lands in the EDITOR's reducer — the panel's
        * `view.draft` still holds the empty string. So a rule saved and enabled from inside the editor
        * showed no live state at all for the rest of the session, in the one panel whose whole job is
        * to report it. Indexing where the id actually lives is the fix; passing an already-indexed
        * value is what made a stale key invisible.
        */
    runtime: AutomationStatePayload;
    now: number;
    /** This window's label, for the log lines every mutation writes. */
    origin: string;
    onClose: () => void;
    /** Leave the editor and open this rule's full activity log. */
    onOpenFullLog: (ruleId: string) => void;
    /** Something changed on disk — the panel refetches. */
    onChanged: () => Promise<void> | void;
}

const toast = (message: string, type: 'success' | 'error' | 'info' = 'info') => {
    // The singleton store rather than `useDispatch`, which is the idiom this repo already uses for
    // code that must work outside a Provider (`InputHandler`, `openSettings`). It also keeps the
    // panel mountable under a bare root, which is what makes its tests cheap.
    store.dispatch(addToast({ message, type }));
};

export const AutomationEditor: React.FC<AutomationEditorProps> = ({
    rule,
    freshCanvas,
    runtime,
    now,
    origin,
    onClose,
    onOpenFullLog,
    onChanged,
}) => {
    const [draft, dispatch] = useReducer(draftReducer, { rule, freshCanvas }, (init) =>
        draftFromRule(init.rule, init.freshCanvas));
    const containerRef = useRef<HTMLDivElement | null>(null);

    const [terminals, setTerminals] = useState<WatchableTerminal[]>([]);
    const [terminalsError, setTerminalsError] = useState<string | null>(null);
    const [terminalsLoading, setTerminalsLoading] = useState(true);

    const [drawer, setDrawer] = useState<DrawerTab | null>(null);
    const [report, setReport] = useState<DryRunReport | null>(null);
    const [running, setRunning] = useState(false);
    const [testError, setTestError] = useState<string | null>(null);
    const [testTarget, setTestTarget] = useState<string | null>(null);

    const [entries, setEntries] = useState<AutomationLogEntry[]>([]);
    const [logError, setLogError] = useState<string | null>(null);

    const [pendingDelete, setPendingDelete] = useState(false);
    const [pendingClose, setPendingClose] = useState(false);
    const [saving, setSaving] = useState(false);

    const api = typeof window === 'undefined' ? undefined : window.electronAPI;
    const pairs = draft.rule.id.length > 0 ? runtime.rules[draft.rule.id] : undefined;
    const dirty = isDirty(draft);
    const problems = useMemo(() => validate(draft.rule), [draft.rule]);
    const blocking = blockingProblems(problems);

    // --- the keyboard ----------------------------------------------------------------------------
    // The cleanup IS the release. Whatever route the editor is left by — Save, Escape, the X, an
    // unmount because Settings closed — the counter comes back down.
    useEffect(() => suspendGlobalShortcuts(), []);

    // --- the data the editor needs ----------------------------------------------------------------
    const loadTerminals = useCallback(async () => {
        if (!api?.listWatchableTerminals) {
            setTerminalsLoading(false);
            return;
        }
        try {
            // The rule's own id scopes the label snapshot lookup, so a pinned id that is not open
            // still comes back with its NAME and FOLDER rather than as a bare id (§4.3).
            const rows = await api.listWatchableTerminals(
                draft.rule.id.length > 0 ? draft.rule.id : null,
                draft.rule.targetIds.length > 0 ? draft.rule.targetIds : null,
            );
            setTerminals(rows);
            setTerminalsError(null);
        } catch (e) {
            setTerminalsError(e instanceof Error ? e.message : String(e));
        } finally {
            setTerminalsLoading(false);
        }
        // The pick set is a dependency because a newly ticked id has to appear in the roster with
        // its snapshot; the rule id is one because it changes exactly once, on the first save.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [api, draft.rule.id, draft.rule.targetIds.join(',')]);

    /**
     * The roster is POLLED, not fetched once.
     *
     * Without the interval the picker listed whatever was open when the editor mounted: a terminal
     * opened while the editor is up never appeared, there is no refresh control, and the only way to
     * see it was to close the editor and reopen it. The same array feeds `MonitorPanel`'s
     * *"Open right now N · refreshed every few seconds"* — a promise nothing kept.
     *
     * `loadTerminals` is re-created when the rule id or the pick set changes, which restarts the
     * timer; that is harmless and keeps the newly-ticked-id refresh those deps exist for.
     */
    useEffect(() => {
        void loadTerminals();
        const timer = setInterval(() => { void loadTerminals(); }, ROSTER_POLL_MS);
        return () => clearInterval(timer);
    }, [loadTerminals]);

    const loadLog = useCallback(async () => {
        if (!api?.loadAutomationLog || draft.rule.id.length === 0) return;
        try {
            setEntries(await api.loadAutomationLog(draft.rule.id, true, DRAWER_LOG_LIMIT));
            setLogError(null);
        } catch (e) {
            setLogError(e instanceof Error ? e.message : String(e));
        }
    }, [api, draft.rule.id]);

    useEffect(() => {
        if (drawer === 'activity') void loadLog();
    }, [drawer, loadLog]);

    // --- saving -----------------------------------------------------------------------------------
    // A ref, not the closure: the guard registered below is a stable object handed to a module-level
    // registry, and a `save` that closed over the first render's draft would persist whatever the
    // rule looked like when the editor opened.
    const latest = useRef({ draft, api, origin, onChanged });
    latest.current = { draft, api, origin, onChanged };
    /** True from the moment a save is decided to the moment it settles. See `save` below. */
    const inFlight = useRef(false);

    const save = useCallback(async (): Promise<boolean> => {
        const { draft: current, api: bridge, origin: from, onChanged: changed } = latest.current;
        if (!bridge?.saveAutomation) {
            toast('Automations are not available in this window.', 'error');
            return false;
        }
        // **One save at a time.** `disabled={saving}` guards the BUTTON and nothing else, and the
        // Ctrl+S listener is a second door: two presses inside one round-trip — or one held key —
        // each read `id: ''`, and the store mints a fresh id per call, so one draft became several
        // rows. A ref rather than the `saving` state because the state lands a render later, which
        // is exactly the window this is closing.
        if (inFlight.current) return false;

        // **A blocked draft is saved SWITCHED OFF, never refused.** §07: *"losing work to a
        // validation rule is its own bug."* The store refuses an enabled rule with a blocking
        // problem (R10 — an empty message makes `deliver` press a bare Enter into whatever is
        // running), so an editor that sent one would meet that refusal mid-edit and leave *Discard*
        // as the only exit. Clearing the Message on an enabled rule to retype it is enough to reach
        // it. So the rule the user drew is written whole, and the one thing that cannot survive the
        // trip — permission to RUN — is dropped, said out loud, and one click from being restored.
        const blockingNow = blockingProblems(validate(current.rule));
        const disarmed = current.rule.enabled && blockingNow.length > 0;
        const outgoing = disarmed ? { ...current.rule, enabled: false } : current.rule;

        inFlight.current = true;
        setSaving(true);
        try {
            const result = await bridge.saveAutomation(outgoing, from);
            // The store MINTS an id for a new rule, and it has to reach the draft: without it the
            // next Save mints a second one and one draft becomes two rows. `saved` sets both the
            // rule and the dirty baseline in one action.
            dispatch({ type: 'saved', rule: { ...outgoing, id: result?.id ?? outgoing.id } });
            await changed();
            if (disarmed) {
                toast(
                    `Saved “${outgoing.name || 'Untitled automation'}” and switched it off — `
                        + `${blockingNow[0].message} Switch it back on once that is fixed.`,
                    'info',
                );
            } else {
                toast(`Saved “${outgoing.name || 'Untitled automation'}”.`, 'success');
            }
            return true;
        } catch (e) {
            // Reported, and REFUSED. The navigation guard reads this boolean, so swallowing the
            // error here would let a failed save close the editor and take the draft with it.
            toast(`Could not save: ${e instanceof Error ? e.message : String(e)}`, 'error');
            return false;
        } finally {
            inFlight.current = false;
            setSaving(false);
        }
    }, []);

    // --- the unsaved-draft guard --------------------------------------------------------------------
    useEffect(() => {
        registerAutomationEditorGuard({
            isDirty: () => isDirty(latest.current.draft),
            save,
            discard: () => {
                // The registry's contract: discarding cannot fail, and the navigation follows it.
                // Closing here as well would race the page's own navigation.
            },
        });
        return () => clearAutomationEditorGuard();
    }, [save]);

    // --- leaving ------------------------------------------------------------------------------------
    const requestClose = useCallback(() => {
        if (isDirty(latest.current.draft)) setPendingClose(true);
        else onClose();
    }, [onClose]);

    useDialogA11y(containerRef, { isOpen: true, onCancel: requestClose, initialFocus: 'first' });

    // Ctrl+S ONLY. Escape belongs to `useDialogA11y`, on the container, in the bubble phase — so a
    // ConfirmDialog opened inside this editor gets its own Escape and this one does not steal it.
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if (!((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's')) {
                return;
            }
            // Taken whatever happens next, so the browser's own Save-page dialog never appears.
            e.preventDefault();
            e.stopPropagation();
            // The OS auto-repeats a held key ~30 times a second and every one of them is a separate
            // keydown. `save` refuses a second call while one is in flight, which covers the round
            // trip; this covers the repeats that arrive *after* one settles, and it is the same
            // refusal `shouldArmSpacePan` makes for the same reason.
            if (e.repeat) return;
            void save();
        };
        window.addEventListener('keydown', onKey, true);
        return () => window.removeEventListener('keydown', onKey, true);
    }, [save]);

    // --- actions -------------------------------------------------------------------------------------
    const runDryRun = useCallback(async () => {
        const target = testTarget ?? terminals.find((t) => t.alive)?.terminalId ?? null;
        if (!target) {
            setDrawer('test');
            setTestError('no terminal is open to test against');
            return;
        }
        setTestTarget(target);
        setDrawer('test');
        setRunning(true);
        setTestError(null);
        try {
            if (!api?.dryRunAutomation) throw new Error('the desktop bridge is not available');
            setReport(await api.dryRunAutomation(draft.rule, target));
        } catch (e) {
            setReport(null);
            setTestError(e instanceof Error ? e.message : String(e));
        } finally {
            setRunning(false);
        }
    }, [api, draft.rule, terminals, testTarget]);

    const setEnabled = async (enabled: boolean) => {
        if (draft.rule.id.length === 0) {
            // The engine only knows rules that exist. Enabling an unsaved draft has to save it
            // first, and saying so beats a toggle that silently does nothing.
            toast('Save this automation first — the engine can only run a rule that exists.', 'info');
            return;
        }
        // **This switch applies to the row in the STORE, not to the draft on screen**, because
        // `set_automation_enabled` writes one column on a row SQLite already holds and the engine
        // then reloads that row. Switching ON while the draft is dirty therefore starts the version
        // the user has just edited away from: retarget the picker from `tm-A` to `tm-B`, flip the
        // switch, and the message is typed into `tm-A` while the canvas, the picker and the palette
        // summary all describe `tm-B`.
        //
        // Only the ON direction is refused. Switching OFF the stored row is exactly what a user who
        // wants it to stop right now is asking for, and it cannot start anything.
        if (enabled && isDirty(draft)) {
            toast(
                'Save this automation first — switching it on runs the version that is saved, '
                    + 'not the one on screen.',
                'info',
            );
            return;
        }
        if (!api?.setAutomationEnabled) {
            // An optional call that RESOLVES is not a call that happened: `await api?.x?.()` yields
            // `undefined` and falls into the success path, which then moved the dirty baseline for a
            // write that never took place (`a-refusal-must-be-heard-by-every-caller`).
            toast('Automations are not available in this window.', 'error');
            return;
        }
        try {
            await api.setAutomationEnabled(draft.rule.id, enabled, origin);
            // `persisted`, because this one field went to the store on its own: the draft's other
            // unsaved edits are still unsaved, and marking the WHOLE draft clean here would tell
            // the navigation guard there is nothing to lose while the user's edits sit in memory.
            dispatch({ type: 'enabled', enabled, persisted: true });
            await onChanged();
        } catch (e) {
            // The BACKEND owns "is this rule allowed to run" and re-checks — a refusal here is the
            // authority disagreeing with this renderer's own validation, which is exactly the case
            // the mirror exists for and must not be hidden.
            toast(`Could not switch it ${enabled ? 'on' : 'off'}: ${e instanceof Error ? e.message : String(e)}`, 'error');
        }
    };

    // --- derived ---------------------------------------------------------------------------------------
    const ctx = { pairs, now, problems };
    const faces = useMemo(() => {
        const out: Partial<Record<StepKind, NodeFace>> = {};
        for (const step of STEP_ORDER) out[step] = faceFor(draft.rule, step, ctx);
        return out as Record<StepKind, NodeFace>;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft.rule, problems, pairs, now]);

    const states = useMemo(() => {
        const out: Partial<Record<StepKind, NodeState>> = {};
        for (const step of STEP_ORDER) out[step] = stateFor(draft.rule, step, ctx);
        return out as Record<StepKind, NodeState>;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [draft.rule, problems, pairs, now]);

    // What each wire is carrying, from the draft — and from the last dry run when there is one,
    // because a real value beats a described one.
    const chips = useMemo(() => {
        const parseStep = report?.steps.find((s) => s.kind === 'parse');
        const condStep = report?.steps.find((s) => s.kind === 'cond');
        return {
            'monitor.out': 'lines',
            // A real matched value beats a described one, and only a dry run has ever seen one.
            'parse.out': parseStep?.status === 'ok' ? parseStep.detail : 'value',
            'cond.true': condStep?.status === 'ok' ? 'yes' : 'yes/no',
            'cond.false': 'no',
        };
    }, [report]);

    /**
     * **The one place a step is added**, whatever gesture asked for it.
     *
     * The palette item is both a drag source and a button, and the refusal used to live inside the
     * drag hook — so the drag was gated and the click was not, and clicking *Compare it* on an empty
     * canvas added it with nothing to compare, in a shape the drag refuses
     * (`gate-in-the-caller-lets-new-callers-opt-out`).
     */
    const addStep = useCallback((step: StepKind, pos?: NodePos) => {
        const refusal = canAddStep(latest.current.draft.present, step);
        if (refusal) {
            toast(refusal.reason, 'error');
            return;
        }
        dispatch({ type: 'addStep', step });
        if (pos) dispatch({ type: 'moveStep', step, pos });
    }, []);

    const toWorldRef = useRef<(x: number, y: number) => NodePos | null>(() => null);
    // Stable, because `AuCanvas` calls it from an effect: a new identity every render would make
    // that effect re-run on every frame of a drag.
    const takeViewport = useCallback((fn: (x: number, y: number) => NodePos | null) => {
        toWorldRef.current = fn;
    }, []);
    const paletteDrag = useAuPaletteDrag({
        toWorld: (x, y) => toWorldRef.current(x, y),
        onAdd: addStep,
    });

    const rowState = pairs && Object.keys(pairs).length > 0
        ? automationRowState(draft.rule, pairs, now)
        : null;

    return createPortal(
        // `tabIndex={-1}` is what makes Escape reachable, and it is not decoration.
        //
        // `useDialogA11y` binds its keydown to THIS container in the bubble phase, deliberately, so
        // that a `ConfirmDialog` opened inside the editor answers Escape itself instead of the
        // editor stealing it. A bubble listener only ever runs for events whose target is inside the
        // container — so the moment `document.activeElement` becomes `<body>`, Escape and the Tab
        // trap both stop existing. A plain `<div>` is not focusable, so that is precisely what a
        // click on any non-focusable area did: the canvas background (which is how you DESELECT a
        // step, so it is the most common click in the editor) and the header's empty space both sent
        // focus to the body, and Escape then closed nothing. Measured on a live build: click a node,
        // click Save, press Escape three times — nothing; click into the name field first and the
        // same key opens the unsaved-changes dialog.
        //
        // With `tabIndex={-1}` the browser focuses the nearest focusable ancestor on mousedown, which
        // is now this container, so focus never reaches the body and the listener keeps firing. The
        // hook already expects this — `resolveInitialFocus` falls back to `(target ?? container)
        // .focus?.()`, a no-op on a div that cannot hold focus, and its Tab trap has an
        // `active === container` branch for it.
        //
        // Fixed HERE and not in `useDialogA11y`, which this branch does not touch and which eleven
        // other components share: the hook's contract is "trap focus inside the container", and a
        // container that cannot hold focus does not satisfy it. The other ten dialogs are small and
        // densely focusable, so they rarely lose focus to the body; this one is a full-screen surface
        // whose largest region is a canvas. That the shared hook has no such guard is a real gap and
        // is worth raising, but widening a GUI-pass fix across eleven dialogs is not this change.
        <div className="au-editor" role="dialog" aria-modal="true" aria-label="Automation editor" tabIndex={-1} ref={containerRef}>
            <div className="au-scrim" aria-hidden="true" />
            <div className="au-modal">
                <div className="au-mhead">
                    <button type="button" className="au-x" aria-label="Close editor" onClick={requestClose}>
                        ✕
                    </button>
                    <input
                        className="au-nameinput"
                        aria-label="Automation name"
                        placeholder="Name this automation"
                        value={draft.rule.name}
                        onChange={(e) => dispatch({ type: 'name', name: e.target.value })}
                    />
                    {dirty && (
                        <span className="au-unsaved" title="This automation has unsaved changes">
                            unsaved
                        </span>
                    )}

                    {/* R11 lives in TWO places from ONE field: this control and the list row's
                        badge. §10.24b asserts they agree, which is the only thing that keeps a
                        second spelling of "runs once" from appearing. */}
                    <div className="au-seg" role="group" aria-label="How often this rule may run">
                        <button
                            type="button"
                            className={draft.rule.runsOnce ? '' : 'on'}
                            aria-pressed={!draft.rule.runsOnce}
                            onClick={() => dispatch({ type: 'runsOnce', runsOnce: false })}
                        >
                            Repeatable
                        </button>
                        <button
                            type="button"
                            className={draft.rule.runsOnce ? 'on' : ''}
                            aria-pressed={draft.rule.runsOnce}
                            onClick={() => dispatch({ type: 'runsOnce', runsOnce: true })}
                        >
                            Runs once
                        </button>
                    </div>

                    <span className="au-grow" />

                    {rowState && (
                        <span className={`au-pill ${rowState.id}`}>
                            <span className="au-pd" />
                            {rowState.pillText}
                        </span>
                    )}

                    <span className="au-enwrap">
                        {blocking.length > 0 && (
                            <span className="au-enwhy">
                                Fix {blocking.length} problem{blocking.length === 1 ? '' : 's'} to enable
                            </span>
                        )}
                        Enabled
                        <button
                            type="button"
                            className="au-tog"
                            role="switch"
                            aria-checked={draft.rule.enabled}
                            // A disabled control that explains itself: the switch is dimmed AND the
                            // reason sits next to it. §07 — "a control that refuses without saying
                            // why is the thing people file bugs about."
                            disabled={blocking.length > 0 && !draft.rule.enabled}
                            title={blocking[0]?.message ?? 'Enable this automation'}
                            aria-label={
                                blocking.length > 0 && !draft.rule.enabled
                                    ? `Enable (blocked: ${blocking.length} problem${blocking.length === 1 ? '' : 's'})`
                                    : 'Enable automation'
                            }
                            onClick={() => void setEnabled(!draft.rule.enabled)}
                        />
                    </span>

                    <button type="button" className="au-btn" onClick={() => void runDryRun()}>
                        ▶ Test
                    </button>
                    <button
                        type="button"
                        className="au-btn"
                        disabled={draft.rule.id.length === 0}
                        title={
                            draft.rule.id.length === 0
                                ? 'Save this automation before duplicating it'
                                : 'Duplicate this automation'
                        }
                        onClick={() => {
                            void (async () => {
                                try {
                                    await api?.duplicateAutomation?.(draft.rule.id, origin);
                                    await onChanged();
                                    toast('Duplicated — the copy is in the list, switched off.', 'success');
                                } catch (e) {
                                    toast(`Could not duplicate: ${e instanceof Error ? e.message : String(e)}`, 'error');
                                }
                            })();
                        }}
                    >
                        ⧉ Duplicate
                    </button>
                    <button
                        type="button"
                        className="au-btn danger"
                        disabled={draft.rule.id.length === 0}
                        onClick={() => setPendingDelete(true)}
                    >
                        Delete
                    </button>
                    <button
                        type="button"
                        className="au-btn primary"
                        disabled={saving}
                        onClick={() => void save()}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>

                <div className="au-mbody">
                    <AuPalette
                        present={draft.present}
                        summary={ruleSummary(draft.rule)}
                        onBeginDrag={(step, e) => paletteDrag.begin(step, e)}
                        onAdd={(step) => addStep(step)}
                    />

                    <AuCanvas
                        draft={draft}
                        faces={faces}
                        states={states}
                        chips={chips}
                        onSelect={(step) => dispatch({ type: 'select', step })}
                        onMove={(step, pos) => dispatch({ type: 'moveStep', step, pos })}
                        onConnect={(wire) => dispatch({ type: 'addWire', wire })}
                        onDisconnect={(wire) => dispatch({ type: 'removeWire', wire })}
                        onRefuse={(reason) => toast(reason, 'error')}
                        onViewportReady={takeViewport}
                    >
                        {drawer !== null && (
                            <AuDrawer
                                tab={drawer}
                                onTab={setDrawer}
                                onClose={() => setDrawer(null)}
                                report={report}
                                running={running}
                                testError={testError}
                                terminals={terminals}
                                chosen={testTarget}
                                onChoose={setTestTarget}
                                onRun={() => void runDryRun()}
                                entries={entries}
                                logError={logError}
                                saved={draft.rule.id.length > 0}
                                onOpenFullLog={() => onOpenFullLog(draft.rule.id)}
                            />
                        )}
                    </AuCanvas>

                    <AuInspector
                        draft={draft}
                        problems={problems}
                        pairs={pairs}
                        now={now}
                        terminals={terminals}
                        terminalsError={terminalsError}
                        terminalsLoading={terminalsLoading}
                        report={report}
                        onRearm={
                            draft.rule.id.length > 0
                                ? () => {
                                    void (async () => {
                                        try {
                                            await api?.rearmAutomation?.(draft.rule.id, null);
                                            await onChanged();
                                            toast('Re-armed — it can fire again on the next crossing.', 'success');
                                        } catch (e) {
                                            toast(`Could not re-arm: ${e instanceof Error ? e.message : String(e)}`, 'error');
                                        }
                                    })();
                                }
                                : null
                        }
                        onTest={() => void runDryRun()}
                        onFocusStep={(step) => dispatch({ type: 'select', step })}
                        dispatch={dispatch}
                    />
                </div>

                {drawer === null && (
                    <button type="button" className="au-drawertab" onClick={() => setDrawer('test')}>
                        Test run &amp; activity
                    </button>
                )}
            </div>

            {paletteDrag.ghost && (
                <div
                    className="au-palghost"
                    style={{ left: paletteDrag.ghost.x, top: paletteDrag.ghost.y }}
                    aria-hidden="true"
                >
                    {paletteDrag.ghost.step}
                </div>
            )}

            <ConfirmDialog
                isOpen={pendingDelete}
                title={`Delete “${draft.rule.name || 'Untitled automation'}”?`}
                message={
                    <p>
                        Deleting this automation removes its steps and its history. If you only want
                        it to stop for now, <b>switch it off</b> instead — that keeps everything.
                    </p>
                }
                destructive
                confirmText="Delete"
                cancelText="Cancel"
                onConfirm={() => {
                    setPendingDelete(false);
                    void (async () => {
                        try {
                            await api?.deleteAutomation?.(draft.rule.id, origin);
                            await onChanged();
                            onClose();
                        } catch (e) {
                            toast(`Could not delete: ${e instanceof Error ? e.message : String(e)}`, 'error');
                        }
                    })();
                }}
                onCancel={() => setPendingDelete(false)}
            />

            <ConfirmDialog
                isOpen={pendingClose}
                title="Leave without saving?"
                message={
                    <p>
                        This automation has changes that have not been saved. Saving keeps them;
                        leaving throws them away.
                    </p>
                }
                confirmText="Save and close"
                cancelText="Keep editing"
                secondaryText="Discard"
                onSecondary={() => {
                    setPendingClose(false);
                    onClose();
                }}
                onConfirm={() => {
                    void (async () => {
                        // Only close if the save actually happened. A refused save that closed
                        // anyway would destroy the draft — the same failure the navigation guard
                        // exists to prevent, one dialog further in.
                        if (await save()) {
                            setPendingClose(false);
                            onClose();
                        } else {
                            setPendingClose(false);
                        }
                    })();
                }}
                onCancel={() => setPendingClose(false)}
            />
        </div>,
        document.body,
    );
};
