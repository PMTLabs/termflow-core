/**
 * Plan 070 T3 — pure SSH node geometry: the frozen envelope, the terminal remainder on a browser
 * toggle, CONTAIN scaling with bottom alignment, and the raster-zoom products.
 *
 * Pure maths. The CSS that consumes these values is checked in `sshCanvasLayout.test.tsx` and,
 * for real engines, by plan 070 T8; a correct helper with an ignoring stylesheet would pass here.
 */
import path from 'path';
import {
  SSH_CSS_BROWSER_MAX_FRACTION, SSH_CSS_BROWSER_W, SSH_CSS_CHROME_H, SSH_CSS_LAUNCH_STRIP_H, SSH_CSS_RAIL_W, SSH_CSS_STATUS_H,
  sshBrowserAllocation, sshContain, sshFallbackSurfaceBox, sshSurfaceBoxFrom, sshTerminalBox,
} from '../canvasSshGeometry';
import {
  DEFAULT_METRICS, HEAD_H, MAX_WORLD_R, NODE_W, Z_MIN, overlayGeometry, surfaceShift,
} from '../canvasGeometry';
import { rasterStyle, worldStyle } from '../viewportStyles';
import { readSource } from '../../../utils/readSource';
import { SSH_PANE_CHROME_H } from '../../Ssh/SshPaneShell';

const close = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(1e-9);

// Unequal on purpose, fractional, with a non-zero column gap.
const TERMINAL = { w: 1001.53125, h: 603.40625 };
const BOX = sshSurfaceBoxFrom({ terminal: TERMINAL, browserW: 259.75, collapsed: false, statusH: 25, columnGap: 6.5 });

/** The four corners of the scaled envelope inside the node body, in node px. */
function corners(env: { w: number; h: number }, fit: { scale: number; shift: number }) {
  return [[0, 0], [env.w, 0], [0, env.h], [env.w, env.h]].map(([x, y]) => ({ x: x * fit.scale, y: y * fit.scale + fit.shift }));
}

