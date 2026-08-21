/**
 * `TabManager` must not declare keyboard shortcuts of its own.
 *
 * The bug this pins: Settings > Shortcuts lets you rebind **Close Tab** away from `Ctrl+W`, and
 * `Ctrl+W` kept closing the tab anyway. `TabManager` carried a second, hard-coded copy of the
 * binding on a BUBBLE-phase window listener, and `InputHandler.handleKeyEvent` returns `false`
 * WITHOUT `stopPropagation` when nothing matches -- so the moment the registry stopped claiming
 * `Ctrl+W`, the hidden copy behind it claimed the key instead. `Ctrl+W` could never be freed,
 * and no part of the customization UI knew the second binding existed.
 *
 * Nothing is lost by deleting it. `InputHandler.handleCloseTab` does not remove the tab itself
 * -- it dispatches `ui:requestTabClose`, which lands on the very same confirm-and-close flow
 * this component already owns. That is asserted positively below, because a test that only
 * checks the shortcut is gone would also pass if closing a tab had stopped working entirely.
 *
 * Source-derived: `TabManager` pulls in the whole tab strip, and the failure is silent -- a
 * future hand-rolled `if (e.key === ...)` here would re-open the bug with every other test green.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

/** Comments stripped, so this file's own explanatory prose can never satisfy an assertion. */
const SRC = readSource(path.resolve(__dirname, '..', 'TabManager.tsx'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('TabManager declares no shortcuts of its own', () => {
  /** Or every assertion below matches an empty string and passes saying nothing. */
  it('found the source', () => {
    expect(SRC).toContain('const TabManager');
  });

  /**
   * The whole class, not the one key that was reported. A keydown listener here is a second
   * shortcut owner competing with the registry, whatever combo it happens to claim today.
   */
  it('registers no keydown listener', () => {
    expect(SRC).not.toMatch(/addEventListener\(\s*['"]keydown['"]/);
  });

  it('hard-codes no Close Tab binding', () => {
    expect(SRC).not.toMatch(/key\s*===\s*['"]w['"]/i);
    expect(SRC).not.toContain('Ctrl+W');
  });

  /** The tab-jump half of the same listener. Harmless today only because `Ctrl+1`-`Ctrl+9` is
   *  non-customizable -- the two copies agree by luck, not by design. */
  it('hard-codes no tab-jump binding', () => {
    expect(SRC).not.toMatch(/key\s*>=\s*['"]1['"]/);
  });

  /**
   * The positive half. `InputHandler`'s `closeTab` reaches this component through an event, not
   * a direct store write, precisely so the running-process dialog and the settings-dirty guard
   * still run. Losing this listener would make the shortcut silently stop closing anything.
   */
  it('still answers the close request InputHandler routes to it', () => {
    expect(SRC).toContain("window.addEventListener('ui:requestTabClose'");
  });
});
