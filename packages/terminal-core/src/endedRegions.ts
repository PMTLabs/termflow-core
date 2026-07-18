import type { IDecoration, IDisposable, IMarker, Terminal } from '@xterm/xterm';

/** Minimal buffer surface for logical-line math (real xterm's `buffer.active`). */
interface LogicalBuffer {
  length: number;
  getLine(n: number): { isWrapped: boolean } | undefined;
}

/**
 * Logical-line index of absolute row `row`: the count of logical-line STARTS in
 * [0, row]. A row whose `isWrapped` is true CONTINUES the previous row (xterm
 * semantics; mirrors collectWrappedLine in TerminalEngine); a non-wrapped or absent
 * row starts a new logical line. Reflow-invariant: a widen/narrow changes which rows
 * a logical line occupies, never its index — this is what lets a WIDEN re-anchor.
 */
export function logicalIndexOfRow(buffer: LogicalBuffer, row: number): number {
  const end = Math.min(row, buffer.length - 1);
  let logical = -1;
  for (let r = 0; r <= end; r++) {
    const line = buffer.getLine(r);
    if (!line || !line.isWrapped) logical++;
  }
  return logical < 0 ? 0 : logical;
}

/**
 * Inverse: the absolute row where logical line `logical` starts, by walking from row
 * 0 counting logical-line starts. Returns `buffer.length` when `logical` is past the
 * end, so a boundary at/after the last line clamps to the buffer bottom.
 */
export function rowForLogicalIndex(buffer: LogicalBuffer, logical: number): number {
  let count = -1;
  for (let r = 0; r < buffer.length; r++) {
    const line = buffer.getLine(r);
    if (!line || !line.isWrapped) {
      count++;
      if (count === logical) return r;
    }
  }
  return buffer.length;
}

/**
 * terminalId -> tracker, so a scheme change can repaint the marks without a React
 * re-render. Scheme changes land in the renderer's applyEffectiveThemes, which
 * writes straight to the cached terminal — the pane component never re-renders
 * for them, so pushing colours from a mount effect would set them once and never
 * update. The terminal cache is the obvious home for this, but its entries hold
 * only xterm state (no engine reference), and reaching back into TerminalEngine
 * from there would be a circular import. A registry owned by this module keeps
 * the dependency pointing one way.
 */
const trackers = new Map<string, EndedRegionTracker>();

/** Called by the engine on mount; the id is the terminal's cache key. */
export function registerEndedRegionTracker(terminalId: string, tracker: EndedRegionTracker): void {
  trackers.set(terminalId, tracker);
}

/** Called by the engine on unmount. */
export function unregisterEndedRegionTracker(terminalId: string): void {
  trackers.delete(terminalId);
}

/** Repaint the ended-program marks for these terminals in their scheme's colours.
 *  A terminal with no live tracker (never mounted, or unmounted) is skipped. */
export function setEndedRegionColorsFor(
  terminalIds: string[],
  wash: string | undefined,
  rail: string | undefined,
): void {
  for (const id of terminalIds) trackers.get(id)?.setColors(wash, rail);
}

/** Test-only: drop all registrations between cases. */
export function __resetEndedRegionTrackers(): void {
  trackers.clear();
}

/** Retained regions per terminal. A long session must not accumulate decorations
 *  without bound; the oldest tint is also the least interesting. */
const DEFAULT_MAX_REGIONS = 20;

/**
 * Hard cap on decorated lines across all regions. Every line needs its own marker
 * and decorations (see paint), and xterm walks all registered decorations each
 * frame — so this is what stops a long session from accumulating thousands.
 */
const MAX_DECORATED_LINES = 600;

