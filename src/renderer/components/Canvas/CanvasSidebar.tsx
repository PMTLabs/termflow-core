import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { RootState } from '../../store';
import { selectNode, setSidebarZoom } from '../../store/slices/canvasSlice';
import { renamePanes } from '../../store/slices/panesSlice';
import { renameTab } from '../../services/renameTab';
import { getAllCwdSnapshots } from '../../services/cwdSnapshot';
import { useFlyTo } from './CanvasViewport';
import { centreOn } from './viewportStyles';
import { aimedNodeRect } from './canvasGeometry';
import { useCanvasMetrics } from './canvasMetricsContext';
import { buildSidebarTree, SidebarRow } from './sidebarModel';
import { useSidebarDrag } from './useSidebarDrag';
import { ShellProfileIcon } from '../Terminal/ShellProfileIcon';
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

/**
 * One notch of Ctrl+wheel, as a MULTIPLIER (Tam, 2026-08-21).
 *
 * Multiplicative, not additive, so a notch feels the same size at either end of the range — the
 * same reason `CanvasViewport` zooms the canvas by a ratio. An additive step of 0.1 is a seventh
 * of the way across the range near the floor and a twentieth near the ceiling, so the control
 * would speed up as you zoomed out.
 *
 * 1.1 gives ~10 notches across the whole 0.7–1.8 range: enough that a notch is a nudge rather
 * than a jump, few enough that reaching either end is not a chore.
 */
export const SIDEBAR_ZOOM_STEP = 1.1;

interface RowProps {
  row: SidebarRow;
  selected: boolean;
  editing: boolean;
  lifting: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
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

const Row: React.FC<RowProps> = ({
  row, selected, editing, lifting, onPointerDown, onClick, onDoubleClick, onCommit, onCancel,
}) => {
  if (editing) {
    return (
      <li className="canvas-srow editing">
        <RenameInput initial={row.title} onCommit={onCommit} onCancel={onCancel} />
      </li>
    );
  }

  return (
    <li
      className={[
        'canvas-srow',
        selected ? 'selected' : '',
        row.isRunning ? 'running' : '',
        lifting ? 'lifting' : '',
      ].filter(Boolean).join(' ')}
      onPointerDown={onPointerDown}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      title={row.disambiguator ? `${row.title} — ${row.disambiguator}` : row.title}
    >
      {/* The tab strip's own icon, reused (Req 6, `plan/020` §3) — `.canvas-srow.running`
          above is what makes it blink; the icon itself is unconditional, same as a tab's. */}
      <ShellProfileIcon shellType={row.shellType} />
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
  const sidebarZoom = useSelector((s: RootState) => s.canvas.sidebarZoom);
  const metrics = useCanvasMetrics();
  const flyTo = useFlyTo();

  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);

  // Row drag-to-regroup and the width handle (Task 15).
  const drag = useSidebarDrag(model);

  /**
   * Ctrl/Cmd+wheel scales the list's own text (Tam, 2026-08-21).
   *
   * **Registered natively and non-passively, exactly as `CanvasViewport` does.** React attaches
   * every wheel listener at the ROOT and passively, so `e.preventDefault()` from an `onWheel`
   * prop does nothing — the WebView then applies its own page zoom on top of ours, and the whole
   * app steps sideways while the sidebar scales. Nothing about that failure is visible in the
   * JSX, which is why the pattern is worth copying rather than re-deriving.
   *
   * The sidebar is a SIBLING of `.canvas-viewport`, so this cannot reach the canvas's own wheel
   * handler and the two gestures never contend: Ctrl+wheel over the canvas still means whatever
   * `canvasWheelMode` says it means.
   *
   * `zoomRef` rather than a dependency: the listener is registered once, and re-registering it
   * on every notch would drop wheel events mid-gesture — the same reason `CanvasViewport` gives.
   */
  const sidebarRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(sidebarZoom);
  zoomRef.current = sidebarZoom;

  useEffect(() => {
    const el = sidebarRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      // Bare wheel scrolls the list, which is what a list should do. Only the chord zooms.
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      // Sign only, never magnitude: a trackpad reports fractional deltas in the hundreds and a
      // mouse reports 100 per notch, so scaling BY the delta makes the same gesture behave
      // completely differently on the two devices.
      const step = e.deltaY < 0 ? SIDEBAR_ZOOM_STEP : 1 / SIDEBAR_ZOOM_STEP;
      dispatch(setSidebarZoom(zoomRef.current * step));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [dispatch]);

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
    // The node's DRAWN box at the zoom we are flying to — see `aimedNodeRect`. Centring the
    // reserved rect leaves the node sitting high by half its title-bar slack, and this row
    // click is the gesture whose whole promise is "put that terminal in front of me".
    const z = Math.max(zoom, ROW_FLY_ZOOM);
    flyTo(centreOn(aimedNodeRect(n.rect, z), vw, vh, z, metrics.zMax));
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
    //
    // Through `renameTab`, not a bare `updateTabTitle`: a tab rename is also the backend name of
    // every live pane and a save, and dispatching the title alone left the strip and the process
    // list disagreeing until the next restart.
    const g = model.groups.find((x) => x.tabId === n.tabId);
    if (g && g.nodeIds.length === 1) void renameTab(n.tabId, trimmed);
  }, [model, dispatch]);

