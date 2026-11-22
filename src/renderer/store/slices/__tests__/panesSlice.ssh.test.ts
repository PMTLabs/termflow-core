import reducer, {
  addTabTree, closePane, initializePane, insertPaneIntoTab, movePaneToTab, movePaneWithinTab,
  patchSshPaneTag, removePaneFromTab, selectSshHiddenMetrics, setActiveTabId, setPaneTree, setSshHiddenMetrics,
  splitPane, splitPaneInTab, splitPaneWithTab,
} from '../panesSlice';
import { findLeaf } from '../paneTreeOps';
import { sanitizePaneTreeSshFields } from '../../../services/sshPanePersistence';
import { METRIC_KEYS, type MetricKey } from '../../../types/ssh';
import { planSeeds } from '../../../services/tabTreeSeed';
import { expectPaneTags, other, pane, sentinel, taggedTree, tags } from '../../../__testFixtures__/sshPaneCensus';

const init = () => reducer(undefined, { type: 'init' });
const active = () => reducer(init(), setActiveTabId('tb-a'));
const seeded = () => reducer(active(), setPaneTree(taggedTree()));

test.each(['initializePane', 'splitPaneInTab (null)', 'planSeeds'] as const)(
  'all_local_seed_factories_have_no_ssh_tag (%s)', factory => {
    let state = reducer(seeded(), setActiveTabId('tb-new'));
    if (factory === 'planSeeds') {
      const [plan] = planSeeds([{ id: 'tb-new', shellType: 'default' }], state.treesByTabId, {});
      state = reducer(state, addTabTree(plan));
    } else if (factory === 'initializePane') {
      state = reducer(state, initializePane({ terminalId: 'tm-new' }));
    } else {
      state = reducer(state, addTabTree({ tabId: 'tb-new', tree: null }));
      state = reducer(state, splitPaneInTab({ tabId: 'tb-new', paneId: '', direction: 'vertical', terminalId: 'tm-new' }));
    }
    const root = state.treesByTabId['tb-new']!;
    expect(root.terminalId).toMatch(/^tm-/);
    expectPaneTags(Object.values(state.treesByTabId), tags, ['tm-local', root.terminalId!]);
  },
);

describe.each(['horizontal', 'vertical'] as const)('%s', direction => {
  test.each(['splitPane', 'splitPaneInTab', 'UI before', 'UI after'] as const)(
    'every_split_entry_preserves_only_survivor_ssh (%s)', entry => {
      const args = { paneId: 'pn-ssh', direction, terminalId: 'tm-new' };
      const action = entry === 'splitPane' ? splitPane(args)
        : entry === 'splitPaneInTab' ? splitPaneInTab({ ...args, tabId: 'tb-a' })
        : { type: splitPaneWithTab.fulfilled.type, payload: {
          ...args, position: entry === 'UI before' ? 'before' : 'after',
          shellType: 'default', newTerminalId: 'tm-new', uniqueTitle: 'new', uniqueOriginalTitle: 'old',
        } };
      const state = reducer(seeded(), action);
      expectPaneTags([state.treesByTabId['tb-a']], tags, ['tm-local', 'tm-new']);
      expect(state.paneTree).toEqual(state.treesByTabId['tb-a']);
      const children = state.paneTree?.children?.[0].children;
      expect(children?.map(child => child.terminalId)).toEqual(entry === 'UI before'
        ? ['tm-new', 'tm-ssh'] : ['tm-ssh', 'tm-new']);
    },
  );
});

test('patch_ssh_tag_refreshes_active_mirror_and_untagged_is_noop', () => {
  const state = seeded();
  expect(reducer(state, patchSshPaneTag({ terminalId: 'tm-local', patch: { followCd: true } }))).toBe(state);
  const next = reducer(state, patchSshPaneTag({ terminalId: 'tm-ssh', patch: { browserPath: undefined, browserCollapsed: false } }));
  const { browserPath: _removed, ...rest } = sentinel;
  expectPaneTags([next.paneTree], { ...tags, 'tm-ssh': { ...rest, browserCollapsed: false } }, ['tm-local']);
  expect(JSON.stringify(next.paneTree)).toBe(JSON.stringify(next.treesByTabId['tb-a']));
});

