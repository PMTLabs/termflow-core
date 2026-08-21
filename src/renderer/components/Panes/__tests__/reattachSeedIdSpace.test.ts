/**
 * The reattach seed must be drained with the PROCESS id, not the leaf id.
 *
 * Design 014 split one string into four id spaces. `state.terminals` and
 * `reattach_prompt_hooks` were both re-keyed off the leaf onto the freshly-minted `pc-`
 * process id (`commands.rs:424`, `commands.rs:573-582`), but this reader was not updated --
 * it still passed the durable `tm-`/`tb-` leaf. `take_reattach_prompt_hook` therefore looked
 * a `pc-` map up by a `tm-` string, missed every time, and returned `None` on every reattach.
 *
 * ONE dead lookup, TWO shipped symptoms, which is why this is pinned rather than eyeballed:
 *
 *   1. `stashPromptGate` never ran, so the command-suggest gate stayed unarmed and the
 *      command-history popup leaked into an agent CLI that survived the restart.
 *   2. `markReattachedSession` never ran -- it lives INSIDE the same `if (seed)` -- so
 *      Win32-Input-Mode was never re-seeded. ConPTY announces `?9001h` once per session,
 *      before this renderer existed, and no snapshot or scrollback replays a mode. The pane
 *      then sends legacy bytes to a ConPTY expecting records, and Escape and Backspace never
 *      reach the CLI while ordinary printable characters still do.
 *
 * The sibling command is the reference: `probeReattachPromptGate` is already called with
 * `existingProcessId`. These two commands take the same id space and disagreed.
 *
 * Source-derived: `TerminalPane` cannot be mounted under this Jest config, and the failure is
 * totally silent -- both calls type-check as `string`, so nothing but a live reattach could
 * tell the two ids apart.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';

/** Comments stripped, so this file's own prose can never satisfy an assertion. */
const SRC = readSource(path.resolve(__dirname, '..', 'TerminalPane.tsx'))
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('the reattach seed is drained by process id', () => {
  /** Or every assertion below matches an empty string and passes saying nothing. */
  it('found the source', () => {
    expect(SRC).toContain('takeReattachPromptHook');
  });

  it('passes the process id the create call resolved with', () => {
    expect(SRC).toContain('window.electronAPI.takeReattachPromptHook?.(pid)');
  });

  /** The whole bug in one line: a leaf id here can never match a `pc-`-keyed map. */
  it('never passes the leaf id', () => {
    expect(SRC).not.toContain('takeReattachPromptHook?.(terminalId)');
  });

  /**
   * The positive half, and the real risk of this fix: the two seeds it unlocks are stored in
   * the RENDERER cache, which is keyed by the leaf. Swapping every `terminalId` in this block
   * for `pid` would make the drain succeed and then file both results under an id nothing
   * reads. The call is by process, the storage is by leaf, and both must stay that way.
   */
  it('still stores both seeds under the leaf id', () => {
    expect(SRC).toContain('terminalService.stashPromptGate(\n              terminalId,');
    expect(SRC).toContain('terminalService.markReattachedSession(terminalId);');
  });

  /** The sibling command this one had drifted away from. */
  it('matches the sibling probe, which was always by process id', () => {
    expect(SRC).toContain('window.electronAPI.probeReattachPromptGate?.(existingProcessId)');
  });
});