/** The rail is a plain <div> in the terminal's OUTER wrapper (a sibling of xterm),
 *  not an xterm decoration. That puts it at the pane's TRUE left edge — past both the
 *  terminal-display and xterm padding — so it can never overlap the text, and its
 *  style is fully ours (no CSS the app might suppress on decoration elements, e.g.
 *  `transform`). It has no vertical anchor of its own; it MIRRORS the region's wash
 *  decorations, which xterm positions correctly and which stay reflow-proof. Styling
 *  (width, inset) lives in TerminalDisplay.css keyed on these classes. */
const RAIL_LAYER_CLASS = 'ended-rail-layer';
const RAIL_CLASS = 'ended-rail';
const WRAPPER_SELECTOR = '.terminal-display-wrapper';
/** Width (px) of the rail's accent segment. It sits flush at the pane's left edge;
 *  the remainder of the gutter, up to the wash, is filled with the wash colour. */
const RAIL_WIDTH_PX = 6;

interface Region {
  /** Top of the region (the prompt that opened the span). */
  start: IMarker;
  /** Bottom of the region, exclusive (the closing prompt's line). start+end BRACKET
   *  the region so its per-line coverage can be REBUILT for the current row span
   *  after a reflow — the lines a region occupies change when the terminal re-wraps,
   *  so a fixed set of per-line markers goes gappy (see paint/onResize). */
  end: IMarker;
  /** One marker per row in the CURRENT [start, end) span, rebuilt on paint.
   *
   *  A single decoration spanning the region CANNOT work: xterm renders a decoration
   *  only when its ANCHOR line is inside the viewport — `_refreshStyle` computes
   *  `marker.line - ydisp` and sets display:none when that is < 0 or >= rows. So a
   *  region taller than the viewport, or scrolled so its top is off screen, vanished
   *  entirely. Per-line anchors are how xterm's own search addon highlights matches,
   *  and they render whichever rows are actually visible. */
  lineMarkers: IMarker[];
  /** The WASH — one bottom-layer decoration per row. The rail mirrors these. */
  decorations: IDecoration[];
  /** The rail <div> for this region (in the wrapper's rail layer), or undefined
   *  until the terminal is live / a screen exists. */
  railEl: HTMLElement | undefined;
  /** Reflow-invariant logical-line index of `start` / `end`, refreshed from the
   *  markers on cols-stable renders. A column-WIDEN leaves xterm's markers stale
   *  (reflowLarger emits nothing), so these let onResize re-derive the true rows. */
  startLogical: number;
  endLogical: number;
  /** `start.line` at the last cache refresh; the walk is skipped when it hasn't moved
   *  (a region-internal re-wrap moves end.line but not the reflow-invariant span). */
  cachedAtLine: number;
}

export interface EndedRegionOptions {
  maxRegions?: number;
  /** Coalesce resize handling: a window drag fires dozens of resize events, each
   *  rebuilding every region's per-row decorations. When > 0, the re-anchor + repaint
   *  is deferred until this many ms after the last resize event. 0 (default) is
   *  synchronous, which unit tests rely on. */
  debounceMs?: number;
}

/**
 * Marks the scrollback a now-ended program produced, so historical output is
 * visibly distinct from the live shell below it.
 *
 * Boundaries come from the shell's prompt OSC. That is precise and needs no
 * polling: PS_CWD_INTEGRATION (pty_manager.rs) makes PowerShell emit OSC 9;9
 * from inside `prompt {}` — [Console]::Write runs at the cursor BEFORE the
 * prompt string is returned, and an OSC is zero-width, so a marker registered
 * when it fires anchors to the line the prompt is about to render on.
 *
 * "Did a program run in this span" is pushed in via markProgramActive() by the
 * renderer's existing detection. That poll is a poor boundary source (~2s of
 * drift is a visible wrong edge) but a fine yes/no predicate over a span lasting
 * seconds to minutes.
 *
 * The WASH is per-line decorations (behind the text). The RAIL is a plain <div> in
 * the terminal's outer wrapper — see RAIL_CLASS — positioned by MIRRORING the wash on
 * every render, so xterm owns the hard part (which rows are where) and the rail sits
 * at the pane's true left edge with full style control.
 *
 * (Legacy note) Two decorations per line: a full-width background WASH (behind the text) and a
 * left RAIL. Both are xterm decorations, so xterm owns their vertical position — it
 * re-sets `top` from `marker.line - ydisp` every frame, which keeps them glued to
 * the content through scrolling and resizing.
 *
 * The rail's slim width and its shift into the left gutter are done purely in CSS
 * (TerminalDisplay.css), keyed on xterm's own `.xterm-decoration-top-layer` class —
 * the rail is the ONLY top-layer decoration the app creates (search highlights are
 * bottom-layer), so that class uniquely identifies it. Doing it in CSS rather than a
 * JS render hook keeps it deterministic and out of the render loop. The wash's width
 * is the live column count; because a decoration freezes that at creation time, a
 * column change repaints the wash (onResize) so it re-spans the new width.
 */
