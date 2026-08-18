import { buildSidebarTree, basename } from '../sidebarModel';
import type { CanvasNodeModel, CanvasGroupModel } from '../canvasSelectors';

const rect = { x: 0, y: 0, w: 340, h: 210 };
const node = (id: string, tabId: string, title: string, shellType = 'zsh'): CanvasNodeModel =>
  ({ terminalId: id, tabId, paneId: `pn-${id}`, title, shellType, rect, isRunning: false, hasUnseenOutput: false });
const group = (tabId: string, title: string, nodeIds: string[]): CanvasGroupModel =>
  ({ tabId, title, rect, nodeIds, anyRunning: false });

const nodes = [
  node('tm-1', 'tb-a', 'zsh'),
  node('tm-2', 'tb-a', 'server'),
  node('tm-3', 'tb-b', 'zsh'),
];
const groups = [group('tb-a', 'api', ['tm-1', 'tm-2']), group('tb-b', 'web', ['tm-3'])];
const cwds = { 'tm-1': '/home/u/termflow-core', 'tm-3': '/home/u/termflow-site' };

describe('basename', () => {
  it('handles posix and windows separators', () => {
    expect(basename('/home/u/proj')).toBe('proj');
    expect(basename('C:\\src\\proj')).toBe('proj');
  });

  it('tolerates a trailing separator and an empty string', () => {
    expect(basename('/home/u/proj/')).toBe('proj');
    expect(basename('')).toBe('');
  });

  // A drive root and a posix root have no basename at all. Returning the separator, or
  // `undefined`, would print as a disambiguator of `/` or `undefined` next to a terminal name.
  it('is empty for a bare root rather than returning a separator', () => {
    expect(basename('/')).toBe('');
    expect(basename('C:\\')).toBe('');
  });

  it('handles a path with no separator at all', () => {
    expect(basename('proj')).toBe('proj');
  });
});