test.each(['active', 'background'] as const)(
  'closing_local_sibling_preserves_ssh_survivor_and_empty_semantics (%s)', where => {
    const remove = (paneId: string) => where === 'active' ? closePane(paneId) : removePaneFromTab({ tabId: 'tb-a', paneId });
    let state = seeded();
    if (where === 'background') state = reducer(state, setActiveTabId('tb-b'));
    state = reducer(state, remove('pn-local'));
    expectPaneTags([state.treesByTabId['tb-a']], tags);
    expect(state.treesByTabId['tb-a']?.children?.map(node => node.id)).toEqual(['pn-ssh', 'pn-other']);
    state = reducer(reducer(state, remove('pn-ssh')), remove('pn-other'));
    expect(state.treesByTabId).toStrictEqual({ 'tb-a': null });
  },
);

test('ssh_tag_follows_terminal_through_insert_move_and_swap', () => {
  let state = seeded();
  state = reducer(state, insertPaneIntoTab({ tabId: 'tb-a', targetPaneId: 'pn-ssh', zone: 'left', node: pane('new') }));
  expectPaneTags([state.paneTree], tags, ['tm-local', 'tm-new']);
  state = reducer(state, movePaneWithinTab({ tabId: 'tb-a', sourcePaneId: 'pn-ssh', targetPaneId: 'pn-local', zone: 'bottom' }));
  expectPaneTags([state.paneTree], tags, ['tm-local', 'tm-new']);
  state = reducer(state, movePaneWithinTab({ tabId: 'tb-a', sourcePaneId: 'pn-ssh', targetPaneId: 'pn-new', zone: 'center' }));
  expectPaneTags([state.paneTree], tags, ['tm-local', 'tm-new']);
  expect(findLeaf(state.paneTree, 'pn-new')).toMatchObject({ terminalId: 'tm-ssh', ssh: sentinel });
  expect(findLeaf(state.paneTree, 'pn-ssh')).not.toHaveProperty('ssh');
  state = reducer(state, movePaneWithinTab({ tabId: 'tb-a', sourcePaneId: 'pn-new', targetPaneId: 'pn-other', zone: 'center' }));
  expectPaneTags([state.paneTree], tags, ['tm-local', 'tm-new']);
  expect(findLeaf(state.paneTree, 'pn-new')).toMatchObject({ terminalId: 'tm-other', ssh: other });
});

test('toggle_targets_background_terminal_not_active_pane', () => {
  const a = pane('ssh', sentinel);
  const b = pane('other', other);
  let state = reducer(active(), setPaneTree(a));
  state = reducer(state, addTabTree({ tabId: 'tb-b', tree: b }));
  const updatedB = pane('other', { ...other, hiddenMetrics: ['ram'] });
  const background = reducer(state, setSshHiddenMetrics({ terminalId: 'tm-other', hiddenMetrics: ['ram'] }));
  expect(background.treesByTabId).toStrictEqual({ 'tb-a': a, 'tb-b': updatedB });
  expect(background.paneTree).toBe(state.paneTree);
  const updatedA = pane('ssh', { ...sentinel, hiddenMetrics: ['host'] });
  const foreground = reducer(background, setSshHiddenMetrics({ terminalId: 'tm-ssh', hiddenMetrics: ['host'] }));
  expect(foreground.treesByTabId).toStrictEqual({ 'tb-a': updatedA, 'tb-b': updatedB });
  expect(foreground.paneTree).toStrictEqual(updatedA);
});

test('toggle_preserves_concurrent_browser_path_and_follow_cd', () => {
  const patch = { browserPath: '/new', followCd: false, browserCollapsed: false };
  const state = reducer(seeded(), patchSshPaneTag({ terminalId: 'tm-ssh', patch }));
  const action = setSshHiddenMetrics({ terminalId: 'tm-ssh', hiddenMetrics: ['ram'] });
  const next = reducer(state, { ...action, payload: {
    ...action.payload, connectionId: 'wrong', browserPath: '/stale', followCd: true, browserCollapsed: true,
  } });
  expectPaneTags([next.paneTree], { ...tags, 'tm-ssh': { ...sentinel, ...patch, hiddenMetrics: ['ram'] } }, ['tm-local']);
});