export class EndedRegionTracker {
  private openStart: IMarker | undefined;
  private openHadProgram = false;
  /** Cached logical anchor for the OPEN span's start, mirrored from openStart. */
  private openLogical = -1;
  private openCachedAtLine = -1;
  private regions: Region[] = [];
  private washColor: string | undefined;
  private railColor: string | undefined;
  private lastCols: number;
  private lastRows: number;
  private readonly maxRegions: number;
  private readonly debounceMs: number;
  /** Pending debounced-resize timer, and whether any step of the current gesture was
   *  a WIDEN (which corrupts markers — a later narrow adjusts from the corrupted
   *  position, so once widened we must re-anchor at flush time). */
  private resizeTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingWiden = false;
  private railLayer: HTMLElement | undefined;
  private readonly renderSub: IDisposable | undefined;

  constructor(private readonly term: Terminal, opts: EndedRegionOptions = {}) {
    this.maxRegions = opts.maxRegions ?? DEFAULT_MAX_REGIONS;
    this.debounceMs = opts.debounceMs ?? 0;
    this.lastCols = term.cols;
    this.lastRows = term.rows;
    // The rail mirrors the wash, so it must be re-placed whenever xterm re-renders
    // (scroll, output, reflow). onRender fires on every frame the grid changes.
    this.renderSub = this.term.onRender?.(() => {
      this.positionRails();
      // Refresh the reflow-invariant logical anchors from the (valid) markers, but
      // only when no width change is pending: the reflow render itself fires with
      // stale markers on a widen and must not poison the cache. (Ordering is on our
      // side — xterm fires onResize before onRender — but this guard is belt-and-
      // suspenders regardless of which fires first.)
      if (this.term.cols === this.lastCols) this.refreshLogicalCache();
    });
  }

  /** The shell rendered a prompt: close any open span, then open the next.
   *  registerMarker is non-nullable (xterm.d.ts:1147) — no null check needed. */
  onPrompt(): void {
    const closing = this.term.registerMarker(0);
    const height = this.openStart ? closing.line - this.openStart.line : -1;
    if (this.openStart && this.openHadProgram && height > 0) {
      // Bracket the region with start + end markers; paint() fills in the per-row
      // coverage. A separate end marker (same line as `closing`) is needed because
      // `closing` becomes the NEXT span's start and must keep its own identity.
      const end = this.term.registerMarker(0);
      const buffer = this.term.buffer.active;
      this.addRegion({
        start: this.openStart,
        end,
        lineMarkers: [],
        decorations: [],
        railEl: undefined,
        startLogical: logicalIndexOfRow(buffer, this.openStart.line),
        endLogical: logicalIndexOfRow(buffer, end.line),
        cachedAtLine: this.openStart.line,
      });
    } else {
      // Nothing to mark: no program ran, or a zero-height span (prompt, no output).
      this.openStart?.dispose();
    }
    this.setOpenStart(closing);
    this.openHadProgram = false;
  }

