/**
 * @jest-environment jsdom
 *
 * D51 — 066's launch notice is the single owner of the SSH prompts and Reconnect on both surfaces.
 * Pins the parts the DOM tests cannot: the placement the test probe mirrors, the Canvas overlay
 * CSS (JSDOM is not a layout engine; T8 measures it for real) and the wheel/keyboard guards.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';
import { OWNED_NOTICE_PLACEMENT } from '../../../__testFixtures__/sshLaunchNoticeProbe';
import { scrollRegionTakesWheel, sshOwnsKeyboard } from '../canvasGestures';

const squash = (text: string) => text.replace(/\s+/g, ' ');

it('sshNotice_probePlacement_matchesTheOwnedNotice', () => {
  const owned = readSource(path.resolve(__dirname, '../../Ssh/OwnedSshLaunchNotice.tsx'));
  expect(squash(owned)).toContain(squash(OWNED_NOTICE_PLACEMENT));
});

it('sshNotice_canvasOverlay_neverTakesARowInTheTerminalSlot', () => {
  const css = readSource(path.resolve(__dirname, '../Canvas.css')).replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect([selector, at >= 0]).toEqual([selector, true]);
    return css.slice(css.indexOf('{', at), css.indexOf('}', at));
  };
  const notice = block('.canvas-ssh-surface .terminal-display-wrapper > .ssh-launch-notice');
  expect(notice).toMatch(/position:\s*absolute/);
  expect(notice).toMatch(/inset:\s*0 0 auto/);
  // Above the SSH shell's chrome row (`.ssh-pane-chrome`, z-index 5).
  expect(Number(/z-index:\s*(\d+)/.exec(notice)![1])).toBeGreaterThan(5);
  // The wrapper is the containing block, without becoming a stacking context of its own.
  const wrapper = block('.canvas-ssh-surface .ssh-terminal-host > .terminal-display-wrapper');
  expect(wrapper).toMatch(/position:\s*relative/);
  expect(wrapper).not.toMatch(/z-index/);
});

it('sshNotice_ownsCanvasKeysAndItsOwnWheel', () => {
  document.body.innerHTML = `<div class="canvas-ssh-surface"><div class="terminal-display-wrapper">
    <section class="ssh-launch-notice"><input id="secret"><button id="trust">Trust</button></section>
    <div class="terminal-display" id="host"></div></div></div>`;
  const notice = document.querySelector<HTMLElement>('.ssh-launch-notice')!;
  for (const id of ['secret', 'trust']) expect(sshOwnsKeyboard(document.getElementById(id))).toBe(true);
  // Control: the terminal host beside it is not an SSH keyboard owner.
  expect(sshOwnsKeyboard(document.getElementById('host'))).toBe(false);
  // A notice that can still scroll takes a plain wheel; at its end the wheel is the canvas's again.
  Object.defineProperties(notice, {
    scrollHeight: { value: 300, configurable: true }, clientHeight: { value: 100, configurable: true },
    scrollTop: { value: 0, writable: true, configurable: true },
  });
  expect(scrollRegionTakesWheel(document.getElementById('trust'), { deltaX: 0, deltaY: 40 })).toBe(true);
  notice.scrollTop = 200;
  expect(scrollRegionTakesWheel(document.getElementById('trust'), { deltaX: 0, deltaY: 40 })).toBe(false);
  expect(scrollRegionTakesWheel(document.getElementById('host'), { deltaX: 0, deltaY: 40 })).toBe(false);
});
