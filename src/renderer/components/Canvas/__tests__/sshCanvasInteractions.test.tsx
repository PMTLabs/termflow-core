/**
 * @jest-environment jsdom
 *
 * Plan 070 T4 — Canvas interaction parity for the SSH presentation: wheel passthrough, node
 * gesture isolation (including React-portal bubbling), keyboard ownership, clicked-item actions
 * with the registered insertion IPC, and inactive-surface dialog focus restore (068 F5).
 *
 * JSDOM IS NOT A LAYOUT ENGINE. Scroll extents are fixtures; a wheel here proves which listener
 * takes the event and whether it is defaultPrevented, never that the browser column actually
 * scrolled. The real `scrollTop` change is plan 070 T8's real-engine oracle.
 *
 * The 066 PaneNode `ssh` tag is not merged on this branch: trees carry `ssh` structurally, which
 * is what the `readSshPaneTag` seam reads. `store` is imported (through the harness) because the
 * production file controller fences on the module store, as in `sshCanvasLayout.test.tsx`.
 */
const fakeCache = new Map<string, any>();
jest.mock('@termflow/terminal-core', () => ({ DEFAULT_THEME: {}, terminalCache: fakeCache, isFindShortcut: () => false }));
jest.mock('../../TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../../../services/TerminalService', () => ({
  terminalService: { writeToTerminal: jest.fn(), getProcessIdForTerminal: () => undefined },
}));
jest.mock('../../Terminal/useDetectedAgent', () => ({ useDetectedAgent: () => ({ agent: null, icon: null }) }));
jest.mock('../../../utils/clipboard', () => ({ writeClipboardText: jest.fn(async () => {}) }));
jest.mock('../../Ssh/ssh066Contract', () => ({
  ...jest.requireActual('../../Ssh/ssh066Contract'), readSshLaunchState: jest.fn(), readReconnectCoordinator: jest.fn(),
}));

/* eslint-disable import/first */
import path from 'path';
import React, { act } from 'react';
import { setViewport } from '../../../store/slices/canvasSlice';
import { setCanvasWheelMode } from '../../../store/slices/settingsSlice';
import { terminalService } from '../../../services/TerminalService';
import { writeClipboardText } from '../../../utils/clipboard';
import { readSource } from '../../../utils/readSource';
import { canvasKeyAction, sshOwnsKeyboard, type CanvasKey } from '../canvasGestures';
import {
  COMBOS, SshScene, canvasNode, clickAsync, entry, flush, installBridge, makeBridge, makeScrollable,
  menuItem, mouse, nodeSpies, observe, openRowMenu, paneShell, rowButton, rowOf, seedTerminals,
  setLaunch, setupHarness, store, type NodeSpies,
} from '../../../__testFixtures__/sshCanvasInteractionHarness';

const A = 'tm-a';
const B = 'tm-b';
const h = setupHarness();

const listingsAB = {
  [A]: { '/srv/a': [entry('/srv/a/sel.txt'), entry('/srv/a/click.txt'), entry('/srv/a/sub', 'directory')] },
  [B]: { '/srv/b': [entry('/srv/b/sel.txt'), entry('/srv/b/click.txt')] },
};

/** Two live SSH terminals on DIFFERENT generations (A=1, B=2), both shown on Canvas. */
async function liveScene(spies: NodeSpies, canvas = true, ids = [A, B]) {
  seedTerminals(Object.fromEntries(ids.map(id => [id, { browserPath: id === A ? '/srv/a' : '/srv/b' }])));
  const bridge = makeBridge(listingsAB);
  installBridge(bridge);
  setLaunch({ [A]: 1, [B]: 2 });
  if (ids.includes(A)) observe({ terminalId: A, state: 'connected', generation: 1, revision: 1 });
  if (ids.includes(B)) observe({ terminalId: B, state: 'connected', generation: 2, revision: 1 });
  await h.render(<SshScene ids={ids} canvas={canvas} spies={spies} />);
  return bridge;
}