  /**
   * Open a span at the cursor, unless one is already open.
   *
   * The engine calls this once the terminal is live. Without it the FIRST span of
   * every mount has no opening anchor and is silently lost: a mount hydrates from
   * the backend's SNAPSHOT — a rendered screen, not the raw byte stream — so the
   * OSC of the prompt that was already on screen never reaches xterm's parser.
   * A program launched from that prompt would then be detected with no span to
   * attach to, and its output would never be marked.
   *
   * This anchor is the start of everything this mount has seen, which is the best
   * available boundary when no prompt was observed. Real prompts take over from
   * the next one onward.
   */
  openSpanHere(): void {
    if (this.openStart) return;
    this.setOpenStart(this.term.registerMarker(0));
  }

  /** Detection saw a non-shell program while this span is open. Tolerant by
   *  design: idempotent, and dropped if no span is open yet. */
  markProgramActive(): void {
    // A program is running but no prompt has been observed on this mount (see
    // openSpanHere) — anchor here rather than drop the run entirely. The mark is
    // late by up to one detection poll, so the span starts a little into the
    // program's output; that beats not marking it at all.
    if (!this.openStart) this.openSpanHere();
    this.openHadProgram = true;
  }

  /** Colours arrive pre-blended from the renderer: xterm's decoration
   *  backgroundColor takes #RRGGBB only, with no alpha. */
  setColors(wash: string | undefined, rail: string | undefined): void {
    if (this.washColor === wash && this.railColor === rail) return;
    this.washColor = wash;
    this.railColor = rail;
    this.repaintAll();
    this.positionRails(); // pick up the new rail colour immediately
  }

  /** Assign the open span's start marker and cache its logical anchor immediately, so
   *  a widen that lands before any render can still re-derive it. */
  private setOpenStart(marker: IMarker | undefined): void {
    this.openStart = marker;
    if (marker && marker.line >= 0) {
      this.openLogical = logicalIndexOfRow(this.term.buffer.active, marker.line);
      this.openCachedAtLine = marker.line;
    } else {
      this.openLogical = -1;
      this.openCachedAtLine = -1;
    }
  }

