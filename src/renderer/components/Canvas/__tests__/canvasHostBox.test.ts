import fs from 'fs';
import path from 'path';

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
  const css = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
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
    const canvas = path.join(RENDERER, 'components/Canvas/Canvas.css');
    const selectors = rulesIn(canvas).map((r) => r.selector);
    expect(selectors).toContain('.canvas-node.running .canvas-node-head::after');
  });
});
