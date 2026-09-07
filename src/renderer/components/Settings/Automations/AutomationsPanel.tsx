/**
 * Settings ▸ **Automations** — the home of the feature (plan 028 §5, mockup §01).
 *
 * Extracted rather than added to `SettingsPage.tsx` for the `PeersPanel` reason: that file is
 * already ~2000 lines and this feature brings a list, a template gallery and a log view.
 *
 * **No Redux.** Every piece of state here is either the panel's own view state or comes from
 * `useAutomations()`, which owns the fetches and the subscriptions. That also means the panel
 * renders under a bare `createRoot` with no Provider, which is what makes §10.28 a cheap test
 * rather than a fixture exercise.
 */
import React, { useEffect, useMemo, useState } from 'react';
import type { AutomationRule } from '../../../types/electron';
import { ConfirmDialog } from '../../UI/ConfirmDialog';
import { AutomationRow } from './AutomationRow';
import { TemplateGallery } from './TemplateGallery';
import { ActivityLogView } from './ActivityLogView';
import { AutomationEditor } from '../../Automation/AutomationEditor';
import { redactWebhookError } from '../../Automation/webhookRedaction';
import type { CanvasOpening } from '../../Automation/automationDraft';
import { automationRowState, JUST_FIRED_MS } from './automationState';
import { useAutomations } from './useAutomations';
import { consumePendingAutomationLog } from '../../../services/automationEditorHost';
import '../../Automation/auToggle.css';
import './AutomationsPanel.css';

/** Q6: the mockup draws the chips and defines nothing. Completed is a success, not a problem. */
type ListFilter = 'all' | 'active' | 'attention';

type View =
    | { kind: 'list' }
    | { kind: 'gallery' }
    | { kind: 'log'; ruleId: string | null }
    /**
     * `opening` is what the editor is opening ON — it decides the canvas AND the dirty baseline
     * together; see `CanvasOpening`.
     *
     * It was `fresh: boolean`, naming only the blank card (mockup §03's third state). That stopped
     * being enough the moment a picked TEMPLATE had to open unsaved while an existing rule still
     * opened clean: three answers from this panel alone, and a boolean has two.
     */
    | { kind: 'editor'; draft: AutomationRule; opening: CanvasOpening };

