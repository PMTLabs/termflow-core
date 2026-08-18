/**
 * @jest-environment jsdom
 *
 * design/012 §4.4 (D17) + row 8 (D19) — §13 T16, T22b.
 *
 * Because only term.element moves, everything scoped to its FORMER ANCESTORS has
 * to be reproduced by the canvas host. Four independent things break without D17's
 * shape (`.terminal-display-wrapper > .terminal-display[data-terminal-id]` with a
 * real layout box):
 *   1. 15 CSS rules scoped under `.terminal-display` (TerminalDisplay.css) —
 *      without the class the WebGL scratch-canvas sliver bug returns (:80-92) and
 *      the grid loses its 8px rail gutter (:30-35).
 *   2. The global Ctrl+C guard, `activeElement.closest('.terminal-display')`
 *      (InputHandler.ts:268-269). Its sibling branch
 *      `activeElement.classList.contains('xterm')` does NOT save this — the focused
 *      node is xterm's helper TEXTAREA, not `.xterm`.
 *   3. The rail layer's `.closest('.terminal-display-wrapper')`
 *      (endedRegions.ts:560, selector const at :100).
 *   4. FitAddon.proposeDimensions(), which reads term.element.parentElement — i.e.
 *      the HOST itself and never the wrapper (spike 004 Q4, measured).
 */
import { isEditableNonTerminalTarget } from '../../../services/inputTargets';
import { setPaneBackgroundVar } from '../../../store/terminalTheme';
import { readSource } from '../../../utils/readSource';

/** The pane's structure, as TerminalDisplay.tsx:542-549 renders it. */
function makePane(id: string): { wrapper: HTMLElement; display: HTMLElement } {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-display-wrapper';
  const display = document.createElement('div');
  display.className = 'terminal-display';
  display.setAttribute('data-terminal-id', id);
  wrapper.appendChild(display);
  document.body.appendChild(wrapper);
  return { wrapper, display };
}

/** A canvas node host built to design 012 D17's contract. */
function makeCanvasHost(id: string): { wrapper: HTMLElement; display: HTMLElement } {
  const wrapper = document.createElement('div');
  wrapper.className = 'terminal-display-wrapper canvas-surface';
  const display = document.createElement('div');
  display.className = 'terminal-display';
  display.setAttribute('data-terminal-id', id);
  wrapper.appendChild(display);
  document.body.appendChild(wrapper);
  return { wrapper, display };
}

/** What xterm puts inside its host: `.xterm` with a helper textarea. */
function makeXtermElement(): { element: HTMLElement; textarea: HTMLTextAreaElement } {
  const element = document.createElement('div');
  element.className = 'xterm';
  const textarea = document.createElement('textarea');
  textarea.className = 'xterm-helper-textarea';
  element.appendChild(textarea);
  return { element, textarea };
}

