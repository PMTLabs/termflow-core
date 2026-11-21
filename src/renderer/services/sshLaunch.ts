import { browserSshBridge } from '../api/sshBridge';
import { store } from '../store';
import { addTabTree } from '../store/slices/panesSlice';
import { applyView } from '../store/slices/sshSlice';
import { addTab } from '../store/slices/tabsSlice';
import { setNodeGeom } from '../store/slices/canvasSlice';
import type { Rect } from '../components/Canvas/canvasGeometry';
import { generateId } from '../utils/id';
import { buildNewTabFields } from './newTabActions';
import { getTabPanesGlobal } from './tabPanesStore';

export type SshLaunchPlacement = { kind: 'tab' } | { kind: 'canvas'; rect: Rect; sourceTerminalId?: string };
export type SshLaunchInsertion =
  | { ok: false; error: { code: 'desktop-only' | 'NotFound' | 'MissingDefaultProfile'; message: string } }
  | { ok: true; tabId: string; paneId: string; terminalId: string; placement: SshLaunchPlacement;
      recent: Promise<{ ok: true } | { ok: false; message: string }> };

/** Commit the leaf before the tab becomes renderable. Canvas callers own selection/camera and wiring. */
export function launchSshConnection(connectionId: string, placement: SshLaunchPlacement = { kind: 'tab' }): SshLaunchInsertion {
  const ssh = window.electronAPI?.ssh;
  if (!ssh || ssh === browserSshBridge) {
    return { ok: false, error: { code: 'desktop-only', message: 'SSH connections require the desktop app.' } };
  }
  const state = store.getState();
  if (!state.ssh.view.connections.some(connection => connection.id === connectionId)) {
    return { ok: false, error: { code: 'NotFound', message: 'This saved SSH connection is unavailable.' } };
  }
  // Ordinary tabs may fall back to the first profile. A saved SSH invocation must not.
  const { defaultProfile, shellProfiles } = state.settings;
  const profile = defaultProfile ? shellProfiles.find(p => p.id === defaultProfile) : undefined;
  if (!profile) {
    return { ok: false, error: { code: 'MissingDefaultProfile', message: 'Select a default shell profile before launching SSH.' } };
  }

  const tab = buildNewTabFields(profile, state.tabs.tabs.map(t => t.title));
  const terminalId = generateId('tm');
  const paneId = generateId('pn');
  const tree = {
    id: paneId, type: 'terminal' as const, terminalId, seededForTabId: tab.id,
    name: tab.title, shellType: profile.id,
    ssh: { connectionId, browserCollapsed: false, followCd: false, hiddenMetrics: [] },
  };
  getTabPanesGlobal()[tab.id] = tree;
  store.dispatch(addTabTree({ tabId: tab.id, tree }));
  if (placement.kind === 'canvas') store.dispatch(setNodeGeom({ id: terminalId, rect: placement.rect }));
  store.dispatch(addTab({ ...tab, isActive: placement.kind !== 'canvas' }));

  const recent = ssh.markUsed(connectionId).then(reply => {
    store.dispatch(applyView(reply));
    return { ok: true as const };
  }, () => ({ ok: false as const, message: 'Recent could not be updated.' }));
  return { ok: true, tabId: tab.id, paneId, terminalId, placement, recent };
}