describe('SSH envelope and terminal remainder', () => {
  it('envelope = terminal + browser + gap by strip + chrome + terminal + status, with distinct unequal parts', () => {
    expect(BOX.envelope.w).toBe(TERMINAL.w + 259.75 + 6.5);
    // 066's launch strip row (36) is reserved in the slot and the shell's P068-7 chrome row (36)
    // sits in flow above the body; the terminal keeps its measured box.
    expect(BOX.envelope.h).toBe(TERMINAL.h + 36 + 36 + 25);
    expect(BOX.initialTerminal).toEqual(TERMINAL);
    expect(BOX.expandedBrowserW).toBe(259.75);
    expect(BOX.collapsedBrowserW).toBe(SSH_CSS_RAIL_W); // 30 < 40% of a 1267 px body
    expect(sshTerminalBox(BOX, false)).toEqual(TERMINAL);
  });

  it('a toggle moves exactly the browser delta into the terminal slot, height untouched, and back', () => {
    const collapsed = sshTerminalBox(BOX, true);
    expect(collapsed.w).toBe(TERMINAL.w + (259.75 - SSH_CSS_RAIL_W));
    expect(collapsed.h).toBe(TERMINAL.h);
    expect(sshTerminalBox(BOX, false)).toEqual(TERMINAL);
    // The envelope never changes with the toggle.
    expect(sshBrowserAllocation(BOX, true) + collapsed.w + BOX.columnGap).toBe(BOX.envelope.w);
    expect(sshBrowserAllocation(BOX, false) + TERMINAL.w + BOX.columnGap).toBe(BOX.envelope.w);
  });

  it('the host content box FitAddon reads is the same on entry, padding and border included', () => {
    // `.terminal-display { padding:4px; box-sizing:border-box }` on both sides; the source capture
    // is a BORDER box, FitAddon reads the CONTENT box. Same class, same padding -> same input.
    const padding = 4;
    const source = { w: TERMINAL.w - 2 * padding, h: TERMINAL.h - 2 * padding };
    const slot = sshTerminalBox(BOX, false);
    expect({ w: slot.w - 2 * padding, h: slot.h - 2 * padding }).toEqual(source);
  });

  it('a collapsed capture derives the expanded column from the same CSS cap', () => {
    const narrow = sshSurfaceBoxFrom({ terminal: { w: 300, h: 200 }, browserW: 30, collapsed: true, statusH: 25, columnGap: 0 });
    expect(narrow.envelope.w).toBe(330);
    expect(narrow.expandedBrowserW).toBe(SSH_CSS_BROWSER_MAX_FRACTION * 330); // the 40% cap binds
    expect(sshTerminalBox(narrow, false).w).toBe(330 - 132);
    expect(sshTerminalBox(narrow, true).w).toBe(300);
  });

  it('the never-rendered fallback is self-consistent under the cap', () => {
    const wide = sshFallbackSurfaceBox({ w: 1600, h: 680 }, false);
    expect(wide.source).toBe('fallback');
    expect(wide.envelope).toEqual({ w: 1600 + SSH_CSS_BROWSER_W, h: 680 + SSH_CSS_LAUNCH_STRIP_H + SSH_CSS_CHROME_H + SSH_CSS_STATUS_H });
    const custom = sshFallbackSurfaceBox({ w: 1600, h: 680 }, false, 420);
    expect(custom.expandedBrowserW).toBe(420);
    expect(custom.envelope.w).toBe(2020);
    expect(sshBrowserAllocation(custom, false, 480)).toBe(480);
    const tight = sshFallbackSurfaceBox({ w: 300, h: 200 }, false);
    // a = min(260, 0.4 * (300 + a)) -> a = 200, and 200 is exactly 40% of the 500 px envelope.
    close(tight.expandedBrowserW, 200);
    close(tight.expandedBrowserW, SSH_CSS_BROWSER_MAX_FRACTION * tight.envelope.w);
    expect(sshTerminalBox(tight, false).w).toBeCloseTo(300, 9);
  });

  it('the allocations are the CSS values, not copies that can drift', () => {
    const css = readSource(path.resolve(__dirname, '../../Ssh/SshPaneShell.css'));
    const rule = (selector: string) => {
      const at = css.indexOf(`${selector} {`);
      expect(at).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf('}', at));
    };
    const browser = rule('.ssh-browser');
    expect(browser).toContain(`flex:0 1 ${SSH_CSS_BROWSER_W}px`);
    expect(browser).toContain(`width:${SSH_CSS_BROWSER_W}px`);
    expect(browser).toContain(`max-width:${SSH_CSS_BROWSER_MAX_FRACTION * 100}%`);
    expect(browser).toContain('box-sizing:border-box');
    const rail = rule('.ssh-browser.collapsed');
    expect(rail).toContain(`width:${SSH_CSS_RAIL_W}px`);
    expect(rail).toContain(`max-width:min(${SSH_CSS_RAIL_W}px, ${SSH_CSS_BROWSER_MAX_FRACTION * 100}%)`);
    const status = rule('.ssh-status');
    expect(status).toContain(`height:${SSH_CSS_STATUS_H}px`);
    expect(status).toContain('box-sizing:border-box');
    expect(status).not.toContain('min-height');
    // 066's launch strip has one fixed height; Canvas reserves exactly that row (Canvas.css).
    const strip = readSource(path.resolve(__dirname, '../../Ssh/SshLaunchNotice.css')).replace(/\s+/g, '');
    expect(strip).toMatch(new RegExp(`\\.ssh-launch-strip\\{[^}]*height:${SSH_CSS_LAUNCH_STRIP_H}px`));
    // P068-7: the shell's chrome row is always rendered, in flow, at one fixed height, so
    // connect/disconnect and notices cannot change the row; the envelope reserves exactly it.
    expect(SSH_CSS_CHROME_H).toBe(SSH_PANE_CHROME_H);
    const chrome = rule('.ssh-pane-chrome');
    expect(chrome).toContain(`height:${SSH_CSS_CHROME_H}px`);
    expect(chrome).toContain('box-sizing:border-box');
    expect(chrome).toContain('flex:none');
    expect(chrome).not.toContain('position:absolute');
    expect(chrome).not.toContain('min-height');
    expect(chrome).not.toContain('max-height');
  });
});