const noNodeAction = (spies: NodeSpies) => {
  expect(spies.select).not.toHaveBeenCalled();
  expect(spies.drag).not.toHaveBeenCalled();
  expect(spies.enlarge).not.toHaveBeenCalled();
  expect(spies.nodeMenu).not.toHaveBeenCalled();
  expect(spies.dismissOverlay).not.toHaveBeenCalled();
  expect(spies.background).not.toHaveBeenCalled();
  expect(spies.backgroundMenu).not.toHaveBeenCalled();
};

const resetSpies = (spies: NodeSpies) => Object.values(spies).forEach(spy => spy.mockClear());

beforeEach(() => {
  jest.mocked(writeClipboardText).mockClear();
  jest.mocked(terminalService.writeToTerminal).mockClear();
  act(() => { store.dispatch(setViewport({ x: 0, y: 0, z: 1 })); });
});

describe('wheel', () => {
  it('sshCanvas_browserWheelReachesScroller_withoutViewportChange', async () => {
    const spies = nodeSpies();
    await liveScene(spies, true, [A]);
    const node = canvasNode(A);
    const scroller = node.querySelector<HTMLElement>('.ssh-browser')!;
    // The one Canvas-recognised marker (canvasGestures.CANVAS_PASSTHROUGH_ATTR).
    expect(scroller.getAttribute('data-canvas-passthrough')).toBe('scroll');
    makeScrollable(scroller, { scrollHeight: 900, clientHeight: 300, scrollTop: 100 });
    const inside = rowButton(node, '/srv/a/sel.txt');
    const outside = node.querySelector<HTMLElement>('.terminal-display-wrapper')!;
    const vp = () => store.getState().canvas.viewport;
    const wheel = (target: Element, init: WheelEventInit) => {
      const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 30, clientY: 30, ...init });
      act(() => { target.dispatchEvent(event); });
      return event;
    };

    for (const mode of ['zoom', 'scroll'] as const) {
      act(() => {
        store.dispatch(setCanvasWheelMode(mode));
        store.dispatch(setViewport({ x: 0, y: 0, z: 1 }));
      });

      // Positive control first: the same plain wheel OUTSIDE the region is the canvas's.
      const control = wheel(outside, { deltaY: 120 });
      expect(control.defaultPrevented).toBe(true);
      if (mode === 'zoom') expect(vp().z).not.toBe(1);
      else expect(vp().y).not.toBe(0);

      // Inside, with room in both directions: untouched, so it reaches the scroller.
      const before = vp();
      for (const deltaY of [120, -120]) {
        const event = wheel(inside, { deltaY });
        expect(event.defaultPrevented).toBe(false);
        expect(vp()).toEqual(before);
      }

      // At the bottom the region has nothing left to do with a downward wheel: the canvas takes it
      // again, so a region never traps zoom/pan. Upward still scrolls.
      scroller.scrollTop = 600;
      const atEnd = wheel(inside, { deltaY: 120 });
      expect(atEnd.defaultPrevented).toBe(true);
      expect(vp()).not.toEqual(before);
      const afterEnd = vp();
      expect(wheel(inside, { deltaY: -120 }).defaultPrevented).toBe(false);
      expect(vp()).toEqual(afterEnd);
      scroller.scrollTop = 100;
    }

    // The chord is not a scroll: in 'scroll' mode Ctrl+wheel over the browser still zooms the canvas.
    const z = vp().z;
    expect(wheel(inside, { deltaY: 120, ctrlKey: true }).defaultPrevented).toBe(true);
    expect(vp().z).not.toBe(z);
    noNodeAction(spies);
  });
});

