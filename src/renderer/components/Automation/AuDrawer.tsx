/**
 * The bottom drawer: **Test run** for what would happen, **Activity** for what already did
 * (mockup §03).
 *
 * Two tabs and a close button. It holds no state of its own beyond which tab is showing — both
 * panes are given what they draw, so a drawer that is closed is not quietly keeping a stale report
 * alive.
 */
import React from 'react';
import type { AutomationLogEntry, DryRunReport, WatchableTerminal } from '../../types/electron';
import { AuTestPane } from './AuTestPane';
import { AuActivityPane } from './AuActivityPane';

export type DrawerTab = 'test' | 'activity';

export interface AuDrawerProps {
    tab: DrawerTab;
    onTab: (tab: DrawerTab) => void;
    onClose: () => void;

    report: DryRunReport | null;
    running: boolean;
    testError: string | null;
    terminals: WatchableTerminal[];
    chosen: string | null;
    onChoose: (id: string) => void;
    onRun: () => void;

    entries: AutomationLogEntry[];
    logError: string | null;
    saved: boolean;
    onOpenFullLog: () => void;
}

export const AuDrawer: React.FC<AuDrawerProps> = (props) => (
    <div className="au-drawer">
        <div className="au-dhead">
            <div className="au-dtabs" role="tablist" aria-label="Drawer view">
                <button
                    type="button"
                    role="tab"
                    aria-selected={props.tab === 'test'}
                    className={props.tab === 'test' ? 'on' : ''}
                    onClick={() => props.onTab('test')}
                >
                    Test run
                </button>
                <button
                    type="button"
                    role="tab"
                    aria-selected={props.tab === 'activity'}
                    className={props.tab === 'activity' ? 'on' : ''}
                    onClick={() => props.onTab('activity')}
                >
                    Activity
                </button>
            </div>
            <span className="au-grow" />
            <button type="button" className="au-btn sm" onClick={props.onClose}>
                Close
            </button>
        </div>

        {props.tab === 'test' ? (
            <AuTestPane
                report={props.report}
                running={props.running}
                error={props.testError}
                terminals={props.terminals}
                chosen={props.chosen}
                onChoose={props.onChoose}
                onRun={props.onRun}
            />
        ) : (
            <AuActivityPane
                entries={props.entries}
                error={props.logError}
                saved={props.saved}
                onOpenFullLog={props.onOpenFullLog}
            />
        )}
    </div>
);
