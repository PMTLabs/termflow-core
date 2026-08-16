import React, { useCallback, useMemo, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { selectNode } from '../../store/slices/canvasSlice';
import { renamePanes } from '../../store/slices/panesSlice';
import { updateTabTitle } from '../../store/slices/tabsSlice';
import { getAllCwdSnapshots } from '../../services/cwdSnapshot';
import { useFlyTo } from './CanvasViewport';
import { centreOn } from './viewportStyles';
import { useCanvasMetrics } from './canvasMetricsContext';
import { buildSidebarTree, SidebarRow } from './sidebarModel';
import type { CanvasModel } from './canvasSelectors';

/**
 * Group → Terminal tree with search and rename — `plan/013` Task 14, design 010 §5/§11.
 *
 * **This is the answer to "a terminal is in a group but off-screen"** (design §10), so a row
 * click FLIES rather than jumps: at canvas altitudes a jump gives you a different screen with
 * no way to tell where it came from.
 */

/** Zoom floor a row click flies to. Already closer than this? Keep the zoom you chose.
 *  Exported so its test asserts the real destination rather than a copy of the number. */
export const ROW_FLY_ZOOM = 0.85;

interface RowProps {
  row: SidebarRow;
  selected: boolean;
  editing: boolean;
  onClick: () => void;
  onDoubleClick: () => void;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

/** Title with the matched span wrapped, or plain when there is no query. */
const Title: React.FC<{ row: SidebarRow }> = ({ row }) => {
  if (row.matchStart < 0) return <>{row.title}</>;
  return (
    <>
      {row.title.slice(0, row.matchStart)}
      <mark>{row.title.slice(row.matchStart, row.matchEnd)}</mark>
      {row.title.slice(row.matchEnd)}
    </>
  );
};

/**
 * Its own component, and only mounted while a row is being edited, so `useState(initial)` runs
 * fresh every time. Held inside `Row` the draft would survive the whole life of the row, and a
 * cancelled edit would reappear, already typed, the next time you opened that row.
 *
 * **Blur commits, and Escape needs no guard against it.** The obvious worry is that cancelling
 * unmounts the input, which blurs it, which commits the draft that was just discarded — but
 * React listens at the root container, and by the time a removed element is blurred it no
 * longer bubbles anywhere. A latch for that was written, found unreachable under mutation, and
 * removed rather than left in as untestable insurance.
 */
const RenameInput: React.FC<{
  initial: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}> = ({ initial, onCommit, onCancel }) => {
  const [draft, setDraft] = useState(initial);
  return (
    <input
      className="canvas-srename"
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); onCommit(draft); }
        // Stopped here, or the canvas Esc handler behind it also unfocuses the terminal.
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onCancel(); }
      }}
      onBlur={() => onCommit(draft)}
    />
  );
};

const Row: React.FC<RowProps> = ({ row, selected, editing, onClick, onDoubleClick, onCommit, onCancel }) => {
  if (editing) {
    return (
      <li className="canvas-srow editing">
        <RenameInput initial={row.title} onCommit={onCommit} onCancel={onCancel} />
      </li>
    );
  }

  return (
    <li
      className={['canvas-srow', selected ? 'selected' : '', row.isRunning ? 'running' : ''].filter(Boolean).join(' ')}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={row.disambiguator ? `${row.title} — ${row.disambiguator}` : row.title}
    >
      <span className="canvas-srow-title"><Title row={row} /></span>
      {row.disambiguator && <span className="canvas-srow-dis">{row.disambiguator}</span>}
      {/* The tab strip's own indicator, reused rather than restyled (design 010 §9). */}
      {row.hasUnseenOutput && <span className="tab-unseen-bell" title="New output you haven't seen yet">🔔</span>}
    </li>
  );
};

export const CanvasSidebar: React.FC<{ model: CanvasModel; vw: number; vh: number }> = ({ model, vw, vh }) => {
  const dispatch = useDispatch();
  const width = useSelector((s: RootState) => s.canvas.sidebarWidth);
  const selectedId = useSelector((s: RootState) => s.canvas.selectedId);
  const zoom = useSelector((s: RootState) => s.canvas.viewport.z);
  const metrics = useCanvasMetrics();
  const flyTo = useFlyTo();

  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);

  // Named explicitly rather than passed as `{}`. Every test here still passes with an empty
  // map — and every disambiguator silently degrades to a short id, which is the least useful
  // of the three fallbacks and the one nobody would notice was wrong.
  const tree = useMemo(
    () => buildSidebarTree(model.nodes, model.groups, query, getAllCwdSnapshots()),
    [model, query],
  );

  const flyToNode = useCallback((terminalId: string) => {
    const n = model.nodes.find((x) => x.terminalId === terminalId);
    if (!n) return;
    dispatch(selectNode(terminalId));
    flyTo(centreOn(n.rect, vw, vh, Math.max(zoom, ROW_FLY_ZOOM), metrics.zMax));
  }, [model, dispatch, flyTo, vw, vh, zoom, metrics]);

  /**
   * `tabId` is REQUIRED here, and that is the whole point of Task 1.
   *
   * `renamePanes` falls back to the active tab when it is omitted — and the active tab in Canvas
   * Mode is the canvas tab, which has no pane tree, so an omitted id would make every rename a
   * silent no-op. The pane id comes off the model, which already carries it for "open in its
   * tab"; walking the tree again with `findPaneIdByTerminalId` would find the same leaf.
   */
  const commitRename = useCallback((terminalId: string, name: string) => {
    setEditingId(null);
    const trimmed = name.trim();
    const n = model.nodes.find((x) => x.terminalId === terminalId);
    if (!n || !trimmed || trimmed === n.title) return;
    dispatch(renamePanes({ paneId: n.paneId, name: trimmed, tabId: n.tabId }));

    // When the terminal IS the tab, the tab strip has to agree — design 010 §2.1 makes the pane
    // name the node's title, and a tab whose only pane was renamed would otherwise keep a title
    // nothing on the canvas still shows.
    const g = model.groups.find((x) => x.tabId === n.tabId);
    if (g && g.nodeIds.length === 1) dispatch(updateTabTitle({ id: n.tabId, title: trimmed }));
  }, [model, dispatch]);

  return (
    <div className="canvas-sidebar" style={{ width }}>
      <input
        className="canvas-ssearch"
        type="search"
        placeholder="Search terminals"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        // Esc clears the filter instead of reaching the canvas handler behind it.
        onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setQuery(''); } }}
      />
      {!tree.length ? (
        <div className="canvas-sempty">
          {query.trim() ? <>No terminal matches “{query.trim()}”.</> : 'No terminals yet'}
        </div>
      ) : (
        <div className="canvas-stree">
          {tree.map((g) => (
            <section key={g.tabId} className="canvas-sgroup">
              <h3 className="canvas-sghead" data-tab-id={g.tabId}>{g.title}</h3>
              <ul className="canvas-srows">
                {g.rows.map((r) => (
                  <Row
                    key={r.terminalId}
                    row={r}
                    selected={selectedId === r.terminalId}
                    editing={editingId === r.terminalId}
                    onClick={() => flyToNode(r.terminalId)}
                    onDoubleClick={() => setEditingId(r.terminalId)}
                    onCommit={(name) => commitRename(r.terminalId, name)}
                    onCancel={() => setEditingId(null)}
                  />
                ))}
              </ul>
              {/* An emptied group keeps its place in the list because it is still a drop target
                  (design §6.3/§10) — Task 15 drags rows onto these headers. */}
              {!g.rows.length && <p className="canvas-sgempty">Empty</p>}
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

export default CanvasSidebar;
