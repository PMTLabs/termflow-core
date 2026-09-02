/**
 * @jest-environment jsdom
 *
 * `findHiddenAgentTerminals` — which running agent CLIs has this workspace lost
 * track of? The join is over two endpoints that each hold half the answer
 * (`/api/processes` has the agent, `/api/terminals` has the renderer identity),
 * so most of the ways this can go wrong are ways the join can go wrong.
 *
 * The window-ownership filter uses the REAL `windowScope` helpers rather than a
 * stub: session keys are built by the same code that parses them, so a test
 * cannot pass against a key shape production would never produce.
 */
import {
  findHiddenAgentTerminals,
  visibleTerminalIds,
  sameHiddenSet,
  ProcessRow,
  IdentityRow,
} from '../hiddenAgentTerminals';
import { sessionKeyPrefix, WINDOW_SEPARATOR, __setWindowForTests, currentWindowId } from '../windowScope';

const ME = 'w1';
const OTHER = 'w2';

/** A session key genuinely owned by `windowId`, built the way production builds
 *  it — `sessionKeyPrefix()` is the same function `windowIdFromSessionKey` parses
 *  against, so this cannot drift from the real format. */
const keyFor = (windowId: string) => `${sessionKeyPrefix()}${WINDOW_SEPARATOR}${windowId}`;

const proc = (id: string, agent: string | null, name = 'shell'): ProcessRow => ({ id, agent, name });
const ident = (id: string, terminalId: string | null, extra: Partial<IdentityRow> = {}): IdentityRow =>
  ({ id, processId: id, terminalId, ...extra });

beforeEach(() => {
  __setWindowForTests(ME);
});

describe('visibleTerminalIds', () => {
  it('collects every leaf across every tab, including nested splits', () => {
    const ids = visibleTerminalIds({
      'tb-a': { id: 'pn-1', type: 'terminal', terminalId: 'tm-1' },
      'tb-b': {
        id: 'pn-2', type: 'split', direction: 'horizontal',
        children: [
          { id: 'pn-3', type: 'terminal', terminalId: 'tm-2' },
          { id: 'pn-4', type: 'terminal', terminalId: 'tm-3' },
        ],
      },
      // An open-but-empty tab. Must not throw, must contribute nothing.
      'tb-c': null,
    } as any);
    expect([...ids].sort()).toEqual(['tm-1', 'tm-2', 'tm-3']);
  });
});