describe('actions', () => {
  it('sshFsCanvas_actionsUseClickedItem_notSelectedOrActivePane', async () => {
    const spies = nodeSpies();
    const bridge = await liveScene(spies);
    // A zoomed canvas, so a menu placed by scaled coordinates would land elsewhere.
    act(() => { store.dispatch(setViewport({ x: -40, y: 10, z: 0.5 })); });
    const nodeA = canvasNode(A), nodeB = canvasNode(B);

    // Distinct SELECTED rows in both nodes; every action below targets a different, clicked row.
    await clickAsync(rowButton(nodeA, '/srv/a/sel.txt'));
    await clickAsync(rowButton(nodeB, '/srv/b/sel.txt'));
    expect(rowButton(nodeA, '/srv/a/sel.txt').getAttribute('aria-pressed')).toBe('true');
    expect(rowButton(nodeB, '/srv/b/sel.txt').getAttribute('aria-pressed')).toBe('true');

    // A: Copy path on the right-clicked row. The shared menu at CLIENT coordinates.
    await openRowMenu(nodeA, '/srv/a/click.txt');
    const menu = document.querySelector<HTMLElement>('.context-menu')!;
    expect(h.container.contains(menu)).toBe(false);                       // portalled, screen-space
    expect(menu.style.left).toBe('123px');
    expect(menu.style.top).toBe('77px');
    await clickAsync(menuItem('Copy path'));
    expect(jest.mocked(writeClipboardText).mock.calls).toEqual([['/srv/a/click.txt']]);

    // A: Insert path — the registered 068 insertion IPC, this terminal, its generation.
    await openRowMenu(nodeA, '/srv/a/click.txt');
    await clickAsync(menuItem('Insert path'));
    expect(bridge.ssh.fsInsertPath.mock.calls).toEqual([[{ terminalId: A, path: '/srv/a/click.txt', expectedGeneration: 1 }]]);

    // B: Download and Properties on B's clicked row, on B's generation.
    await openRowMenu(nodeB, '/srv/b/click.txt');
    await clickAsync(menuItem('Download…'));
    expect(bridge.ssh.fsDownload.mock.calls).toEqual([[{ terminalId: B, path: '/srv/b/click.txt', expectedGeneration: 2 }]]);
    await openRowMenu(nodeB, '/srv/b/click.txt');
    await clickAsync(menuItem('Properties'));
    expect(bridge.ssh.fsStat.mock.calls).toEqual([[{ terminalId: B, path: '/srv/b/click.txt', expectedGeneration: 2 }]]);
    await clickAsync([...document.querySelectorAll<HTMLButtonElement>('[role=dialog] button')].find(b => b.textContent === 'Close')!);

    // Middle-click on B's SELECTED row: no autoscroll, and exactly one registered insertion for B.
    const down = mouse(rowOf(nodeB, '/srv/b/sel.txt'), 'mousedown', { button: 1, buttons: 4 });
    await act(async () => { await flush(); });
    expect(down.defaultPrevented).toBe(true);
    mouse(rowOf(nodeB, '/srv/b/sel.txt'), 'auxclick', { button: 1 });
    await act(async () => { await flush(); });
    expect(bridge.ssh.fsInsertPath.mock.calls).toEqual([
      [{ terminalId: A, path: '/srv/a/click.txt', expectedGeneration: 1 }],
      [{ terminalId: B, path: '/srv/b/sel.txt', expectedGeneration: 2 }],
    ]);

    // Never the generic renderer PTY write, from either side of the bridge.
    expect(terminalService.writeToTerminal).not.toHaveBeenCalled();
    expect(bridge.writeToTerminal).not.toHaveBeenCalled();
    noNodeAction(spies);
  });
});