export const AutomationsPanel: React.FC = () => {
    const {
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
        refresh,
    } = useAutomations();

    const [view, setView] = useState<View>({ kind: 'list' });
    const [filter, setFilter] = useState<ListFilter>('all');
    const [pendingDelete, setPendingDelete] = useState<AutomationRule | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);

    // A single clock for the whole render, so two rows cannot disagree about whether a fire was
    // "just now".
    //
    // `tick` exists because *Just fired* is the one row state that expires on its own. Every other
    // transition arrives as an `automation:state` event, but a rule that fires on a terminal which
    // then goes quiet produces exactly ONE transition — and nothing would re-render the panel six
    // seconds later to let the receipt settle into *Fired · waiting to re-arm*. The row stayed on
    // "Just fired" for minutes, or until an unrelated click, in a state the module's own doc calls
    // "the receipt, not a state you get stuck in".
    const [tick, setTick] = useState(0);
    const now = Date.now();

    const api = typeof window === 'undefined' ? undefined : window.electronAPI;

    const run = async (what: string, fn: () => Promise<unknown>) => {
        try {
            setActionError(null);
            await fn();
            await refresh();
        } catch (e) {
            setActionError(`${what} failed: ${redactWebhookError(e)}`);
        }
    };

    /**
     * `run` for the commands whose answer is a **boolean that is not a success flag**.
     *
     * *Forget it* and *Log every check* both send only ids now, and the store decides whether the
     * rule is still there inside the transaction that writes — `false` means it was deleted in
     * another window between this list being fetched and the click landing, and that nothing was
     * written. That branch has to be SAID. It is the one case where the row the user clicked
     * described a rule that no longer exists, so the button appearing to do nothing is exactly what
     * it looks like from the outside, and silence would leave a user re-clicking a control that can
     * never work again.
     *
     * The refresh runs on that branch too, and it is the other half of the repair: it is what takes
     * the ghost row off the list, so the sentence explains a list that has already corrected itself.
     */
    const runOnRule = async (what: string, fn: () => Promise<boolean>) => {
        try {
            setActionError(null);
            if (!(await fn())) {
                setActionError(`${what} failed — that automation no longer exists.`);
            }
            await refresh();
        } catch (e) {
            setActionError(`${what} failed: ${redactWebhookError(e)}`);
        }
    };

    // Deliberately NOT memoised. `now` changes every render by construction, so a `useMemo` keyed
    // on it can never hit — it would read as caching while doing strictly more work than the plain
    // filter it wraps.
    const visible = rules.filter((rule) => {
        if (filter === 'all') return true;
        const state = automationRowState(rule, runtime.rules[rule.id], now);
        if (filter === 'active') return rule.enabled && state.id !== 'completed';
        return state.id === 'error';
    });

    const counts = useMemo(() => {
        let on = 0;
        let completed = 0;
        let off = 0;
        for (const rule of rules) {
            if (!rule.enabled) off += 1;
            else if (rule.completedAt) completed += 1;
            else on += 1;
        }
        return { on, completed, off };
    }, [rules]);

    // One timer for the whole list, at the EARLIEST expiry, rather than one per row: the rows
    // share a clock, so they share a deadline. Re-armed on every render, which is what makes a
    // newly-arrived fire reset it.
    //
    // **Two kinds of deadline now, one mechanism.** A *Just fired* receipt expires once, six
    // seconds after the fire. A `pending` row's countdown expires every second it is displayed —
    // *Waiting to send · in 28s* is only true for a second — so its next deadline is the instant
    // that number would change, which is at most a second away and is DERIVED from the parked
    // stamp rather than being a bare 1 Hz interval. Same `setTimeout`, one more reason to arm it:
    // a second clock for the same job is how two rows end up disagreeing about `now`.
    const nextExpiry = useMemo(() => {
        let soonest = Infinity;
        const consider = (left: number) => {
            if (left > 0 && left < soonest) soonest = left;
        };
        for (const rule of rules) {
            for (const pair of Object.values(runtime.rules[rule.id] ?? {})) {
                if (pair.lastFiredAt !== null) consider(pair.lastFiredAt + JUST_FIRED_MS - now);
                if (pair.parkedAt !== null) {
                    const left = pair.parkedAt - now;
                    // **Only while the deadline is still ahead.** Past it the pill reads *in 0s*
                    // and there is nothing left to count: the send is due and the tick that drains
                    // it will announce itself. Re-arming here anyway would leave a 1 Hz render loop
                    // running against a stamp that can no longer change.
                    if (left > 0) {
                        // The whole second the countdown is about to tick off. `left % 1000` is 0
                        // at an exact boundary, where the next change is a full second away.
                        consider(left % 1000 === 0 ? 1000 : left % 1000);
                        // And the deadline itself, so the row leaves `pending` on the clock rather
                        // than waiting for an event the engine may not send.
                        consider(left);
                    }
                }
            }
        }
        return soonest;
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [rules, runtime, tick]);

    // **`tick` is in the deps, and it is what makes a repeating deadline repeat.** A *Just fired*
    // receipt expires once, so its `nextExpiry` shrinks with every render and the effect re-runs on
    // its own. A countdown's does not: it is *"the next whole second"*, which is 1000 again after
    // every tick — so keyed on `nextExpiry` alone the effect fired exactly once and the pill froze
    // one second in. Measured: the second `advanceTimersByTime` in this component's own test moved
    // nothing at all.
    useEffect(() => {
        if (!Number.isFinite(nextExpiry)) return undefined;
        const id = setTimeout(() => setTick((n) => n + 1), nextExpiry + 50);
        return () => clearTimeout(id);
    }, [nextExpiry, tick]);

    const openEditor = (draft: AutomationRule, opening: CanvasOpening = 'saved') =>
        setView({ kind: 'editor', draft, opening });

    const showLog = (ruleId: string | null) => {
        setLogScope({ ruleId, newestFirst: false });
        setView({ kind: 'log', ruleId });
    };

    // A rule's full log, asked for from OUTSIDE Settings — the app-level editor's "open the full
    // log" link (`plan/028` item D). Consumed exactly once on mount, before anything can navigate
    // away from it; `openSettingsTab` returns before this panel exists, so a DOM event would race
    // the mount and the value is handed over instead.
    useEffect(() => {
        const pending = consumePendingAutomationLog();
        if (pending) showLog(pending);
        // Mount only, and `showLog` is a fresh closure every render — listing it would re-run this
        // on every render and re-open the log over whatever the user had navigated to.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const backToList = () => {
        setLogScope(null);
        setView({ kind: 'list' });
    };

    /**
     * The action line, in the ONE spelling every view uses.
     *
     * The list had it and the log view did not, and the log view REPLACES the list — so a sentence
     * written by an action taken from the log bar was set into state and then rendered nowhere at
     * all. That was survivable while the only such action was the verbose toggle and the only
     * sentence was a thrown error; it stopped being survivable when that toggle gained a `false`
     * answer meaning *the rule you are looking at has been deleted*, which is precisely a thing the
     * user must be told rather than left to infer from a switch that flicked back.
     */
    const alertLine = (message: React.ReactNode) => (
        <div className="au-errline standalone" role="alert">
            <span aria-hidden="true">⚠</span>
            <span>{message}</span>
        </div>
    );

    const list = (
        <div className="au-panel">
            <div className="au-panelhead">
                <div className="au-panelhead-text">
                    <h3>Terminal automations</h3>
                    <p>
                        Rules that watch terminal output and send something back when a condition is
                        met. They run for every open terminal, including tabs you aren&apos;t looking
                        at.
                    </p>
                </div>
                <button type="button" className="au-btn" onClick={() => showLog(null)}>
                    ☰ Activity log — all
                </button>
                <button
                    type="button"
                    className="au-btn primary"
                    onClick={() => setView({ kind: 'gallery' })}
                >
                    + New automation
                </button>
            </div>

            {(error || actionError) && alertLine(actionError ?? error)}

            <div className="au-listbar">
                <span className="au-count">
                    {rules.length} {rules.length === 1 ? 'automation' : 'automations'} ·{' '}
                    {counts.on} on · {counts.completed} completed · {counts.off} off
                </span>
                <span className="au-grow" />
                <div className="au-chips" role="group" aria-label="Filter automations">
                    {(['all', 'active', 'attention'] as ListFilter[]).map((f) => (
                        <button
                            key={f}
                            type="button"
                            className={`au-chip${filter === f ? ' on' : ''}`}
                            aria-pressed={filter === f}
                            onClick={() => setFilter(f)}
                        >
                            {f === 'all' ? 'All' : f === 'active' ? 'Active' : 'Needs attention'}
                        </button>
                    ))}
                </div>
            </div>

            <div className="au-rows">
                {loading && <div className="au-empty">Loading…</div>}

                {!loading && error !== null && (
                    // §7.8 assigns this state explicitly: a store returning `Err(Disabled)` used to
                    // render as an empty list, indistinguishable from "you have no rules" — which
                    // invites a user to recreate rules that already exist. The alert line above says
                    // what went wrong; this says what it does NOT mean.
                    <div className="au-empty">
                        <h4>Your automations could not be read</h4>
                        <p>
                            The rule store did not answer, so this list is showing nothing rather
                            than nothing being there. <b>Your rules have not been deleted.</b> Any
                            enabled rule is still running in the background — the engine reads the
                            store directly and does not go through this page.
                        </p>
                        <button type="button" className="au-btn" onClick={() => void refresh()}>
                            Try again
                        </button>
                    </div>
                )}

                {!loading && error === null && rules.length === 0 && (
                    // The EMPTY state — nothing has been created. Deliberately not the same shape as
                    // a rule that is switched off: one is an invitation, the other is a rule you
                    // already decided about, and drawing them alike is how a paused rule reads as a
                    // lost one.
                    <div className="au-empty">
                        <h4>No automations yet</h4>
                        <p>
                            An automation watches a terminal&apos;s output and types something back
                            when a condition is met — once per crossing, never once per line. Start
                            from one of the six built-in templates.
                        </p>
                        <button
                            type="button"
                            className="au-btn primary"
                            onClick={() => setView({ kind: 'gallery' })}
                        >
                            + New automation
                        </button>
                    </div>
                )}

                {!loading && error === null && rules.length > 0 && visible.length === 0 && (
                    <div className="au-empty">
                        <p>
                            No automations match this filter. {rules.length}{' '}
                            {rules.length === 1 ? 'rule is' : 'rules are'} still here — switch back
                            to <b>All</b> to see them.
                        </p>
                    </div>
                )}

                {visible.map((rule) => (
                    <AutomationRow
                        key={rule.id}
                        rule={rule}
                        pairs={runtime.rules[rule.id]}
                        now={now}
                        onToggle={(r, enabled) =>
                            void run('Switching the automation', () =>
                                api!.setAutomationEnabled!(r.id, enabled, origin))}
                        onEdit={(r) => openEditor(r)}
                        onDuplicate={(r) =>
                            void run('Duplicating', () => api!.duplicateAutomation!(r.id, origin))}
                        onLog={(r) => showLog(r.id)}
                        onDelete={(r) => setPendingDelete(r)}
                        onReset={(r) =>
                            void run('Resetting', () => api!.resetAutomation!(r.id, origin))}
                        // **Ids, never the rule.** This used to filter `targetIds` on `r` — a rule
                        // object out of a list this panel refreshes asynchronously — and send the
                        // whole thing back through `saveAutomation`, which is an unconditional
                        // upsert whose insert arm creates the row. So *Forget it* clicked on a rule
                        // another window had already deleted re-INSERTED it, exactly as *Add to an
                        // existing automation* did before `addAutomationTarget` replaced it; and a
                        // concurrent edit to the message or the name was reverted by every other
                        // column riding along beside the pick set this gesture meant to change.
                        // `removeAutomationTarget` makes the existence check and the removal one
                        // transaction, and `runOnRule` says so when the answer is no.
                        onForget={(r, ids) =>
                            void runOnRule('Forgetting the terminal', () =>
                                api!.removeAutomationTarget!(r.id, ids, origin))}
                    />
                ))}
            </div>

            <ConfirmDialog
                isOpen={pendingDelete !== null}
                title={`Delete “${pendingDelete?.name ?? ''}”?`}
                message={
                    <p>
                        Deleting this automation removes its steps and its history. If you only want
                        it to stop for now, <b>switch it off</b> instead — that keeps everything.
                    </p>
                }
                destructive
                confirmText="Delete"
                cancelText="Cancel"
                // The reversible option, offered first — the same shape TermFlow already uses when
                // confirming a tab close with live processes.
                secondaryText={pendingDelete?.enabled ? 'Switch off instead' : undefined}
                onSecondary={() => {
                    const rule = pendingDelete;
                    setPendingDelete(null);
                    if (rule) {
                        void run('Switching the automation off', () =>
                            api!.setAutomationEnabled!(rule.id, false, origin));
                    }
                }}
                onConfirm={() => {
                    const rule = pendingDelete;
                    setPendingDelete(null);
                    if (rule) {
                        void run('Deleting', () => api!.deleteAutomation!(rule.id, origin));
                    }
                }}
                onCancel={() => setPendingDelete(null)}
            />
        </div>
    );

    if (unavailable) {
        return (
            <div className="au-panel">
                <div className="au-panelhead">
                    <div className="au-panelhead-text">
                        <h3>Terminal automations</h3>
                        <p>
                            Automations run inside the desktop app, where the rule store and the
                            engine live. This window is connected over the web API, which has no
                            access to either.
                        </p>
                    </div>
                </div>
            </div>
        );
    }

    if (view.kind === 'gallery') {
        return (
            <TemplateGallery
                onBack={backToList}
                // The blank card is the one pick that decides nothing about the rule's content,
                // so it is the one that opens clean. Every other card is a template the user chose
                // and has not saved — which is what `'template'` says, and what makes Escape ask.
                onPick={(draft, templateId) =>
                    openEditor(draft, templateId === 'blank' ? 'blank' : 'template')}
            />
        );
    }

    if (view.kind === 'log') {
        return (
            <>
            {/*
              * Only `actionError`, never the rule-list `error`: the log view has its own read-error
              * state (`logError`, below), and the list's failure to load is not something this view
              * can act on or explain.
              */}
            {actionError && alertLine(actionError)}
            <ActivityLogView
                rule={rules.find((r) => r.id === view.ruleId) ?? null}
                entries={log}
                newestFirst={logScope?.newestFirst ?? false}
                error={logError}
                now={now}
                onScopeChange={(ruleId) => showLog(ruleId)}
                // The same class as `onForget` above, at its least obvious site: a switch that sets
                // ONE nullable column was sending the whole captured rule back through the upsert,
                // so it could resurrect a rule deleted in another window and revert an edit made in
                // one. `setAutomationVerbose` sends the id and the deadline. It also deliberately
                // does not move the rule's `updated_at` — `reload` re-arms a rule whose `updated_at`
                // moves, and turning the log's detail up to find out why a rule is not firing must
                // not re-arm the rule being watched.
                onSetVerbose={(r, until) =>
                    void runOnRule('Changing the log detail', () =>
                        api!.setAutomationVerbose!(r.id, until, origin))}
                onBack={backToList}
            />
            </>
        );
    }

    if (view.kind === 'editor') {
        // The editor is a PORTALLED modal over Settings, so the list stays mounted underneath it
        // rather than being replaced: closing it is then a state change and not a refetch, and the
        // rows the user came from are still where they left them.
        return (
            <>
                {list}
                <AutomationEditor
                    rule={view.draft}
                    opening={view.opening}
                    runtime={runtime}
                    now={now}
                    origin={origin}
                    onClose={() => setView({ kind: 'list' })}
                    onOpenFullLog={(ruleId) => showLog(ruleId)}
                    onChanged={refresh}
                />
            </>
        );
    }

    return list;
};