describe('contain scaling', () => {
  it('sshCanvasGeometry_containsToolbarTerminalAndStatus_forPortraitAndWideNodes', () => {
    const env = BOX.envelope;
    const nodes = {
      portrait: { w: 420, h: 900 },
      wide: { w: 1600, h: 300 },
      default: { w: NODE_W, h: 420 },
    };
    for (const [name, node] of Object.entries(nodes)) {
      const bodyH = node.h - HEAD_H;
      const fit = sshContain(env, node.w, bodyH);
      for (const c of corners(env, fit)) {
        expect([name, c.x >= -1e-9 && c.x <= node.w + 1e-9, c.y >= -1e-9 && c.y <= bodyH + 1e-9]).toEqual([name, true, true]);
      }
      // Bottom-aligned: the status row's bottom edge is the body's bottom edge.
      close(fit.shift + env.h * fit.scale, bodyH);
      expect(fit.shift).toBeGreaterThanOrEqual(0);
      // The browser toolbar (top-left of the envelope) and status row (bottom) are inside.
      const toolbarTop = fit.shift;
      const statusTop = fit.shift + (env.h - BOX.statusH) * fit.scale;
      expect(toolbarTop).toBeGreaterThanOrEqual(0);
      expect(statusTop).toBeLessThan(bodyH);
    }

    const portrait = sshContain(env, nodes.portrait.w, nodes.portrait.h - HEAD_H);
    close(portrait.scale, nodes.portrait.w / env.w);          // width-limited
    expect(portrait.shift).toBeGreaterThan(0);                 // letterbox above
    const wide = sshContain(env, nodes.wide.w, nodes.wide.h - HEAD_H);
    close(wide.scale, (nodes.wide.h - HEAD_H) / env.h);        // height-limited
    close(wide.shift, 0);
    expect(nodes.wide.w - env.w * wide.scale).toBeGreaterThan(0); // letterbox beside

    // Counterexample: the local width-only rule lifts a wide node's envelope ABOVE the body
    // (negative shift), clipping the browser toolbar — the reason SSH nodes contain instead.
    expect(surfaceShift(env, nodes.wide.w, nodes.wide.h - HEAD_H)).toBeLessThan(0);
  });

  it('the overlay built from the envelope renders it at its own screen scale with no shift', () => {
    const env = BOX.envelope;
    for (const z of [0.4, 0.7, 1.3]) {
      const vp = { x: -120, y: 80, z };
      const g = overlayGeometry(vp, 1920, 1080, { hostW: env.w, hostH: env.h, surfaceScale: NODE_W / env.w });
      const fit = sshContain(env, g.rect.w, g.rect.h - HEAD_H);
      close(fit.shift, 0);
      close(fit.scale, g.rect.w / env.w);
    }
  });
});

describe('raster zoom products', () => {
  it('sshCanvasRaster_productPreservesScreenAndLayoutGeometry', () => {
    // Math part. The emitted vars come from the production writers; whether the stylesheet
    // applies them to the outer SSH surface is the layout test's and T8's job.
    const env = BOX.envelope;
    const fit = sshContain(env, NODE_W, 420 - HEAD_H);
    const zooms = [Z_MIN, 0.25, 0.5, 1, 1.75, DEFAULT_METRICS.zMax, MAX_WORLD_R];
    const rasterSeen = new Set<number>();
    for (const z of zooms) {
      for (const dpr of [1, 1.25, 2]) {
        const vp = { x: 0, y: 0, z };
        const raster = rasterStyle(vp, dpr) as Record<string, string | number>;
        const R = Number(raster['--canvas-raster-r']);
        const inv = Number(raster['--canvas-raster-inv']);
        expect(raster.zoom).toBe(R);
        rasterSeen.add(R);
        const world = /scale\(([^)]+)\)/.exec(String(worldStyle(vp, dpr).transform))![1];
        const worldScale = Number(world);
        // Layout zoom at the surface: R * 1/R = 1, so FitAddon reads unscaled CSS px.
        close(R * inv, 1);
        // Screen geometry: scale(s*R) under the world's scale(z/R) is s*z; the shift likewise.
        close(fit.scale * R * worldScale, fit.scale * z);
        close(fit.shift * R * worldScale, fit.shift * z);
        // The envelope never exceeds the node on screen at any zoom.
        expect(env.w * fit.scale * z).toBeLessThanOrEqual(NODE_W * z + 1e-9);
      }
    }
    // Positive control: the sweep crossed real raster boundaries, not R = 1 alone.
    expect(rasterSeen.size).toBeGreaterThan(1);
  });
});