  /**
   * On a column change, REBUILD each region's per-row coverage.
   *
   * A reflow re-wraps the region's content, so the set of rows it occupies changes:
   * narrowing splits long lines into more rows, widening merges them into fewer. A
   * fixed set of per-line markers made at close time then covers the wrong rows —
   * leaving un-tinted gaps between the rows it still covers (verified in a spike:
   * an 11-row region became 21 rows on a narrow, but only 11 stayed tinted). paint()
   * re-derives the markers from the current [start, end) span, so every row is
   * covered again, and re-spans the wash to the new width in the same pass. We never
   * DROP the marks — vanishing on resize is worse than any imperfection.
   *
   * start/end ride the reflow differently by direction. NARROW: xterm's _reflowSmaller
   * fires onInsert so the markers adjust, and paint() rebuilds coverage for the new row
   * span. WIDEN: reflowLargerApplyNewLayout moves lines via CircularList.set / length=
   * which emit nothing, so xterm leaves the marker line numbers stale — so
   * reanchorForWiden() re-derives each marker's row from its reflow-invariant
   * logical-line index and re-registers it (see that method). We never drop the marks.
   */
  onResize(cols: number, rows?: number): void {
    const colsChanged = cols !== this.lastCols;
    const rowsChanged = rows !== undefined && rows !== this.lastRows;
    if (!colsChanged && !rowsChanged) return;
    // A WIDEN anywhere in the gesture corrupts markers (reflowLarger emits nothing,
    // and a later narrow adjusts from the corrupted position), so latch it.
    if (colsChanged && cols > this.lastCols) this.pendingWiden = true;
    this.lastCols = cols;
    if (rows !== undefined) this.lastRows = rows;
    // Coalesce the (expensive) re-anchor + full repaint to the end of the resize
    // gesture: a window drag fires dozens of these, each rebuilding every region's
    // per-row decorations. Debounced in production; synchronous (debounceMs 0) in tests.
    if (this.debounceMs > 0) {
      if (this.resizeTimer !== undefined) clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.flushResize(), this.debounceMs);
    } else {
      this.flushResize();
    }
  }

  /**
   * Apply a settled resize: re-anchor from the reflow-invariant logical cache if any
   * step of the gesture widened (markers are stale), then rebuild every region's
   * coverage for the new width/height. A NARROW keeps markers exact (onInsert) and a
   * ROW-only resize doesn't touch the buffer, so those just repaint.
   */
  private flushResize(): void {
    this.resizeTimer = undefined;
    if (this.pendingWiden) this.reanchorForWiden();
    this.pendingWiden = false;
    this.repaintAll();
  }

  /**
   * Re-derive each region's start/end from their cached logical-line indices (valid
   * as of the last cols-stable render) and re-register the markers at the corrected
   * rows via an isWrapped walk of the reflowed buffer. Replaces the old drop-on-widen:
   * the marks stay on the region instead of drifting onto the live prompt or vanishing.
   * A region whose bracket was disposed (line -1, trimmed out of scrollback) is left
   * for repaintAll to drop.
   */
  private reanchorForWiden(): void {
    const buffer = this.term.buffer.active;
    const cursorAbs = buffer.baseY + buffer.cursorY;
    for (const r of this.regions) {
      if (r.start.line < 0 || r.end.line < 0) continue;
      r.start = this.reanchorMarker(r.start, r.startLogical, cursorAbs);
      r.end = this.reanchorMarker(r.end, r.endLogical, cursorAbs);
      // Re-sync the cache from the fresh markers so a rapid chain of widen events
      // during a monitor drag stays correct without an interleaved render.
      r.startLogical = logicalIndexOfRow(buffer, r.start.line);
      r.endLogical = logicalIndexOfRow(buffer, r.end.line);
      r.cachedAtLine = r.start.line;
    }
    // The open span's anchor is equally stale on a widen — re-anchor it too, so a
    // program running RIGHT NOW keeps its in-progress region markable when it ends.
    // openHadProgram is intentionally preserved: the program is still running.
    if (this.openStart && this.openStart.line >= 0) {
      this.setOpenStart(this.reanchorMarker(this.openStart, this.openLogical, cursorAbs));
    }
  }

  /** Dispose a stale marker and register a fresh one at the row where logical line
   *  `logical` currently starts (via the reflowed buffer's isWrapped flags). */
  private reanchorMarker(stale: IMarker, logical: number, cursorAbs: number): IMarker {
    const row = rowForLogicalIndex(this.term.buffer.active, logical);
    stale.dispose();
    return this.term.registerMarker(row - cursorAbs);
  }

  /** Refresh cached logical anchors from the CURRENT (valid) markers. Walks only when
   *  a region's start.line moved since the last refresh (trim / insert-above); a
   *  region-internal re-wrap moves end.line but not the reflow-invariant endLogical. */
  private refreshLogicalCache(): void {
    const buffer = this.term.buffer.active;
    for (const r of this.regions) {
      if (r.start.line < 0 || r.end.line < 0) continue;
      if (r.start.line === r.cachedAtLine) continue;
      r.startLogical = logicalIndexOfRow(buffer, r.start.line);
      r.endLogical = logicalIndexOfRow(buffer, r.end.line);
      r.cachedAtLine = r.start.line;
    }
    if (
      this.openStart &&
      this.openStart.line >= 0 &&
      this.openStart.line !== this.openCachedAtLine
    ) {
      this.openLogical = logicalIndexOfRow(buffer, this.openStart.line);
      this.openCachedAtLine = this.openStart.line;
    }
  }

  regionCount(): number {
    return this.regions.length;
  }

  dispose(): void {
    if (this.resizeTimer !== undefined) {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = undefined;
    }
    this.renderSub?.dispose();
    for (const r of this.regions) this.disposeRegion(r);
    this.regions = [];
    this.railLayer?.remove();
    this.railLayer = undefined;
    this.openStart?.dispose();
    this.setOpenStart(undefined);
    this.openHadProgram = false;
  }

  private addRegion(region: Region): void {
    this.regions.push(region);
    // Bound BOTH the region count and the total decorated lines: every line costs
    // a marker plus decorations, and xterm walks all registered decorations each
    // frame. The oldest region is also the least interesting.
    while (
      this.regions.length > this.maxRegions ||
      (this.regions.length > 1 && this.decoratedLines() > MAX_DECORATED_LINES)
    ) {
      const evicted = this.regions.shift();
      if (evicted) this.disposeRegion(evicted);
    }
    this.paint(region);
  }

  private decoratedLines(): number {
    return this.regions.reduce((n, r) => n + Math.max(0, r.end.line - r.start.line), 0);
  }

  /**
   * (Re)build a region's coverage: one wash + rail per ROW across the current
   * [start, end) span. Re-derived every paint so it survives reflow (see onResize).
   *
   * Per-row rather than one tall decoration: xterm renders a decoration only while
   * its anchor line is inside the viewport (`_refreshStyle`: `marker.line - ydisp`,
   * display:none when < 0 or >= rows). A single tall decoration disappears the moment
   * its top scrolls off — always, for output that fills the screen. Per-row anchors
   * render whichever rows are visible; off-screen ones create no element, so the cost
   * is bounded by the viewport, not the region.
   */
  private paint(region: Region): void {
    for (const d of region.decorations) d.dispose();
    region.decorations = [];
    for (const m of region.lineMarkers) m.dispose();
    region.lineMarkers = [];
    if (!this.washColor && !this.railColor) return;
    if (region.start.line < 0 || region.end.line < 0) return; // trimmed out of scrollback

    // registerMarker anchors at ybase+cursorY+offset, so to anchor at absolute row
    // R the offset is R - (ybase + cursorY). Cap the span so a huge region can't
    // register thousands of markers in one pass.
    if (this.washColor) {
      const cursorAbs = this.term.buffer.active.baseY + this.term.buffer.active.cursorY;
      const top = region.start.line;
      // Clamp the bottom to the cursor line. A column-WIDEN drifts region.end down
      // into the live content (xterm doesn't adjust markers on widen), which made the
      // tint "jump over" the new prompt. The cursor is always on the live input line
      // and IS updated on resize, so it's a reliable "never cross into live content"
      // boundary — the region can extend no further than one row above it.
      const bottom = Math.min(region.end.line, top + MAX_DECORATED_LINES, cursorAbs);
      for (let row = top; row < bottom; row++) {
        const marker = this.term.registerMarker(row - cursorAbs);
        if (marker.line < 0) { marker.dispose(); continue; }
        region.lineMarkers.push(marker);
        // The wash sits below the text (bottom layer, full current width). Its colour
        // comes from the decoration option; xterm owns each element's `top`.
        const wash = this.term.registerDecoration({
          marker,
          width: this.term.cols,
          height: 1,
          layer: 'bottom',
          backgroundColor: this.washColor,
        });
        if (wash) {
          region.decorations.push(wash);
          // Re-place the rail whenever this wash row renders. term.onRender only
          // fires on GRID changes, but a decoration renders on its own (creation,
          // scroll, reflow) — and the region is created AFTER the prompt's grid
          // render, so without this the rail would be placed before the wash exists
          // and then never again. Disposed with the decoration.
          wash.onRender?.(() => this.positionRail(region));
        }
      }
    }

    // The rail is an HTML <div> that mirrors the wash — create it now; positionRails()
    // (called on every render) places it against the wash's rendered top/bottom.
    if (this.railColor) this.ensureRail(region);
    this.positionRail(region);
  }

  /** Re-place every region's rail against its wash. Called on each render/scroll. */
  private positionRails(): void {
    for (const r of this.regions) this.positionRail(r);
  }

  /**
   * Mirror one region's wash: span the rail <div> from the top of the region's
   * topmost visible wash row to the bottom of its lowest, in the rail layer's
   * coordinate space. Hidden when the region has no on-screen wash (scrolled away)
   * or no rail colour. This delegates the hard vertical tracking to xterm, which
   * already positions the wash correctly through scroll and reflow.
   */
  private positionRail(region: Region): void {
    const el = region.railEl;
    if (!el) return;
    const layer = this.railLayer;
    if (!this.railColor || !layer) { el.style.display = 'none'; return; }
    let top = Infinity;
    let bottom = -Infinity;
    let washLeft = Infinity;
    for (const d of region.decorations) {
      const e = d.element;
      if (!e || e.style.display === 'none') continue;
      const r = e.getBoundingClientRect();
      if (r.height === 0) continue;
      if (r.top < top) top = r.top;
      if (r.bottom > bottom) bottom = r.bottom;
      if (r.left < washLeft) washLeft = r.left;
    }
    if (bottom <= top || washLeft === Infinity) { el.style.display = 'none'; return; }
    const layerRect = layer.getBoundingClientRect();
    el.style.top = `${top - layerRect.top}px`;
    el.style.height = `${bottom - top}px`;
    // Flush at the pane's left edge, filling the whole gutter up to the wash: the first
    // RAIL_WIDTH_PX is the accent colour, the remainder is the wash colour bridging to
    // the tint. So there is never a gap on either side, whatever the text padding is.
    el.style.left = '0px';
    el.style.width = `${Math.max(0, washLeft - layerRect.left)}px`;
    const rail = this.railColor ?? this.washColor ?? '';
    const wash = this.washColor ?? this.railColor ?? '';
    el.style.background =
      `linear-gradient(to right, ${rail}, ${rail} ${RAIL_WIDTH_PX}px, ${wash} ${RAIL_WIDTH_PX}px)`;
    el.style.display = 'block';
  }

  /** Create the rail layer in the terminal's outer wrapper, once the DOM exists. */
  private ensureRailLayer(): HTMLElement | undefined {
    if (this.railLayer) return this.railLayer;
    if (typeof document === 'undefined' || !this.term.element) return undefined;
    const wrapper = this.term.element.closest(WRAPPER_SELECTOR) ?? this.term.element.parentElement;
    if (!wrapper) return undefined;
    const layer = document.createElement('div');
    layer.className = RAIL_LAYER_CLASS;
    wrapper.appendChild(layer);
    this.railLayer = layer;
    return layer;
  }

  private ensureRail(region: Region): void {
    if (region.railEl) return;
    const layer = this.ensureRailLayer();
    if (!layer) return;
    const el = document.createElement('div');
    el.className = RAIL_CLASS;
    layer.appendChild(el);
    region.railEl = el;
  }

  private repaintAll(): void {
    const live: Region[] = [];
    for (const r of this.regions) {
      // A disposed bracket (line === -1) means the region has scrolled out of the
      // scrollback; xterm disposes a trimmed marker and reports line === -1.
      if (r.start.line < 0 || r.end.line < 0) {
        this.disposeRegion(r);
        continue;
      }
      live.push(r);
    }
    this.regions = live;
    for (const r of this.regions) this.paint(r);
  }

  private disposeRegion(r: Region): void {
    for (const d of r.decorations) d.dispose();
    r.decorations = [];
    for (const m of r.lineMarkers) m.dispose();
    r.lineMarkers = [];
    r.railEl?.remove();
    r.railEl = undefined;
    r.start.dispose();
    r.end.dispose();
  }
}
