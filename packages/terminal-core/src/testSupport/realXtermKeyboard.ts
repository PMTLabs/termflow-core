import { join } from 'path';

// Use the installed browser terminal's actual keyboard implementation, not a
// second encoding table. Supply only the DOM/composition host normally made by open().
export function realXtermKeyboard(isMac = false, macOptionIsMeta = false) {
  const { Terminal } = require(join(process.cwd(), '../../node_modules/@xterm/xterm/lib/xterm.js'));
  const terminal = new Terminal({ macOptionIsMeta });
  const core = terminal._core;
  core.element = document.createElement('div');
  core.textarea = document.createElement('textarea');
  core._compositionHelper = { keydown: () => true };
  core.coreService.isCursorInitialized = true;
  core.browser = { ...core.browser, isMac, isWindows: !isMac };
  const output: string[] = [];
  terminal.onData((data: string) => output.push(data));
  return {
    terminal, core,
    bytes(event: KeyboardEvent, applicationCursorKeys: boolean): string | null {
      output.length = 0;
      core.coreService.decPrivateModes.applicationCursorKeys = applicationCursorKeys;
      core._keyDown(event);
      // The browser sends uppercase ASCII and third-level-shift text via keypress.
      const thirdLevel = isMac ? !macOptionIsMeta && event.altKey && !event.ctrlKey : event.altKey && event.ctrlKey;
      if (!output.length && [...event.key].length === 1 && !event.metaKey
        && ((/^[A-Z]$/.test(event.key) && !event.ctrlKey && !event.altKey) || thirdLevel)) {
        core._keyPress(new KeyboardEvent('keypress', { key: event.key, charCode: event.key.charCodeAt(0),
          shiftKey: event.shiftKey, altKey: event.altKey, ctrlKey: event.ctrlKey }));
      }
      return output.length ? output.join('') : null;
    },
    dispose: () => terminal.dispose(),
  };
}
