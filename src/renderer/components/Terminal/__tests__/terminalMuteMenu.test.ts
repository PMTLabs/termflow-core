/**
 * Mute/Unmute in the terminal right-click menu (plan/025 §2.7) — the wiring in
 * `TerminalDisplay`, and that the same menu is what the Canvas overlay reaches.
 *
 * A TRIPWIRE over source, for the reason `terminalDisplayRelocationWiring.test.ts`
 * already records: `TerminalDisplay` cannot be mounted under the root Jest config
 * (two untransformed CSS imports, `@tauri-apps/api/event`, the store, and a real
 * `Terminal.open()` needing a 2D context jsdom lacks). The hook's own behaviour —
 * pane flag vs. tab flag vs. their OR, and that `toggle` only ever flips the
 * pane's own flag — is covered for real in `usePaneMuteState.test.tsx`; what this
 * file guards is that the component still calls it and still wires the item up.
 *
 * Modelled on copyLinkWiring.test.ts, the most recent precedent for a menu item
 * that has to work identically on both surfaces.
 */
import * as path from 'path';
import { readSource } from '../../../utils/readSource';

const code = (file: string): string =>
  readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

const DISPLAY = code(path.join(__dirname, '..', 'TerminalDisplay.tsx'));
const NODE_TERMINAL = code(path.join(__dirname, '..', '..', 'Canvas', 'NodeTerminal.tsx'));
const PANE_CONTEXT_MENU = code(path.join(__dirname, '..', '..', 'Panes', 'PaneContextMenu.tsx'));

describe('the item is driven by the shared hook, not a local selector pair', () => {
  it('calls usePaneMuteState with the pane and terminal ids', () => {
    expect(DISPLAY).toMatch(
      /const \{ paneMuted, tabMuted, effectiveMuted, toggle: toggleMute \} = usePaneMuteState\(paneId, terminalId\);/,
    );
  });

  // The class fix this task exists for: a third copy of the pane/tab selector
  // pair here is exactly how the flag would get dropped on the next re-home.
  it('does not re-derive notifyMuted from the pane tree itself', () => {
    expect(DISPLAY).not.toMatch(/notifyMuted/);
    expect(DISPLAY).not.toMatch(/findLeaf/);
  });
});

describe('the item appears in getContextMenuItems()', () => {
  const item = (): string => {
    const m = /\.\.\.\(paneId \? \[\s*\{([\s\S]*?)\},?\s*\] : \[\]\)/.exec(DISPLAY);
    expect(m).not.toBeNull();
    return m![1];
  };

  // Present-or-absent, gated only on paneId -- which is set on both surfaces --
  // never on relocationHost, unlike the pane-tree items above it in the same list.
  it('is gated on paneId alone, not on relocationHost', () => {
    expect(() => item()).not.toThrow();
    expect(item()).not.toMatch(/relocationHost/);
  });

  // Reused verbatim from PaneContextMenu so the two menus cannot drift apart.
  it('labels the toggle the same way PaneContextMenu does', () => {
    expect(item()).toMatch(/label:\s*paneMuted \? 'Unmute Pane Notifications' : 'Mute Pane Notifications'/);
    expect(PANE_CONTEXT_MENU).toMatch(/paneMuted \? 'Unmute Pane Notifications' : 'Mute Pane Notifications'/);
  });

  // The icon reflects the EFFECTIVE (tab-or-pane) state, matching the pane header
  // bell -- not just the pane's own flag, which would show unmuted while the tab
  // mute is silently suppressing every notification anyway.
  it('reflects the effective (tab-or-pane) state in its icon', () => {
    expect(item()).toMatch(/icon:\s*effectiveMuted \?/);
  });

  // The tab-level-override explanation, exactly as PaneContextMenu's does.
  it('explains a tab-level override in its title', () => {
    expect(item()).toMatch(/title:\s*tabMuted \? 'This pane is also muted by its tab' : undefined/);
  });

  it('toggles through the hook, not a bespoke dispatch', () => {
    expect(item()).toMatch(/click:\s*\(\) => toggleMute\(\)/);
    expect(item()).not.toMatch(/dispatch\(/);
  });

  // Placement (§2.7 / §0.4): after Selection mode, before the Clear separator --
  // outside the 400-char Copy-to-Paste window terminalDisplayRelocationWiring.test.ts
  // measures, so this item cannot land between those two.
  it('sits after Selection mode and before the Clear separator', () => {
    const selectionAt = DISPLAY.indexOf('setSelectionMode(!selectionMode)');
    const muteAt = DISPLAY.indexOf("'Mute Pane Notifications'");
    const clearAt = DISPLAY.indexOf("label: 'Clear',");
    expect(selectionAt).toBeGreaterThan(-1);
    expect(muteAt).toBeGreaterThan(-1);
    expect(clearAt).toBeGreaterThan(-1);
    expect(selectionAt).toBeLessThan(muteAt);
    expect(muteAt).toBeLessThan(clearAt);
  });
});

/**
 * THE reason one item, gated only on paneId, is enough for both surfaces.
 *
 * `NodeTerminal`'s host-div right-click already routes into this same callback
 * (proven by `terminalDisplayRelocationWiring.test.ts`), with the same `paneId` --
 * the overlay borrows the pane's own engine and chrome, it does not render a
 * second `TerminalDisplay`. So the Mute item cannot exist on one surface without
 * the other; there is only one item list.
 */
describe('the canvas overlay reaches the same menu', () => {
  it('routes the node host right-click into the published opener', () => {
    expect(NODE_TERMINAL).toMatch(/chrome\.openContextMenu\(e\.clientX,\s*e\.clientY\)/);
  });

  it('and TerminalDisplay publishes that opener from the same component that builds the item list', () => {
    expect(DISPLAY).toMatch(/openContextMenu:\s*openContextMenuAt/);
    expect(DISPLAY).toContain('getContextMenuItems');
  });
});
