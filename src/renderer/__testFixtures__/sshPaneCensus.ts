import type { PaneNode } from '../store/slices/panesSlice';
import type { SshPaneTag } from '../types/ssh';

export const sentinel: SshPaneTag = {
  connectionId: 'saved', browserWidth: 340, browserCollapsed: true, browserPath: '/srv/a b',
  followCd: true, hiddenMetrics: ['nfs', 'cpu'],
};
export const other: SshPaneTag = {
  connectionId: 'other', browserCollapsed: false, browserPath: '/home/other',
  followCd: false, hiddenMetrics: ['uptime'],
};
export const tags = { 'tm-ssh': sentinel, 'tm-other': other };

export const pane = (name: string, ssh?: SshPaneTag): PaneNode => ({
  type: 'terminal', id: 'pn-' + name, terminalId: 'tm-' + name, ...(ssh ? { ssh } : {}),
});
export const split = (name: string, ...children: PaneNode[]): PaneNode =>
  ({ type: 'split', id: 'pn-' + name, direction: 'horizontal', size: 50, children });
export const taggedTree = () => split('group', pane('ssh', sentinel), split('siblings', pane('local'), pane('other', other)));

/** Asserts all leaf identities (including untagged siblings), all preference bytes, and no container tags. */
export function expectPaneTags(
  trees: readonly (PaneNode | null | undefined)[],
  tagged: Record<string, SshPaneTag>,
  local: readonly string[] = [],
) {
  const all: Record<string, SshPaneTag | undefined> = {};
  const walk = (node: PaneNode | null | undefined) => {
    if (!node) return;
    if (node.type !== 'terminal') {
      expect(node).not.toHaveProperty('ssh');
      node.children?.forEach(walk);
      return;
    }
    expect(node.terminalId).toBeTruthy();
    expect(all).not.toHaveProperty(node.terminalId!);
    if (!node.ssh) expect(node).not.toHaveProperty('ssh');
    all[node.terminalId!] = node.ssh;
  };
  trees.forEach(walk);
  expect(all).toStrictEqual({ ...Object.fromEntries(local.map(id => [id, undefined])), ...tagged });
}