describe('buildSidebarTree', () => {
  it('nests terminals under their group in tab order', () => {
    const t = buildSidebarTree(nodes, groups, '', cwds);
    expect(t.map((g) => g.tabId)).toEqual(['tb-a', 'tb-b']);
    expect(t[0].rows.map((r) => r.terminalId)).toEqual(['tm-1', 'tm-2']);
  });

  it('carries the group title through, not the tab id', () => {
    expect(buildSidebarTree(nodes, groups, '', cwds).map((g) => g.title)).toEqual(['api', 'web']);
  });

  it('filters rows by title, case-insensitively', () => {
    const t = buildSidebarTree(nodes, groups, 'SERV', cwds);
    expect(t).toHaveLength(1);
    expect(t[0].rows.map((r) => r.terminalId)).toEqual(['tm-2']);
  });

  it('drops groups with no surviving rows rather than showing them empty', () => {
    const t = buildSidebarTree(nodes, groups, 'server', cwds);
    expect(t.find((g) => g.tabId === 'tb-b')).toBeUndefined();
  });

  /**
   * ...but a group that is empty because its last terminal was dragged OUT is kept.
   *
   * `buildModel` goes out of its way to keep such a tab's frame on the canvas, because design
   * 010 §6.3/§10 makes it a drop target — and Task 15 adds a sidebar drag onto a group header,
   * which needs a header to aim at. Dropping it here would be the same bug one layer up: a
   * group you can still see on the canvas and can no longer reach from the list.
   *
   * The distinction is "empty because the query hid everything" versus "empty to begin with",
   * which is why this is not the same rule as the test above.
   */
  it('keeps a genuinely empty group, which is a drop target', () => {
    const withEmpty = [...groups, group('tb-c', 'staging', [])];
    const t = buildSidebarTree(nodes, withEmpty, '', cwds);
    expect(t.map((g) => g.tabId)).toEqual(['tb-a', 'tb-b', 'tb-c']);
    expect(t[2].rows).toEqual([]);
  });

  it('hides an empty group once a query is active, like every other non-match', () => {
    const withEmpty = [...groups, group('tb-c', 'staging', [])];
    expect(buildSidebarTree(nodes, withEmpty, 'server', cwds).map((g) => g.tabId)).toEqual(['tb-a']);
  });

  it('reports the matched range for highlighting', () => {
    const t = buildSidebarTree(nodes, groups, 'erv', cwds);
    const row = t[0].rows[0];
    expect(row.title.slice(row.matchStart, row.matchEnd)).toBe('erv');
  });

  // The range indexes the ORIGINAL title, so a query that matched case-insensitively must still
  // slice out the title's own casing rather than the query's.
  it('the range indexes the real title, whatever case the query was typed in', () => {
    const mixed = [node('tm-9', 'tb-z', 'ServerLog')];
    const t = buildSidebarTree(mixed, [group('tb-z', 'z', ['tm-9'])], 'RVERL', {});
    const row = t[0].rows[0];
    expect(row.title.slice(row.matchStart, row.matchEnd)).toBe('rverL');
  });

  it('uses -1 for the match range when there is no query', () => {
    const t = buildSidebarTree(nodes, groups, '', cwds);
    expect(t[0].rows[0].matchStart).toBe(-1);
    expect(t[0].rows[0].matchEnd).toBe(-1);
  });

  it('adds a disambiguator only to titles that collide', () => {
    const t = buildSidebarTree(nodes, groups, '', cwds);
    const zshA = t[0].rows.find((r) => r.terminalId === 'tm-1')!;
    const server = t[0].rows.find((r) => r.terminalId === 'tm-2')!;
    const zshB = t[1].rows[0];
    expect(zshA.disambiguator).toBe('termflow-core');
    expect(zshB.disambiguator).toBe('termflow-site');
    expect(server.disambiguator).toBeNull();
  });

  // Collision is a property of the whole workspace, not of one group: two terminals both called
  // `zsh` in DIFFERENT tabs are exactly the case the feature exists for (design 010 §11).
  it('detects a collision across groups, not only within one', () => {
    const t = buildSidebarTree(nodes, groups, '', cwds);
    expect(t[0].rows.find((r) => r.terminalId === 'tm-1')!.disambiguator).not.toBeNull();
    expect(t[1].rows[0].disambiguator).not.toBeNull();
  });

  it('falls back to the shell when it tells the colliding titles apart', () => {
    const two = [node('tm-1', 'tb-a', 'zsh', 'pwsh'), node('tm-2', 'tb-b', 'zsh', 'bash')];
    const g = [group('tb-a', 'a', ['tm-1']), group('tb-b', 'b', ['tm-2'])];
    const rows = buildSidebarTree(two, g, '', {}).flatMap((x) => x.rows);
    expect(rows.map((r) => r.disambiguator)).toEqual(['pwsh', 'bash']);
  });

  it('falls back to shell then short id when no cwd is known', () => {
    const noCwd = [node('tm-1', 'tb-a', 'zsh', 'pwsh'), node('tm-2', 'tb-b', 'zsh', 'pwsh')];
    const g = [group('tb-a', 'a', ['tm-1']), group('tb-b', 'b', ['tm-2'])];
    const t = buildSidebarTree(noCwd, g, '', {});
    const all = t.flatMap((x) => x.rows);
    // Same shell for both, so the shell cannot disambiguate — fall through to the id.
    expect(all[0].disambiguator).toContain('tm-1');
    expect(all[1].disambiguator).toContain('tm-2');
  });

  // The three fallbacks are ordered by how much they tell the user. A cwd that is present but
  // useless (two terminals in the same directory) must not stop there — it would print the same
  // word twice and disambiguate nothing.
  it('does not stop at a cwd that both colliding terminals share', () => {
    const same = [node('tm-1', 'tb-a', 'zsh', 'pwsh'), node('tm-2', 'tb-b', 'zsh', 'bash')];
    const g = [group('tb-a', 'a', ['tm-1']), group('tb-b', 'b', ['tm-2'])];
    const shared = { 'tm-1': '/home/u/proj', 'tm-2': '/home/u/proj' };
    const rows = buildSidebarTree(same, g, '', shared).flatMap((x) => x.rows);
    expect(rows.map((r) => r.disambiguator)).toEqual(['pwsh', 'bash']);
  });

  it('returns an empty tree when nothing matches', () => {
    expect(buildSidebarTree(nodes, groups, 'zzzz', cwds)).toEqual([]);
  });

  it('ignores leading and trailing whitespace in the query', () => {
    expect(buildSidebarTree(nodes, groups, '  server  ', cwds)[0].rows).toHaveLength(1);
  });

  it('carries the activity flags each row needs to render', () => {
    const busy = [{ ...node('tm-1', 'tb-a', 'zsh'), isRunning: true, hasUnseenOutput: true }];
    const row = buildSidebarTree(busy, [group('tb-a', 'a', ['tm-1'])], '', {})[0].rows[0];
    expect(row.isRunning).toBe(true);
    expect(row.hasUnseenOutput).toBe(true);
  });

  // A group's `nodeIds` is a projection of its pane tree and can name a terminal that has just
  // been removed; skipping is what keeps a mid-dispatch render from throwing.
  it('skips a nodeId with no matching node', () => {
    const t = buildSidebarTree(nodes, [group('tb-a', 'api', ['tm-1', 'tm-ghost'])], '', cwds);
    expect(t[0].rows.map((r) => r.terminalId)).toEqual(['tm-1']);
  });

  it('does not mutate its inputs', () => {
    const before = JSON.stringify({ nodes, groups, cwds });
    buildSidebarTree(nodes, groups, 'zsh', cwds);
    expect(JSON.stringify({ nodes, groups, cwds })).toBe(before);
  });
});
