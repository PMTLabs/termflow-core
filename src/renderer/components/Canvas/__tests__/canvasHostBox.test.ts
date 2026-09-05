import fs from 'fs';
import path from 'path';
import { NODE_W, NODE_H, HEAD_H } from '../canvasGeometry';
import { readSource } from '../../../utils/readSource';

/**
 * Task 9 mounts the live terminal host inside `.canvas-node-body`. Under a
 * `display: none` ancestor, `FitAddon.proposeDimensions()` does NOT error — it
 * resolves a percentage to the literal string `"100%"`, `parseInt`s that to `100`,
 * and returns a plausible-looking, wrong `{cols: 12, rows: 6}` (spike `004` Q4,
 * `012` §6.5 RC3 / H10). Three `fit()` call sites are unguarded against it, so the
 * PTY silently resizes to a bogus grid and the app looks merely "a bit off".
 *
 * The rule that prevents this — hide with `visibility`, never `display` — is a CSS
 * fact, and CSS cannot assert anything about itself. So derive the check from the
 * real stylesheets: find every rule that declares `display: none`, and fail if its
 * SUBJECT (the element the selector actually matches) is a canvas node or any part
 * of one. Deleting the rule this protects turns the test red; so does adding a new
 * `display: none` anywhere in the renderer that lands on a node.
 *
 * Ports are deliberately exempt: `.canvas-port` is a SIBLING of the body, never an
 * ancestor of a terminal, so hiding one cannot affect any layout box that matters.
 */

const RENDERER = path.resolve(__dirname, '../../..');

function cssFilesUnder(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      const p = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && entry.name.endsWith('.css')) out.push(p);
    }
  };
  walk(path.join(RENDERER, dir));
  return out;
}

/** The compound the selector actually matches — the last one, after any combinator. */
function subjectOf(selector: string): string {
  return selector.trim().split(/[\s>+~]+/).filter(Boolean).pop() ?? '';
}

interface Rule { file: string; selector: string; body: string }

/** Every top-level `selector { ... }` rule in a file. At-rule blocks (`@media`) are
 *  entered rather than skipped, so a `display: none` nested inside one is still seen. */
function rulesIn(file: string): Rule[] {
  const css = readSource(file).replace(/\/\*[\s\S]*?\*\//g, '');
  const out: Rule[] = [];
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selector = m[1].trim();
    if (selector.startsWith('@')) continue; // the at-rule's own header, not a selector
    for (const one of selector.split(',')) out.push({ file, selector: one.trim(), body: m[2] });
  }
  return out;
}

