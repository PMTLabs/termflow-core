/**
 * The §04 terminal picker (R14) — Tam's round-1 request, and the component the boundary audit found
 * had **no owner**: terminals built the endpoint, settings-ui built the list, the editor built
 * panels, and the tick-table itself fell between them (§7.8).
 *
 * What it stores is the terminal **id**, always — *"a name isn't unique and a folder isn't either"* —
 * and the id is the same string the API and MCP tools use, so a rule and a script are talking about
 * the same terminal.
 *
 * **The dead row is the whole reason this table exists rather than a `<select>` of live terminals.**
 * A terminal that closes keeps its tick, greyed, and keeps its NAME and FOLDER, because
 * `list_watchable_terminals` fills a missing id from the rule's own label snapshot. Nothing else can
 * describe an id that is gone, and a bare id in a list of names reads as corruption.
 */
import React, { useMemo, useState } from 'react';
import type { WatchableTerminal } from '../../types/electron';

export interface AuTerminalPickerProps {
    rows: WatchableTerminal[];
    picked: string[];
    /** The picker could not be read at all — distinct from "nothing is open". */
    error: string | null;
    loading: boolean;
    onToggle: (id: string) => void;
    onSet: (ids: string[]) => void;
}

export const AuTerminalPicker: React.FC<AuTerminalPickerProps> = ({
    rows,
    picked,
    error,
    loading,
    onToggle,
    onSet,
}) => {
    const [filter, setFilter] = useState('');

    const shown = useMemo(() => {
        const needle = filter.trim().toLowerCase();
        if (needle.length === 0) return rows;
        return rows.filter((row) =>
            [row.id, row.label ?? '', row.folder ?? ''].some((f) => f.toLowerCase().includes(needle)));
    }, [rows, filter]);

    // Counted over the PICK SET, not over the filtered view: the bar reports what the rule watches,
    // and a filter is a way of looking at the table rather than a change to the rule.
    const open = picked.filter((id) => rows.find((r) => r.id === id)?.alive).length;
    const gone = picked.length - open;

    return (
        <div className="au-fgroup">
            <span className="au-flabel">Terminals</span>
            <input
                className="au-finput"
                placeholder="Filter by id, name or folder…"
                aria-label="Filter terminals"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
            />

            {error !== null && (
                <div className="au-pickfail" role="alert">
                    <b>The list of terminals could not be read.</b> Any terminals this rule already
                    watches are still watched — this table is the only thing that is missing.
                </div>
            )}

            <div className="au-tpick" role="group" aria-label="Choose terminals to watch">
                <div className="au-tpickhead" aria-hidden="true">
                    <span />
                    <span>Terminal ID</span>
                    <span>Name &amp; folder</span>
                    <span>State</span>
                </div>

                {loading && <div className="au-pickempty">Looking for open terminals…</div>}

                {!loading && error === null && rows.length === 0 && (
                    <div className="au-pickempty">
                        No terminals are open. Open one and this list fills in — or switch to{' '}
                        <b>Terminals matching a rule</b>, which does not need one open right now.
                    </div>
                )}

                {!loading && rows.length > 0 && shown.length === 0 && (
                    <div className="au-pickempty">
                        Nothing matches “{filter.trim()}”. {rows.length}{' '}
                        {rows.length === 1 ? 'terminal is' : 'terminals are'} still here.
                    </div>
                )}

                {shown.map((row) => {
                    const on = picked.includes(row.id);
                    return (
                        <button
                            type="button"
                            key={row.id}
                            className={`au-tpickrow${on ? ' on' : ''}${row.alive ? '' : ' gone'}`}
                            aria-pressed={on}
                            onClick={() => onToggle(row.id)}
                        >
                            <span className="au-cmark" aria-hidden="true">
                                ✓
                            </span>
                            <span className={`au-idchip${row.alive ? '' : ' gone'}`}>{row.id}</span>
                            <span className="au-who">
                                <span className="au-nm">{row.label ?? 'unnamed'}</span>
                                <span className="au-cw">{row.folder ?? ''}</span>
                            </span>
                            <span className="au-st">
                                <span className={`au-lv${row.alive ? '' : ' dead'}`} aria-hidden="true" />
                                {row.alive ? (row.busy ? 'running' : 'idle') : 'not open'}
                            </span>
                        </button>
                    );
                })}
            </div>

            <div className="au-pickbar">
                <span>
                    Watching <span className="au-n">{picked.length}</span>
                </span>
                {picked.length > 0 && (
                    <span className="au-picksay">
                        · {open} open{gone > 0 ? `, ${gone} not open right now` : ''}
                    </span>
                )}
                <span className="au-grow" />
                <button
                    type="button"
                    className="au-btn sm"
                    // Select-all over the LIVE rows only. Ticking a closed terminal the user has
                    // never chosen would pin a dead id on their behalf — the one thing this screen
                    // warns about — and they can still tick it by hand if they mean it.
                    onClick={() => onSet(Array.from(new Set([...picked, ...rows.filter((r) => r.alive).map((r) => r.id)])))}
                >
                    Select all
                </button>
                <button type="button" className="au-btn sm" onClick={() => onSet([])}>
                    None
                </button>
            </div>

            <div className="au-fhelp">
                A terminal that closes keeps its tick, greyed. The rule keeps running on the others
                and says so on its row; it starts watching that id again only if the terminal comes
                back — session restore brings ids back, closing a tab for good does not.{' '}
                <b>Forget it</b> on the row drops the dead id.
            </div>
        </div>
    );
};
