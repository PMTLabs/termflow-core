import { savedSshConnectionIssue, type SavedSshConnectionIssue } from './savedSshConnectionIssue';
import { browserSshBridge } from '../api/sshBridge';
import { store } from '../store';
import { addTabTree } from '../store/slices/panesSlice';
import { applyView } from '../store/slices/sshSlice';
import { addTab } from '../store/slices/tabsSlice';
import { setNodeGeom } from '../store/slices/canvasSlice';
import type { Rect } from '../components/Canvas/canvasGeometry';
import { generateId } from '../utils/id';
import { buildNewTabFields, resolveDefaultProfile } from './newTabActions';
import { terminalService } from './TerminalService';
import { sshLaunchObserved } from '../store/slices/sshSessionSlice';
import { addToast } from '../store/slices/uiSlice';
import type { ReconnectSshResult } from './sshLaunchAttempt';
import { getTabPanesGlobal } from './tabPanesStore';

export function reconnectSshTerminal(terminalId: string): Promise<ReconnectSshResult> {
  return terminalService.reconnectSshTerminal(terminalId, snapshot => {
    store.dispatch(sshLaunchObserved(snapshot));
    const recentFailed = () => store.dispatch(addToast({ message: 'Recent could not be updated.', type: 'warning' }));
    void window.electronAPI.ssh?.markUsed(snapshot.connectionId).then(reply => store.dispatch(applyView(reply)), recentFailed);
  });
}

export type SshLaunchPlacement = { kind: 'tab' } | { kind: 'canvas'; rect: Rect; sourceTerminalId?: string };
export type SshLaunchInsertion =
  | { ok: false; error: SavedSshConnectionIssue | { code: 'desktop-only' | 'MissingDefaultProfile'; message: string } }
  | { ok: true; tabId: string; paneId: string; terminalId: string; placement: SshLaunchPlacement;
      recent: Promise<{ ok: true } | { ok: false; message: string }> };

/** Commit the leaf before the tab becomes renderable. Canvas callers own selection/camera and wiring. */
export function launchSshConnection(connectionId: string, placement: SshLaunchPlacement = { kind: 'tab' }): SshLaunchInsertion {
  const ssh = window.electronAPI?.ssh;
  if (!ssh || ssh === browserSshBridge) {
    return { ok: false, error: { code: 'desktop-only', message: 'SSH connections require the desktop app.' } };
  }
  const state = store.getState();
  const connection = state.ssh.view.connections.find(c => c.id === connectionId);
  const issue = savedSshConnectionIssue(state.ssh, connectionId);
  if (issue) return { ok: false, error: issue };
  if (!connection) throw new Error('Expected the resolved SSH connection');
  // Plan 066 §4.1: the same default-profile resolution as an ordinary new tab,
  // never a profile chosen from the connection.
  const { defaultProfile, shellProfiles } = state.settings;
  const profile = resolveDefaultProfile(shellProfiles, defaultProfile);
  if (!profile) {
    return { ok: false, error: { code: 'MissingDefaultProfile', message: 'Add a shell profile before launching SSH.' } };
  }

  // Unique connection-name title; the profile still decides shell, cwd and env.
  const tab = buildNewTabFields({ id: profile.id, name: connection.name }, state.tabs.tabs.map(t => t.title));
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
