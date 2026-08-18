import type { CanvasGroupModel, CanvasNodeModel } from './canvasSelectors';

export interface SidebarRow {
  terminalId: string;
  title: string;
  /** -1 when there is no active query. */
  matchStart: number;
  matchEnd: number;
  /** Set only when another terminal shares this title. */
  disambiguator: string | null;
  isRunning: boolean;
  hasUnseenOutput: boolean;
}

export interface SidebarGroup {
  tabId: string;
  title: string;
  rows: SidebarRow[];
}

/** Last path segment, for either separator. Empty for a bare root — a disambiguator of `/`
 *  next to a terminal name would be noise rather than information. */
export function basename(path: string): string {
  if (!path) return '';
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  const last = parts[parts.length - 1] ?? '';
  // `C:\` trims to `C:`, which is a drive rather than a directory anyone would recognise.
  return /^[A-Za-z]:$/.test(last) ? '' : last;
}

/**
 * Group → Terminal tree, filtered by title — `plan/013` Task 14.
 *
 * Duplicate titles are the normal case rather than an edge one (four terminals all called
 * `zsh`), so colliding rows carry a disambiguator. The three fallbacks are ordered by how much
 * they actually tell the user: the cwd's basename, then the shell, then a short id — and each
 * is used only when it DISTINGUISHES, so two terminals sharing a directory fall through to the
 * shell rather than printing the same word twice.
 *
 * Collision is a property of the whole workspace, not of one group: two `zsh` in different tabs
 * are exactly the case this exists for.
 */
export function buildSidebarTree(
  nodes: CanvasNodeModel[],
  groups: CanvasGroupModel[],
  query: string,
  cwds: Record<string, string>,
): SidebarGroup[] {
  const q = query.trim().toLowerCase();

  const titleCounts = new Map<string, number>();
  for (const n of nodes) titleCounts.set(n.title, (titleCounts.get(n.title) ?? 0) + 1);

  const collides = (n: CanvasNodeModel) => (titleCounts.get(n.title) ?? 0) > 1;

  // How many colliding terminals share each (title, cwd) and each (title, shell) pair. A
  // fallback is only worth using when its count is 1 — i.e. when it singles this row out.
  const cwdCounts = new Map<string, number>();
  const shellCounts = new Map<string, number>();
  for (const n of nodes) {
    if (!collides(n)) continue;
    const c = `${n.title}\u0000${basename(cwds[n.terminalId] ?? '')}`;
    cwdCounts.set(c, (cwdCounts.get(c) ?? 0) + 1);
    const s = `${n.title}\u0000${n.shellType}`;
    shellCounts.set(s, (shellCounts.get(s) ?? 0) + 1);
  }

  const disambiguate = (n: CanvasNodeModel): string | null => {
    if (!collides(n)) return null;
    const cwd = basename(cwds[n.terminalId] ?? '');
    if (cwd && cwdCounts.get(`${n.title}\u0000${cwd}`) === 1) return cwd;
    if (n.shellType && shellCounts.get(`${n.title}\u0000${n.shellType}`) === 1) return n.shellType;
    return n.terminalId.slice(0, 8);
  };

  const byId = new Map(nodes.map((n) => [n.terminalId, n]));
  const out: SidebarGroup[] = [];

  for (const g of groups) {
    const rows: SidebarRow[] = [];
    for (const id of g.nodeIds) {
      // `nodeIds` is a projection of the pane tree and can name a terminal that has just been
      // removed; skipping is what keeps a mid-dispatch render from throwing.
      const n = byId.get(id);
      if (!n) continue;

      let matchStart = -1;
      if (q) {
        matchStart = n.title.toLowerCase().indexOf(q);
        if (matchStart < 0) continue;
      }

      rows.push({
        terminalId: n.terminalId,
        title: n.title,
        matchStart,
        matchEnd: matchStart < 0 ? -1 : matchStart + q.length,
        disambiguator: disambiguate(n),
        isRunning: n.isRunning,
        hasUnseenOutput: n.hasUnseenOutput,
      });
    }

    // A group emptied by the QUERY is hidden; a group that was empty to begin with is kept.
    //
    // `buildModel` goes out of its way to keep an emptied tab's frame on the canvas, because
    // design 010 §6.3/§10 makes it a drop target — and Task 15 adds a sidebar drag onto a group
    // header, which needs a header to aim at. Hiding it here would be the same bug one layer
    // up: a group still visible on the canvas that the list can no longer reach.
    if (rows.length || (!q && !g.nodeIds.length)) {
      out.push({ tabId: g.tabId, title: g.title, rows });
    }
  }

  return out;
}
