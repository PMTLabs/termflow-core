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
import React, { useMemo, useState } from 'react';
import type { AutomationRule } from '../../../types/electron';
import { ConfirmDialog } from '../../UI/ConfirmDialog';
import { AutomationRow } from './AutomationRow';
import { TemplateGallery } from './TemplateGallery';
import { ActivityLogView } from './ActivityLogView';
import { automationRowState } from './automationState';
import { useAutomations } from './useAutomations';
import './AutomationsPanel.css';

/** Q6: the mockup draws the chips and defines nothing. Completed is a success, not a problem. */
type ListFilter = 'all' | 'active' | 'attention';

type View =
    | { kind: 'list' }
    | { kind: 'gallery' }
    | { kind: 'log'; ruleId: string | null }
    | { kind: 'editor'; draft: AutomationRule };

export const AutomationsPanel: React.FC = () => {
    const {
        rules,
        runtime,
        log,
        logScope,
        loading,
        error,
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
    // "just now". Re-read on every render, which a state event already triggers.
    const now = Date.now();

    const api = typeof window === 'undefined' ? undefined : window.electronAPI;

    const run = async (what: string, fn: () => Promise<unknown>) => {
        try {
            setActionError(null);
            await fn();
            await refresh();
        } catch (e) {
            setActionError(`${what} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    };

    const visible = useMemo(
        () =>
            rules.filter((rule) => {
                if (filter === 'all') return true;
                const state = automationRowState(rule, runtime.rules[rule.id], now);
                if (filter === 'active') return rule.enabled && state.id !== 'completed';
                return state.id === 'error';
            }),
        [rules, runtime, filter, now],
    );

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

    const openEditor = (draft: AutomationRule) => setView({ kind: 'editor', draft });

    const showLog = (ruleId: string | null) => {
        setLogScope({ ruleId, newestFirst: false });
        setView({ kind: 'log', ruleId });
    };

    const backToList = () => {
        setLogScope(null);
        setView({ kind: 'list' });
    };

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
                onPick={(draft) => openEditor(draft)}
            />
        );
    }

    if (view.kind === 'log') {
        return (
            <ActivityLogView
                rule={rules.find((r) => r.id === view.ruleId) ?? null}
                entries={log}
                newestFirst={logScope?.newestFirst ?? false}
                onScopeChange={(ruleId) => showLog(ruleId)}
                onBack={backToList}
            />
        );
    }

    if (view.kind === 'editor') {
        // TODO(M5): the rule editor mounts here. The seam is deliberately one branch and one
        // value — the draft — so the milestone that builds the editor replaces exactly this block
        // and nothing else, and so the panel's navigation is already written and tested around it.
        return (
            <div className="au-panel">
                <div className="au-panelhead">
                    <div className="au-panelhead-text">
                        <h3>{view.draft.name || 'Untitled automation'}</h3>
                        <p>The rule editor arrives with M5.</p>
                    </div>
                    <button type="button" className="au-btn" onClick={backToList}>
                        ← Back to the list
                    </button>
                </div>
            </div>
        );
    }

    return (
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

            {(error || actionError) && (
                <div className="au-errline standalone" role="alert">
                    <span aria-hidden="true">⚠</span>
                    <span>{actionError ?? error}</span>
                </div>
            )}

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

                {!loading && rules.length === 0 && (
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

                {!loading && rules.length > 0 && visible.length === 0 && (
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
                        onForget={(r, ids) =>
                            void run('Forgetting the terminal', () =>
                                api!.saveAutomation!(
                                    { ...r, targetIds: r.targetIds.filter((t) => !ids.includes(t)) },
                                    origin,
                                ))}
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
};