// PLAN CORRECTION (015 Task 14). jsdom does not implement the `CSS` global at all,
// so `setPaneBackgroundVar`'s `CSS.escape(terminalId)` (terminalTheme.ts:39) throws
// `ReferenceError: CSS is not defined` under this runner — the plan predicted a
// wrong VALUE, not a throw. Only the test environment is short of the API; every
// real webview has it, so the production call stays as it is and the gap is filled
// here with the spec's own escaping rules (enough for the identifiers under test).
beforeAll(() => {
  const g = globalThis as unknown as { CSS?: { escape(value: string): string } };
  if (typeof g.CSS === 'undefined') {
    g.CSS = {
      escape: (value: string) => String(value).replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`),
    };
  }
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('design/012 D17 — the canvas host contract (§13 T16)', () => {
  it('resolves the Ctrl+C guard selector from inside the relocated element', () => {
    const host = makeCanvasHost('tb-ctrlc');
    const { element, textarea } = makeXtermElement();
    host.display.appendChild(element);

    // InputHandler.ts:268-269's exact expression.
    expect(textarea.classList.contains('xterm')).toBe(false);   // the sibling branch fails…
    expect(textarea.closest('.terminal-display')).toBe(host.display); // …this one saves it
  });

  it('keeps isEditableNonTerminalTarget false for the relocated helper textarea', () => {
    const host = makeCanvasHost('tb-editable');
    const { element, textarea } = makeXtermElement();
    host.display.appendChild(element);

    // inputTargets.ts:16 checks `.xterm` FIRST, which resolves from inside
    // term.element regardless of the host — so this row of §4.4 needs NOTHING from
    // the host. Asserted so a future "simplification" of that helper is caught.
    expect(isEditableNonTerminalTarget(textarea)).toBe(false);
  });

  it('resolves the rail wrapper from inside the relocated element', () => {
    const host = makeCanvasHost('tb-rail');
    const { element } = makeXtermElement();
    host.display.appendChild(element);

    // endedRegions.ts:560, with WRAPPER_SELECTOR from :100.
    expect(element.closest('.terminal-display-wrapper')).toBe(host.wrapper);
  });

  it('makes the host — not the wrapper — term.element\'s parentElement', () => {
    const host = makeCanvasHost('tb-fit');
    const { element } = makeXtermElement();
    host.display.appendChild(element);

    // Spike 004 Q4 measured that FitAddon.proposeDimensions() reads
    // term.element.parentElement (FitAddon.ts:56,72) — pinning .terminal-display to
    // an independent 400x200 inside an untouched 800x400 wrapper moved its output
    // to {cols:54, rows:13}, matching the DISPLAY and not the wrapper. So RC2's
    // "constant CSS-pixel box" is a constraint on the HOST specifically.
    expect(element.parentElement).toBe(host.display);
    expect(element.parentElement).not.toBe(host.wrapper);
  });

  // §4.4 row 6: the ONE production change. Both the pane node and the canvas host
  // must receive the per-pane background var, including on later scheme changes via
  // applyEffectiveThemes (terminalTheme.ts:53-73).
  it('writes --terminal-display-background onto BOTH the pane and the canvas host', () => {
    const pane = makePane('tb-bg');
    const host = makeCanvasHost('tb-bg');

    setPaneBackgroundVar('tb-bg', '#101010');

    expect(pane.display.style.getPropertyValue('--terminal-display-background')).toBe('#101010');
    expect(host.display.style.getPropertyValue('--terminal-display-background')).toBe('#101010');
  });

  it('does not write onto a different terminal\'s nodes', () => {
    const mine = makePane('tb-mine');
    const theirs = makePane('tb-theirs');

    setPaneBackgroundVar('tb-mine', '#202020');

    expect(mine.display.style.getPropertyValue('--terminal-display-background')).toBe('#202020');
    expect(theirs.display.style.getPropertyValue('--terminal-display-background')).toBe('');
  });

  it('is a no-op without a background, and safe when nothing matches', () => {
    const pane = makePane('tb-noop');
    setPaneBackgroundVar('tb-noop', undefined);
    expect(pane.display.style.getPropertyValue('--terminal-display-background')).toBe('');
    expect(() => setPaneBackgroundVar('tb-absent', '#303030')).not.toThrow();
  });
});

describe('design/012 D19 / §4.4 row 8 — §13 T22b: the pointer gate can inherit', () => {
  /**
   * The CSS-contract half of T22. The hit test itself is not assertable in jsdom —
   * there is no layout engine and no hit testing, so `pointer-events: none` has no
   * observable effect on dispatchEvent (plan ground-truth correction G3); that half
   * is the manual gate §13 already lists.
   *
   * What IS assertable, and what D19 actually depends on, is that NOTHING under
   * `.terminal-display` re-enables pointer events — otherwise a host-level
   * `pointer-events: none` would not reach term.element and the gate would silently
   * do nothing. design 012 §4.4 row 8: "the only two pointer-events declarations
   * are :46 and :55, on the rail layer and the rail, not on the grid".
   */
  it('no rule in TerminalDisplay.css sets pointer-events on the grid', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const css = readSource(path.join(__dirname, '..', 'TerminalDisplay.css'));

    // PLAN CORRECTION (015 Task 14): strip comments FIRST. The plan split the raw
    // stylesheet on `}`, which leaves the comment block preceding a rule glued to
    // its selector — so `rule.split('{')[0]` for `.ended-rail-layer` came back as
    // the whole "Ended-region RAIL (see …)" comment, which both fails the selector
    // regex and (because that comment says "terminal-display and xterm padding")
    // trips the two `not.toContain` assertions. Removing comments makes the split
    // yield the bare selectors the assertions below were written for.
    const withoutComments = css.replace(/\/\*[\s\S]*?\*\//g, '');

    // Split into rules and keep only those that declare pointer-events.
    const rules = withoutComments.split('}').map((r) => r.trim()).filter(Boolean);
    const pointerRules = rules.filter((r) => /pointer-events\s*:/.test(r));

    expect(pointerRules.length).toBe(2);
    for (const rule of pointerRules) {
      const selector = rule.split('{')[0].trim();
      // Both belong to the ended-region rail, which is a SIBLING of the grid.
      expect(selector).toMatch(/^\.ended-rail(-layer)?$/);
      expect(selector).not.toContain('.terminal-display');
      expect(selector).not.toContain('.xterm');
    }
  });
});