test('missing_unknown_and_duplicate_keys_normalize_safely', () => {
  const state = seeded();
  const select = (panes: typeof state, id = 'tm-ssh') => selectSshHiddenMetrics({ panes }, id);
  for (const id of ['tm-local', 'tm-unknown']) {
    expect(select(state, id)).toEqual([]);
    expect(reducer(state, setSshHiddenMetrics({ terminalId: id, hiddenMetrics: ['cpu'] }))).toBe(state);
  }
  for (const [input, expected] of [[undefined, []], [['nfs', 'unknown', 'cpu', 'nfs'], ['nfs', 'cpu']]] as const) {
    const hiddenMetrics = input as unknown as readonly MetricKey[];
    expect(select(reducer(state, setSshHiddenMetrics({ terminalId: 'tm-ssh', hiddenMetrics })))).toEqual(expected);
    const legacy = pane('ssh', { ...sentinel, hiddenMetrics: hiddenMetrics as MetricKey[] });
    if (input === undefined) expect(select(reducer(active(), setPaneTree(legacy)))).toEqual([]);
    const restored = sanitizePaneTreeSshFields(JSON.parse(JSON.stringify(legacy)));
    expect(restored?.ssh?.hiddenMetrics).toEqual(expected);
    expect(select(reducer(active(), setPaneTree(restored)))).toEqual(expected);
  }
});

test('all_hidden_can_reset_to_defaults', () => {
  const set = (hiddenMetrics: readonly MetricKey[]) => setSshHiddenMetrics({ terminalId: 'tm-ssh', hiddenMetrics });
  const hidden = reducer(seeded(), set(METRIC_KEYS));
  expect(selectSshHiddenMetrics({ panes: hidden }, 'tm-ssh')).toEqual(METRIC_KEYS);
  const reset = reducer(hidden, set([]));
  expect(selectSshHiddenMetrics({ panes: reset }, 'tm-ssh')).toEqual([]);
  expectPaneTags([reset.paneTree], { ...tags, 'tm-ssh': { ...sentinel, hiddenMetrics: [] } }, ['tm-local']);
});

// The all-hidden hit target and Reset are exercised in SshMetricsStatusBar.test.tsx.

test('hidden_metrics_follow_terminal_through_split_swap_and_restore', () => {
  const expected = { ...tags, 'tm-ssh': { ...sentinel, hiddenMetrics: ['netUp', 'ram'] as MetricKey[] } };
  let state = reducer(seeded(), setSshHiddenMetrics({ terminalId: 'tm-ssh', hiddenMetrics: ['netUp', 'ram'] }));
  state = reducer(state, splitPane({ paneId: 'pn-ssh', direction: 'vertical', terminalId: 'tm-new' }));
  expectPaneTags([state.paneTree], expected, ['tm-local', 'tm-new']);
  const ssh = state.paneTree?.children?.[0].children?.find(node => node.terminalId === 'tm-ssh');
  expect(ssh).toBeDefined();
  state = reducer(state, movePaneWithinTab({ tabId: 'tb-a', sourcePaneId: ssh!.id, targetPaneId: 'pn-other', zone: 'center' }));
  expect(findLeaf(state.paneTree, 'pn-other')?.terminalId).toBe('tm-ssh');
  const restored = sanitizePaneTreeSshFields(JSON.parse(JSON.stringify(state.treesByTabId['tb-a'])));
  expectPaneTags([restored], expected, ['tm-local', 'tm-new']);
});

test('cross_tab_move_keeps_ssh_and_does_not_resurrect_source', () => {
  let state = seeded();
  state = reducer(state, addTabTree({ tabId: 'tb-empty', tree: null }));
  state = reducer(state, addTabTree({ tabId: 'tb-solo', tree: pane('mover', sentinel) }));
  state = reducer(state, movePaneToTab({
    sourceTabId: 'tb-solo', sourcePaneId: 'pn-mover', targetTabId: 'tb-empty', targetPaneId: '', zone: 'right',
  }));
  expect(state.treesByTabId['tb-solo']).toBeNull();
  expectPaneTags([state.treesByTabId['tb-empty']], { 'tm-mover': sentinel });
  state = reducer(state, movePaneToTab({
    sourceTabId: 'tb-empty', sourcePaneId: 'pn-mover', targetTabId: 'tb-a', targetPaneId: 'pn-local', zone: 'right',
  }));
  expect(state.treesByTabId['tb-empty']).toBeNull();
  expect(planSeeds([{ id: 'tb-solo' }, { id: 'tb-empty' }], state.treesByTabId, {})).toEqual([]);
  expectPaneTags(Object.values(state.treesByTabId), { ...tags, 'tm-mover': sentinel }, ['tm-local']);
});
