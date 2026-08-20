/**
 * Design 014 Task 11 — the root-vs-split special cases are gone and stay gone.
 *
 * Before 014 a renderer-created tab's root pane carried the TAB's own id as its
 * terminal id, so several places asked "is this leaf really a root?" by looking at
 * the prefix. Every root leaf is a minted `tm-` now, so those branches answer the
 * same way for every pane in the app — a dead arm that reads as live logic, and in
 * two cases a fallback that had quietly started producing the WRONG id.
 *
 * Source-derived because the sites live inside a component that cannot be mounted
 * here (`TerminalPane` spawns PTYs on mount) and inside a service method whose
 * spawn path goes through the IPC bridge. The behavioural half — that the two
 * kinds of root are now indistinguishable — is a real assertion, below.
 *
 * **Matches run against source with comments stripped.** The comments left at each
 * deletion site deliberately name the branch that was removed, so an un-stripped
 * match would be satisfied by the prose explaining the fix rather than by the fix.
 */
import path from 'path';
import { readSource } from '../../../utils/readSource';
import { getAllTerminalIds } from '../../../store/slices/paneTreeOps';
import type { PaneNode } from '../../../store/slices/panesSlice';

/** Source with block and line comments removed. */
function code(file: string): string {
  return readSource(file)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const PANES = path.resolve(__dirname, '..');
const SERVICES = path.resolve(__dirname, '../../../services');

const TERMINAL_PANE = code(path.join(PANES, 'TerminalPane.tsx'));
const TERMINAL_SERVICE = code(path.join(SERVICES, 'TerminalService.ts'));

describe('TerminalPane no longer decides anything from a leaf prefix', () => {
  // The guard was `terminalId.startsWith('tb-') || terminalId.startsWith('tab-')`,
  // gating "this tab is gone, skip creation". No leaf can be a tab id now, so it
  // could never fire — and generalising it to `if (!tab)` would strand a pane
  // rendering from the window mirror before its tree reaches treesByTabId.
  it('has no tab-prefixed leaf guard', () => {
    expect(TERMINAL_PANE).not.toMatch(/startsWith\(['"]tb-['"]\)/);
    expect(TERMINAL_PANE).not.toMatch(/startsWith\(['"]tab-['"]\)/);
  });

  // Three copies of `isSplitPane = startsWith('tm-') || startsWith('pane-terminal-')`
  // chose between the tab's stored shellType and the default profile. Every leaf
  // takes the split arm now; the pane node's own shellType (copied from the tab by
  // the seed) is what carries a profile down.
  it('has no root-vs-split shellType branch', () => {
    expect(TERMINAL_PANE).not.toMatch(/isSplitPane/);
    expect(TERMINAL_PANE).not.toMatch(/tab\?\.shellType/);
  });

  // The lookup was `state.tabs.tabs.find(t => t.id === terminalId)` — an equality
  // that only ever held for a pre-014 renderer root. Left alone it would resolve
  // to undefined for every pane forever, which is invisible: each use sits behind
  // `?.` with a fallback.
  it('resolves the owning tab through the pane tree, not by id equality', () => {
    expect(TERMINAL_PANE).not.toMatch(/t\.id === terminalId/);
    // Anchored on the binding, not on a bare `findTabIdByTerminalId(...)` call:
    // the tabMuted selector already contains that call, so the loose form would
    // pass with the broken equality lookup still in place.
    expect(TERMINAL_PANE).toMatch(
      /const owner = findTabIdByTerminalId\(state\.panes\.treesByTabId, terminalId\);\s*\n\s*return owner \?/
    );
  });

  // `findTabIdByTerminalId(...) || terminalId` filed a TERMINAL id as an owning
  // TAB id whenever the tree had not been committed yet. Undefined is the honest
  // answer; reassertOwnerAfterSpawn supplies the real owner once the tree lands.
  it('never falls back to the leaf id when the owning tab is unknown', () => {
    const spawnOwners = TERMINAL_PANE.match(/findTabIdByTerminalId\([^;]*?\) \?\? undefined/g) ?? [];
    // One in the create effect, one in handleRestart.
    expect(spawnOwners).toHaveLength(2);
    expect(TERMINAL_PANE).not.toMatch(/findTabIdByTerminalId\([^;]*?\) \|\| terminalId/);
  });
});

describe('TerminalService no longer branches on a leaf prefix', () => {
  // `isPaneTerminal` decided whether an existing binding meant "reuse" or "spawn a
  // new one". Post-014 every leaf takes the spawn arm, and the reuse decision
  // already belongs to TerminalPane's mount effect.
  it('has no isPaneTerminal reuse branch in the create path', () => {
    expect(TERMINAL_SERVICE).not.toMatch(/isPaneTerminal/);
  });
});

describe('a renderer-created root and an API-created root are indistinguishable', () => {
  const rootLeaf = (terminalId: string): PaneNode => ({
    id: 'pn-1',
    type: 'terminal',
    terminalId,
  });

  // Before 014 the first of these would have been `tb-111111111` — the tab's own
  // id — and the second a minted `tm-`. Nothing downstream can tell them apart now,
  // which is precisely why the branches above had to go.
  it('reports each root by its own tm- leaf', () => {
    expect(getAllTerminalIds(rootLeaf('tm-aaaaaaaaa'))).toEqual(['tm-aaaaaaaaa']);
    expect(getAllTerminalIds(rootLeaf('tm-bbbbbbbbb'))).toEqual(['tm-bbbbbbbbb']);
  });
});