describe('portal menu and dialog', () => {
  it('sshCanvas_portalMenuAndProperties_doNotDragOrDismissOverlay', async () => {
    const spies = nodeSpies();
    const bridge = await liveScene(spies, true, [A]);
    const node = canvasNode(A);

    // Positive controls: the terminal slot and header keep their node meaning.
    const slot = node.querySelector<HTMLElement>('.terminal-display-wrapper')!;
    mouse(slot, 'pointerdown');
    mouse(slot, 'dblclick');
    mouse(slot, 'contextmenu');
    mouse(node.querySelector('.canvas-node-head')!, 'pointerdown');
    expect(spies.select).toHaveBeenCalledWith(A);
    expect(spies.enlarge).toHaveBeenCalledWith(A);
    expect(spies.nodeMenu).toHaveBeenCalledWith(A);
    expect(spies.drag).toHaveBeenCalledWith(A);
    resetSpies(spies);

    // Browser and status chrome: no select/drag/enlarge, no node menu, no native menu.
    for (const target of [rowOf(node, '/srv/a/sel.txt'), node.querySelector<HTMLElement>('.ssh-file-toolbar')!, node.querySelector<HTMLElement>('.ssh-status')!]) {
      mouse(target, 'pointerdown');
      mouse(target, 'dblclick');
      const menuEvent = mouse(target, 'contextmenu');
      expect(menuEvent.defaultPrevented).toBe(true);
    }
    noNodeAction(spies);

    // The REAL house menu, portalled to <body>. Its events bubble through React to the node.
    await openRowMenu(node, '/srv/a/click.txt');
    const menu = document.querySelector<HTMLElement>('.context-menu')!;
    expect(menu).not.toBeNull();
    expect(h.container.contains(menu)).toBe(false);
    const properties = menuItem('Properties');
    for (const type of ['pointerdown', 'mousedown', 'dblclick', 'contextmenu']) mouse(properties, type);
    expect(document.querySelector('.context-menu')).not.toBeNull();       // still open: not dismissed
    noNodeAction(spies);

    // The REAL Properties dialog, also portalled; it works, and touching it moves nothing.
    await clickAsync(properties);
    const dialog = document.querySelector<HTMLElement>('[role=dialog]')!;
    expect(dialog).not.toBeNull();
    expect(h.container.contains(dialog)).toBe(false);
    expect(dialog.textContent).toContain('Properties');
    expect(dialog.textContent).toContain('/srv/a/click.txt');
    expect(bridge.ssh.fsStat).toHaveBeenCalledTimes(1);
    for (const target of [dialog, dialog.querySelector('dl')!]) {
      for (const type of ['pointerdown', 'mousedown', 'dblclick', 'contextmenu']) mouse(target, type);
    }
    expect(document.querySelector('[role=dialog]')).toBe(dialog);
    const copy = [...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Copy path')!;
    await clickAsync(copy);
    expect(jest.mocked(writeClipboardText).mock.calls).toEqual([['/srv/a/click.txt']]);
    noNodeAction(spies);

    await clickAsync([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Close')!);
    expect(document.querySelector('[role=dialog]')).toBeNull();
    noNodeAction(spies);
  });
});

describe('keyboard', () => {
  const key = (k: string, target: CanvasKey['target']): CanvasKey =>
    ({ key: k, code: `Key${k.toUpperCase()}`, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, target });

  it('sshCanvas_keyboardGuard_sshControlsOwnCanvasShortcuts', async () => {
    const spies = nodeSpies();
    await liveScene(spies, true, [A]);
    const node = canvasNode(A);
    const viewport = document.querySelector<HTMLElement>('.canvas-viewport')!;
    const pathInput = node.querySelector<HTMLInputElement>('input[aria-label="Remote path"]')!;
    const row = rowButton(node, '/srv/a/sel.txt');
    const space = (target: Element) => act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', code: 'Space', bubbles: true, cancelable: true }));
    });
    const release = () => act(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { key: ' ', code: 'Space', bubbles: true }));
    });

    // Positive control: Space on the canvas arms the hand tool (a window-CAPTURE Canvas shortcut).
    space(document.body);
    expect(viewport.classList.contains('space-pan')).toBe(true);
    release();
    expect(viewport.classList.contains('space-pan')).toBe(false);

    // The same key in an SSH menu belongs to the menu. The menu is a role=menu container, which the
    // generic button/editable refusals do not cover: only the SSH guard stops this one.
    await openRowMenu(node, '/srv/a/click.txt');
    const menu = document.querySelector<HTMLElement>('.context-menu')!;
    expect(document.activeElement).toBe(menu);
    space(menu);
    expect(viewport.classList.contains('space-pan')).toBe(false);
    act(() => { menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await act(async () => { await flush(); });

    // CanvasMode's two capture listeners ask the same guard. Each SSH owner is recognised; the
    // canvas itself and the terminal slot are not.
    await openRowMenu(node, '/srv/a/click.txt');
    const sshMenu = document.querySelector<HTMLElement>('.context-menu')!;
    await clickAsync(menuItem('Properties'));
    const dialogButton = document.querySelector<HTMLElement>('[role=dialog] button')!;
    for (const owner of [pathInput, row, dialogButton]) expect(sshOwnsKeyboard(owner)).toBe(true);
    expect(sshOwnsKeyboard(sshMenu)).toBe(true);
    for (const free of [document.body, node, node.querySelector('.terminal-display-wrapper')!]) expect(sshOwnsKeyboard(free)).toBe(false);
    // D66 put 069's focusable metrics bar and its body-portalled menu into the node (review 349 F6).
    const bar = node.querySelector<HTMLElement>('.ssh-status > .ssh-metrics-status-bar')!;
    expect(sshOwnsKeyboard(bar)).toBe(true);
    act(() => { bar.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 5, clientY: 5 })); });
    const barMenu = [...document.querySelectorAll<HTMLElement>('.context-menu')]
      .filter(m => m.textContent?.includes('Copy all metrics'));
    expect(barMenu).toHaveLength(1);
    expect(sshOwnsKeyboard(barMenu[0])).toBe(true);
    act(() => { barMenu[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });

    // Positive control for the rule itself: with a node selected, the enlarge key on a focused SSH
    // ROW resolves to a Canvas action, so without the guard it would open the overlay.
    expect(canvasKeyAction(key('q', row), { node: true, edge: false }, COMBOS)).toEqual({ do: 'overlay' });
    expect(canvasKeyAction(key('q', document.body), { node: true, edge: false }, COMBOS)).toEqual({ do: 'overlay' });

    // Source wiring: CanvasMode cannot be mounted in jsdom without TerminalService and flight
    // machinery, so each of its capture handlers is read whole and must bail on the guard BEFORE
    // asking its rule.
    const mode = readSource(path.join(__dirname, '..', 'CanvasMode.tsx'));
    for (const rule of ['canvasKeyAction(', 'terminalKeyAction(']) {
      const at = mode.indexOf(rule);
      const start = mode.lastIndexOf('const onKey = (e: KeyboardEvent) => {', at);
      const body = mode.slice(start, at);
      expect(start).toBeGreaterThanOrEqual(0);
      expect(body).toContain('if (sshOwnsKeyboard(e.target)) return;');
    }
    const viewportSource = readSource(path.join(__dirname, '..', 'CanvasViewport.tsx'));
    const arm = viewportSource.slice(viewportSource.indexOf('const arm = (e: KeyboardEvent) => {'));
    expect(arm.indexOf('sshOwnsKeyboard(e.target)')).toBeLessThan(arm.indexOf('shouldArmSpacePan('));
  });
});