  /**
   * Renaming the GROUP is renaming its tab, so it goes through the same service the tab strip
   * and the canvas group menu use — one chain, three entry points.
   *
   * Its own state slot, NOT the row's `editingId`. That was originally forced: `tabTreeSeed`
   * gave a renderer-created tab a root pane with `terminalId === tab.id`, so a solo tab's row
   * was keyed by the same string as its group — shared, opening the header would open that
   * row's editor alongside it, and the one you typed into might rename the pane rather than the
   * tab. Design 014 mints a distinct `tm-` leaf for every root, so the collision is gone; the
   * separate slot stays because a row editor and a group editor are still different things.
   */
  const commitGroupRename = useCallback((tabId: string, title: string) => {
    setEditingTabId(null);
    void renameTab(tabId, title);
  }, []);

  return (
    <>
    {/* `--sidebar-k` is the ONE knob the whole panel scales from — every font size and pad
        inside it is an `em` of this element's own font-size (see Canvas.css). Twelve `calc()`
        calls would have been twelve chances to forget one, and the one forgotten is always the
        one that looks wrong. WIDTH is deliberately untouched: it is the user's own drag, and a
        zoom that moved it would fight them. */}
    <div
      ref={sidebarRef}
      className="canvas-sidebar"
      style={{ width, ['--sidebar-k' as string]: sidebarZoom } as React.CSSProperties}
    >
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
            // `data-tab-id` on the SECTION, not the header: the drop target is read back with
            // `elementFromPoint().closest('.canvas-sgroup')`, so the id has to live on the
            // element that lookup lands on. Making the whole section the target is also more
            // forgiving than a 20px-tall header to aim a drag at.
            <section
              key={g.tabId}
              className={`canvas-sgroup${drag.dropTabId === g.tabId ? ' drop' : ''}`}
              data-tab-id={g.tabId}
            >
              <h3
                className={`canvas-sghead${editingTabId === g.tabId ? ' editing' : ''}`}
                onDoubleClick={() => setEditingTabId(g.tabId)}
                title={editingTabId === g.tabId ? undefined : `${g.title} — double-click to rename`}
              >
                {editingTabId === g.tabId ? (
                  <RenameInput
                    initial={g.title}
                    onCommit={(name) => commitGroupRename(g.tabId, name)}
                    onCancel={() => setEditingTabId(null)}
                  />
                ) : g.title}
              </h3>
              <ul className="canvas-srows">
                {g.rows.map((r) => (
                  <Row
                    key={r.terminalId}
                    row={r}
                    selected={selectedId === r.terminalId}
                    editing={editingId === r.terminalId}
                    lifting={drag.draggingId === r.terminalId}
                    onPointerDown={drag.onRowPointerDown(r.terminalId, g.tabId, r.title)}
                    // `click` fires after `pointerup`, so a completed drag would otherwise also
                    // fly the viewport to the node that just changed groups.
                    onClick={() => { if (!drag.consumeClick()) flyToNode(r.terminalId); }}
                    onDoubleClick={() => setEditingId(r.terminalId)}
                    onCommit={(name) => commitRename(r.terminalId, name)}
                    onCancel={() => setEditingId(null)}
                  />
                ))}
              </ul>
              {/* An emptied group keeps its place in the list because it is still a drop target
                  (design §6.3/§10). */}
              {!g.rows.length && <p className="canvas-sgempty">Empty</p>}
            </section>
          ))}
        </div>
      )}
    </div>
    <div
      className={`canvas-sresize${drag.resizing ? ' active' : ''}`}
      onPointerDown={drag.onResizePointerDown}
      role="separator"
      aria-orientation="vertical"
    />
    {drag.ghost && (
      // `position: fixed` in CLIENT coordinates, so it follows the cursor over the canvas as
      // well as over the list — a ghost clipped to the sidebar would disappear exactly when the
      // drag left it.
      <div className="canvas-sghost" style={{ left: drag.ghost.x + 12, top: drag.ghost.y + 12 }}>
        {drag.ghost.label}
      </div>
    )}
    </>
  );
};

export default CanvasSidebar;