const CANVAS_NODE_SUBJECT = /^\.canvas-node(-[a-z]+)?([.:[]|$)/;

describe('canvas node layout box', () => {
  const files = cssFilesUnder('components');

  it('scanned a real stylesheet set', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((f) => f.endsWith('Canvas.css'))).toBe(true);
  });

  it('never hides a canvas node or its body with display:none', () => {
    const offenders: string[] = [];
    for (const file of files) {
      for (const rule of rulesIn(file)) {
        if (!/display:\s*none/.test(rule.body)) continue;
        const subject = subjectOf(rule.selector);
        // A pseudo-element is generated content, never an ancestor of anything, so
        // hiding one cannot affect a terminal's layout box.
        if (subject.includes('::')) continue;
        if (CANVAS_NODE_SUBJECT.test(subject)) {
          offenders.push(`${path.basename(file)}: ${rule.selector}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // The rule above only bites if the pattern it uses can actually match a node
  // selector. Without this, renaming `.canvas-node` would leave a test that scans
  // every stylesheet, matches nothing, and passes forever.
  it('uses a subject pattern that really matches node selectors', () => {
    expect(CANVAS_NODE_SUBJECT.test(subjectOf('.canvas-node'))).toBe(true);
    expect(CANVAS_NODE_SUBJECT.test(subjectOf('.canvas-node-body'))).toBe(true);
    expect(CANVAS_NODE_SUBJECT.test(subjectOf('.canvas-node[data-lod="chip"]'))).toBe(true);
    expect(CANVAS_NODE_SUBJECT.test(subjectOf('.canvas-node.selected'))).toBe(true);
    expect(CANVAS_NODE_SUBJECT.test(subjectOf('.canvas-node[data-lod="chip"] .canvas-node-body'))).toBe(true);
    // ...and does not fire on the exempt cases, or the test would be unsatisfiable.
    expect(CANVAS_NODE_SUBJECT.test(subjectOf('.canvas-node[data-lod="chip"] .canvas-port'))).toBe(false);
    expect(CANVAS_NODE_SUBJECT.test(subjectOf('.canvas-gframe'))).toBe(false);
  });

  it('still parses rules nested inside an @media block', () => {
    // The reduced-motion block (`@media (prefers-reduced-motion: reduce)`), which holds a rule
    // for every busy cue — the sweep's override, deleted by `plan/020` §3 Req 5 and restored by
    // `plan/023`, and the dot's, which was the stand-in example while the sweep was gone.
    const canvas = path.join(RENDERER, 'components/Canvas/Canvas.css');
    const selectors = rulesIn(canvas).map((r) => r.selector);
    expect(selectors).toContain('.canvas-node-dot');
  });
});

/**
 * RC2 — the host keeps a CONSTANT CSS-pixel box for the whole canvas session, so pan,
 * zoom and tier changes produce no `fit()`, no `term.resize()` and no SIGWINCH.
 *
 * The trap this guards is specific and easy to reintroduce: `.canvas-node-body` SHRINKS
 * to nothing at the chip tier, so sizing the host as a percentage of it — the obvious
 * thing to write, and what the plan's draft said — resizes a live terminal on a zoom-out.
 */
const CANVAS_CSS = path.join(RENDERER, 'components/Canvas/Canvas.css');

function declarationsOf(selector: string): string {
  const rule = rulesIn(CANVAS_CSS).find((r) => r.selector === selector);
  if (!rule) throw new Error(`no rule for ${selector} — the test's subject moved or was renamed`);
  return rule.body;
}

describe('terminal host box is constant', () => {
  it('sizes the host from the shared geometry variables, never a percentage', () => {
    const body = declarationsOf('.canvas-surface');
    expect(body).toMatch(/position:\s*absolute/);
    const width = body.match(/[^-]width:\s*([^;]+)/)![1];
    const height = body.match(/[^-]height:\s*([^;]+)/)![1];
    for (const value of [width, height]) {
      expect(value).toContain('var(--canvas-');
      // A percentage resolves against `.canvas-node-body`, whose height is zero at the
      // chip tier. A bare px literal is a second copy of NODE_W/NODE_H.
      expect(value).not.toMatch(/%/);
      expect(value).not.toMatch(/\b\d+px/);
    }
  });

  // The counter-zoom, asserted on the RULE rather than on a rendered pixel, because jsdom
  // paints nothing and this is the one place the pair can be checked at all.
  //
  // Both halves or neither. `zoom` alone shrinks the terminal to 1/R of where it belongs;
  // the transform multiplier alone doubles it. The shift is in the same bracket for a reason
  // that is easy to miss: `zoom` scales an element's own transform lengths too, so a translate
  // left un-multiplied moves the surface by a fraction R of what it should.
  it('undoes the world raster for its own subtree, and hands the factor back', () => {
    const body = declarationsOf('.canvas-surface');

    expect(body).toMatch(/zoom:\s*var\(--canvas-raster-inv,\s*1\)/);

    // Balanced-paren extraction, not a regex: the arguments are nested `calc(var(…))`, and a
    // naive `\(([^)]*)\)` stops at the first inner `)` — which silently returns a PREFIX that
    // happens to contain the variable you were checking for. That is a test that passes on a
    // broken rule, so the parser earns its lines here.
    const argOf = (fn: string): string => {
      const at = body.indexOf(`${fn}(`);
      expect(at).toBeGreaterThanOrEqual(0);
      let depth = 0;
      for (let i = at + fn.length; i < body.length; i++) {
        if (body[i] === '(') depth++;
        else if (body[i] === ')' && --depth === 0) return body.slice(at + fn.length + 1, i);
      }
      throw new Error(`unbalanced ${fn}() in .canvas-surface`);
    };

    // Both halves or neither: `zoom` alone leaves the terminal at 1/R of where it belongs,
    // the multiplier alone puts it at R times.
    const scale = argOf('scale');
    expect(scale).toContain('--node-surface-scale');
    expect(scale).toContain('--canvas-raster-r');

    const translate = argOf('translateY');
    expect(translate).toContain('--node-surface-shift');
    expect(translate).toContain('--canvas-raster-r');
  });

  // Cross-file: a variable the stylesheet consumes but nothing provides resolves to an
  // invalid value, the host collapses to a zero box, `hasLayoutBox` goes false — and the
  // terminal silently never fits. Check the DESTINATION of the handoff, not just the
  // source, because an absent declaration is invisible from the CSS side.
  //
  // There are THREE legitimate providers, not one. Most geometry variables are computed per
  // frame and published from `CanvasMode`; the raster pair is published by `viewportStyles`,
  // which owns the `.canvas-raster` style; a purely static one (a palette entry, say) is
  // declared on `.canvas-mode` in the stylesheet itself, where it needs no round trip through
  // React. What must never happen is a variable with NONE — which is what this asserts.
  //
  // `viewportStyles` was added to this list when `--canvas-raster-r` / `--canvas-raster-inv`
  // arrived and this test failed, which is the test doing its job: the variables were real and
  // supplied, just not from the one file the scan knew about. Widening the SOURCES is right;
  // widening the PATTERN would not have been.
  const PROVIDERS = [
    'components/Canvas/CanvasMode.tsx',
    'components/Canvas/viewportStyles.ts',
  ];

  it('has every canvas variable it consumes supplied by a known provider or the stylesheet', () => {
    const css = readSource(CANVAS_CSS);
    const consumed = new Set(
      [...css.matchAll(/var\((--canvas-[a-z-]+)/g)].map((m) => m[1]),
    );
    expect(consumed.size).toBeGreaterThan(0);

    const provided = new Set<string>([
      // A DECLARATION, not a `var()` reference: anchored to the start of a declaration so
      // `var(--canvas-x, …)` — which is a use — cannot satisfy itself.
      ...[...css.matchAll(/(?:^|[{;])\s*(--canvas-[a-z-]+)\s*:/gm)].map((m) => m[1]),
    ]);
    for (const file of PROVIDERS) {
      const src = readSource(path.join(RENDERER, file));
      for (const m of src.matchAll(/'(--canvas-[a-z-]+)'/g)) provided.add(m[1]);
    }
    expect([...consumed].filter((v) => !provided.has(v))).toEqual([]);
  });

  /** The self-satisfaction the regex above is written to avoid, made explicit: a variable that
   *  is only ever READ must still fail this check. Without this, widening the sources is one
   *  loose pattern away from making the whole assertion vacuous. */
  it('does not accept a var() reference as its own declaration', () => {
    const css = '.x { color: var(--canvas-invented, red); }';
    const declared = [...css.matchAll(/(?:^|[{;])\s*(--canvas-[a-z-]+)\s*:/gm)].map((m) => m[1]);
    expect(declared).toEqual([]);
  });

  // The `var(..., 29px)` style fallbacks are dead code while CanvasMode supplies the
  // variables — but a stale one is a wrong number sitting in the file waiting to be read
  // as authoritative. Derive them from the TypeScript constants instead of trusting them.
  it('keeps its variable fallbacks equal to the TypeScript constants', () => {
    const css = readSource(CANVAS_CSS);
    const fallbacks: Record<string, number> = {
      '--canvas-node-w': NODE_W,
      '--canvas-node-h': NODE_H,
      '--canvas-head-h': HEAD_H,
    };
    // ONE static regex over every fallback in the file, then looked up by name. Building a
    // regex per name reads more naturally and was how this started, but `--canvas-node-w`
    // is full of regex metacharacters and the escaping went wrong in a way that still
    // *ran*: the pattern matched nothing, every loop body was skipped, and the assertion
    // passed while checking nothing at all.
    const found = [...css.matchAll(/var\((--canvas-[a-z-]+),\s*(\d+)px\)/g)];
    expect(found.length).toBeGreaterThan(0);

    for (const [name, expected] of Object.entries(fallbacks)) {
      // Guards the guard: an entry whose constant went away would compare against
      // `undefined` and quietly assert nothing. This suite used to carry two such entries
      // — `--canvas-host-w` and `--canvas-host-h` — and passed for exactly that reason.
      expect(typeof expected).toBe('number');
      for (const m of found.filter((x) => x[1] === name)) {
        expect({ name, px: Number(m[2]) }).toEqual({ name, px: expected });
      }
    }
  });

  /**
   * The HOST variables must carry no literal fallback at all.
   *
   * They are the one part of this geometry that is per-SESSION rather than per-app: the host
   * box is sized for the display the canvas opened on (see `canvasMetrics`), because the same
   * box is also what the overlay renders at 1:1 and one number cannot serve a 1366-wide laptop
   * and a 4K panel. A `var(--canvas-host-w, 1600px)` fallback would freeze one display's answer
   * into the stylesheet — and it would only ever be *used* when the provider was missing, which
   * is the case where being plausibly wrong is worse than failing.
   */
  it('gives the per-session host variables no literal fallback', () => {
    const css = readSource(CANVAS_CSS);
    for (const name of ['--canvas-host-w', '--canvas-host-h', '--canvas-surface-scale']) {
      expect(css).toContain(`var(${name})`);
      // Substring, not a built regex: the name is full of metacharacters, and a mis-escaped
      // pattern here would match nothing and pass — the failure mode this suite just had.
      expect(css).not.toContain(`var(${name},`);
    }
  });
});