describe('068 F5 focus restore', () => {
  it('sshDialog_closeOnNonOwningSurface_doesNotMoveFocus', async () => {
    const spies = nodeSpies();
    // Pane alone: the pane presentation owns interaction.
    await liveScene(spies, false, [A]);
    const pane = paneShell(A);
    expect(pane.getAttribute('data-ssh-interaction-owner')).toBe('true');

    // Positive control on the OWNING surface: Properties closes and focus returns to its row.
    await openRowMenu(pane, '/srv/a/click.txt');
    await clickAsync(menuItem('Properties'));
    let dialog = document.querySelector<HTMLElement>('[role=dialog]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    await clickAsync([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Close')!);
    expect(document.querySelector('[role=dialog]')).toBeNull();
    const paneTrigger = rowButton(pane, '/srv/a/click.txt');
    expect(document.activeElement).toBe(paneTrigger);

    // Open again from the pane, then Canvas takes the terminal: the pane stays laid out (and its
    // trigger connected) but no longer owns interaction, so its dialog closes WITHOUT pulling
    // focus back into it.
    await openRowMenu(pane, '/srv/a/click.txt');
    await clickAsync(menuItem('Properties'));
    dialog = document.querySelector<HTMLElement>('[role=dialog]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    await h.render(<SshScene ids={[A]} canvas spies={spies} />);
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(pane.getAttribute('data-ssh-interaction-owner')).toBe('false');
    expect(paneTrigger.isConnected).toBe(true);
    expect(document.activeElement).not.toBe(paneTrigger);
    expect(pane.contains(document.activeElement)).toBe(false);

    // And the Canvas presentation, now the owner, restores to ITS trigger.
    const node = canvasNode(A);
    expect(node.querySelector('.ssh-pane-shell')!.getAttribute('data-ssh-interaction-owner')).toBe('true');
    await openRowMenu(node, '/srv/a/click.txt');
    await clickAsync(menuItem('Properties'));
    dialog = document.querySelector<HTMLElement>('[role=dialog]')!;
    await clickAsync([...dialog.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === 'Close')!);
    expect(document.activeElement).toBe(rowButton(node, '/srv/a/click.txt'));
  });

  it('sshDialog_nodeGoesHidden_closesItsDialogWithoutMovingFocus', async () => {
    // A culled / chip-tier / hidden Canvas node is not the visible surface either (review 347 F1).
    const spies = nodeSpies();
    await liveScene(spies, true, [A]);
    const node = canvasNode(A);
    const shell = node.querySelector('.ssh-pane-shell')!;
    expect(shell.getAttribute('data-ssh-interaction-owner')).toBe('true');
    await openRowMenu(node, '/srv/a/click.txt');
    await clickAsync(menuItem('Properties'));
    const dialog = document.querySelector<HTMLElement>('[role=dialog]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    const trigger = rowButton(node, '/srv/a/click.txt');

    await h.render(<SshScene ids={[A]} canvas spies={spies} hiddenIds={[A]} />);
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(shell.getAttribute('data-ssh-interaction-owner')).toBe('false');
    expect(trigger.isConnected).toBe(true);
    expect(node.contains(document.activeElement)).toBe(false);
    // No menu can open on the hidden node either.
    await openRowMenu(node, '/srv/a/click.txt');
    expect(document.querySelector('.context-menu')).toBeNull();

    // Visible again: positive control for the menu probe above.
    await h.render(<SshScene ids={[A]} canvas spies={spies} />);
    await openRowMenu(node, '/srv/a/click.txt');
    expect(document.querySelector('.context-menu')).not.toBeNull();
    // Visible again: it owns interaction and its dialogs restore focus to it.
    await h.render(<SshScene ids={[A]} canvas spies={spies} />);
    expect(shell.getAttribute('data-ssh-interaction-owner')).toBe('true');
  });

  it('sshCreateDialog_paneToCanvasHandOver_closesThePaneDialog', async () => {
    // The one controller stays live across the hand-over (070 grace), so the pane's Create dialog
    // must close on loss of the surface, not on loss of liveness (review 347 F2).
    const spies = nodeSpies();
    await liveScene(spies, false, [A]);
    const pane = paneShell(A);
    const newFolder = [...pane.querySelectorAll<HTMLButtonElement>('.ssh-file-toolbar button')].find(b => b.getAttribute('aria-label') === 'New folder')!;
    expect(newFolder.disabled).toBe(false);
    await clickAsync(newFolder);
    expect(document.querySelector('[role=dialog]')).not.toBeNull();

    await h.render(<SshScene ids={[A]} canvas spies={spies} />);
    expect(document.querySelector('[role=dialog]')).toBeNull();
    expect(pane.contains(document.activeElement)).toBe(false);
  });
});