describe('findHiddenAgentTerminals', () => {
  it('reports a running agent that no pane is showing', () => {
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude', 'claude')],
      [ident('pc-1', 'tm-1', { name: 'Agent work' })],
      new Set(),
      currentWindowId(),
    );
    expect(out).toEqual([
      { terminalId: 'tm-1', processId: 'pc-1', agent: 'claude', name: 'Agent work', promptHook: undefined },
    ]);
  });

  it('ignores a terminal with no agent — a bare shell is not lost work', () => {
    // `agent` is null for every process in the SHELLS list on the backend. The
    // feature is about stranded CLIs; a stranded `pwsh` is just a closed tab.
    const out = findHiddenAgentTerminals(
      [proc('pc-1', null), proc('pc-2', '   ')],
      [ident('pc-1', 'tm-1'), ident('pc-2', 'tm-2')],
      new Set(),
      currentWindowId(),
    );
    expect(out).toEqual([]);
  });

  it('ignores a terminal a pane in THIS workspace is already showing', () => {
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude'), proc('pc-2', 'codex')],
      [ident('pc-1', 'tm-visible'), ident('pc-2', 'tm-hidden')],
      new Set(['tm-visible']),
      currentWindowId(),
    );
    expect(out.map(h => h.terminalId)).toEqual(['tm-hidden']);
  });

  /**
   * The filter that is easy to forget, and the expensive one to get wrong.
   * `/api/terminals` lists terminals across ALL windows, so "absent from my pane
   * trees" is not "absent from every screen". Offering another window's terminal
   * and having the user accept would put a second pane on a leaf that already
   * has one — and `findTabIdByTerminalId` returns the FIRST match, so the two
   * panes would then disagree about routing and muting.
   */
  it('ignores a terminal whose session key belongs to a DIFFERENT window', () => {
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude'), proc('pc-2', 'codex')],
      [
        ident('pc-1', 'tm-mine', { sessionKey: keyFor(ME) }),
        ident('pc-2', 'tm-theirs', { sessionKey: keyFor(OTHER) }),
      ],
      new Set(),
      currentWindowId(),
    );
    expect(out.map(h => h.terminalId)).toEqual(['tm-mine']);
  });

  it('includes a terminal with no session key at all — nothing has claimed it', () => {
    // The paired positive for the filter above. Without it, a bug that excluded
    // everything with a falsy owner would pass the "different window" test while
    // making the feature report nothing, ever.
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude')],
      [ident('pc-1', 'tm-1', { sessionKey: null })],
      new Set(),
      currentWindowId(),
    );
    expect(out.map(h => h.terminalId)).toEqual(['tm-1']);
  });

  it('ignores a process with no renderer identity — there is no leaf to rebuild around', () => {
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude'), proc('pc-2', 'codex')],
      [ident('pc-1', null), /* pc-2 has no identity row at all */],
      new Set(),
      currentWindowId(),
    );
    expect(out).toEqual([]);
  });

  it('offers a leaf once even when the backend briefly holds two rows for it', () => {
    // A respawn racing a close leaves two processes pointing at one leaf.
    // Offering it twice would build two tabs for one terminal — the duplicate
    // state this module exists to avoid creating.
    const out = findHiddenAgentTerminals(
      [proc('pc-old', 'claude'), proc('pc-new', 'claude')],
      [ident('pc-old', 'tm-1'), ident('pc-new', 'tm-1')],
      new Set(),
      currentWindowId(),
    );
    expect(out).toHaveLength(1);
    expect(out[0].terminalId).toBe('tm-1');
  });

  it('falls back through identity name, process name, then the agent label', () => {
    const out = findHiddenAgentTerminals(
      [proc('pc-1', 'claude', 'proc-name'), proc('pc-2', 'codex', 'proc-name'), proc('pc-3', 'gemini', null)],
      [
        ident('pc-1', 'tm-1', { name: 'identity-name' }),
        ident('pc-2', 'tm-2', { name: null }),
        ident('pc-3', 'tm-3', { name: null }),
      ],
      new Set(),
      currentWindowId(),
    );
    expect(out.map(h => h.name)).toEqual(['identity-name', 'proc-name', 'gemini']);
  });

  it('returns a stable order regardless of backend iteration order', () => {
    // The indicator's count and the restore dialog's list are rendered from this
    // array; an order that flapped between polls would reorder the list under
    // the user mid-read.
    const identities = [ident('pc-1', 'tm-c'), ident('pc-2', 'tm-a'), ident('pc-3', 'tm-b')];
    const forward = findHiddenAgentTerminals(
      [proc('pc-1', 'claude'), proc('pc-2', 'codex'), proc('pc-3', 'gemini')],
      identities, new Set(), currentWindowId(),
    );
    const reversed = findHiddenAgentTerminals(
      [proc('pc-3', 'gemini'), proc('pc-2', 'codex'), proc('pc-1', 'claude')],
      [...identities].reverse(), new Set(), currentWindowId(),
    );
    expect(forward.map(h => h.terminalId)).toEqual(['tm-a', 'tm-b', 'tm-c']);
    expect(reversed.map(h => h.terminalId)).toEqual(forward.map(h => h.terminalId));
  });
});

describe('sameHiddenSet', () => {
  const row = (terminalId: string, name: string) =>
    ({ terminalId, processId: 'pc', agent: 'claude', name });

  it('is insensitive to a name change — a retitling shell must not re-render the badge', () => {
    expect(sameHiddenSet([row('tm-1', 'before')] as any, [row('tm-1', 'after')] as any)).toBe(true);
  });

  it('sees a membership change', () => {
    expect(sameHiddenSet([row('tm-1', 'x')] as any, [row('tm-2', 'x')] as any)).toBe(false);
    expect(sameHiddenSet([row('tm-1', 'x')] as any, [] as any)).toBe(false);
  });
});
