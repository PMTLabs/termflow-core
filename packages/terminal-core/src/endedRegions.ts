import type { IDecoration, IMarker, Terminal } from '@xterm/xterm';

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

/** Width of the left rail, in cells. */
const RAIL_WIDTH = 1;

interface Region {
  start: IMarker;
  /** Lines from `start` down to the closing prompt. */
  height: number;
  wash?: IDecoration;
  rail?: IDecoration;
}

export interface EndedRegionOptions {
  maxRegions?: number;
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
 * Two decorations per region: a full-width background wash, and a left rail. The
 * rail carries the signal — it reads at a glance and survives a background the
 * wash can barely shift on some schemes.
 */
export class EndedRegionTracker {
  private openStart: IMarker | undefined;
  private openHadProgram = false;
  private regions: Region[] = [];
  private washColor: string | undefined;
  private railColor: string | undefined;
  private lastCols: number;
  private readonly maxRegions: number;

  constructor(private readonly term: Terminal, opts: EndedRegionOptions = {}) {
    this.maxRegions = opts.maxRegions ?? DEFAULT_MAX_REGIONS;
    this.lastCols = term.cols;
  }

  /** The shell rendered a prompt: close any open span, then open the next.
   *  registerMarker is non-nullable (xterm.d.ts:1147) — no null check needed. */
  onPrompt(): void {
    const closing = this.term.registerMarker(0);
    if (this.openStart && this.openHadProgram) {
      const height = closing.line - this.openStart.line;
      // A zero-height span (prompt with no output) has nothing to mark.
      if (height > 0) this.addRegion({ start: this.openStart, height });
      else this.openStart.dispose();
    } else {
      this.openStart?.dispose();
    }
    this.openStart = closing;
    this.openHadProgram = false;
  }

  /** Detection saw a non-shell program while this span is open. Tolerant by
   *  design: idempotent, and dropped if no span is open yet. */
  markProgramActive(): void {
    if (this.openStart) this.openHadProgram = true;
  }

  /** Colours arrive pre-blended from the renderer: xterm's decoration
   *  backgroundColor takes #RRGGBB only, with no alpha. */
  setColors(wash: string | undefined, rail: string | undefined): void {
    if (this.washColor === wash && this.railColor === rail) return;
    this.washColor = wash;
    this.railColor = rail;
    this.repaintAll();
  }

  /**
   * Narrowing maintains markers (xterm fires onInsert during _reflowSmaller), so
   * the marks follow and we keep them — free.
   *
   * Widening does NOT: reflowLargerApplyNewLayout rearranges lines via
   * CircularList.set and the length setter, neither of which emits. The marker is
   * neither moved nor disposed — isDisposed stays false, onDispose never fires —
   * so every anchor silently points at the wrong line. There is no fixup path in
   * xterm (its own search addon re-runs the whole search on resize instead).
   * Drop everything, including the open span, whose anchor is equally corrupt.
   *
   * Losing the marks is correct. Drifting them onto the wrong rows is not.
   */
  onResize(cols: number): void {
    const widened = cols > this.lastCols;
    this.lastCols = cols;
    if (!widened) return;
    for (const r of this.regions) this.disposeRegion(r);
    this.regions = [];
    this.openStart?.dispose();
    this.openStart = undefined;
    this.openHadProgram = false;
  }

  regionCount(): number {
    return this.regions.length;
  }

  dispose(): void {
    for (const r of this.regions) this.disposeRegion(r);
    this.regions = [];
    this.openStart?.dispose();
    this.openStart = undefined;
    this.openHadProgram = false;
  }

  private addRegion(region: Region): void {
    this.regions.push(region);
    while (this.regions.length > this.maxRegions) {
      const evicted = this.regions.shift();
      if (evicted) this.disposeRegion(evicted);
    }
    this.paint(region);
  }

  private paint(region: Region): void {
    if (region.start.line < 0) return; // anchor trimmed out of scrollback
    region.wash?.dispose();
    region.rail?.dispose();
    region.wash = undefined;
    region.rail = undefined;

    // ONE decoration for the whole span: width/height are in cells and xterm
    // renders it as a single div, so a 500-line region costs one element, not
    // 500. layer 'bottom' keeps search highlights on top — overlapping
    // decorations resolve last-registered-wins.
    if (this.washColor) {
      region.wash =
        this.term.registerDecoration({
          marker: region.start,
          width: this.term.cols,
          height: region.height,
          layer: 'bottom',
          backgroundColor: this.washColor,
        }) ?? undefined;
    }
    // The rail sits on top: a wash can be nearly invisible on some schemes, but a
    // solid bar in column 0 always reads.
    if (this.railColor) {
      region.rail =
        this.term.registerDecoration({
          marker: region.start,
          x: 0,
          width: RAIL_WIDTH,
          height: region.height,
          layer: 'top',
          backgroundColor: this.railColor,
        }) ?? undefined;
    }
  }

  private repaintAll(): void {
    const live: Region[] = [];
    for (const r of this.regions) {
      if (r.start.line < 0) {
        this.disposeRegion(r); // anchor trimmed out of scrollback
        continue;
      }
      live.push(r);
    }
    this.regions = live;
    for (const r of this.regions) this.paint(r);
  }

  private disposeRegion(r: Region): void {
    r.wash?.dispose();
    r.rail?.dispose();
    r.start.dispose();
  }
}
