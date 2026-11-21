import { store } from '../store';
import { applyView } from '../store/slices/sshSlice';
import { setDefaultProfile, setShellProfiles } from '../store/slices/settingsSlice';
import type { SshConnection, SshFolder } from '../types/ssh';

export const profile = { id: 'shell', name: 'Local Shell', path: '/bin/bash', args: [], env: {}, icon: 'bash' };
export const otherProfile = { ...profile, id: 'other', name: 'Other Shell' };
export const saved = (id: string, patch: Partial<SshConnection> = {}): SshConnection => ({
  id, name: id, host: `${id}.example`, port: 22, user: 'tester', auth: 'agent', identityFile: null,
  jumpConnectionId: null, extraOptions: [], folderId: null, order: 0, bookmarked: false,
  hasSavedSecret: false, lastUsedAt: null, ...patch,
});
export const replaceSaved = (connections: SshConnection[], folders: SshFolder[] = [], revision = store.getState().ssh.revision + 1) =>
  store.dispatch(applyView({ revision, view: { revision, connections, folders, loadError: null } }));

export function preparePicker() {
  const api = {
    sshSessionOpen: jest.fn(),
    sshSessionState: jest.fn(),
    setDefaultProfile: jest.fn(),
    ssh: { launchTerminal: jest.fn(), markUsed: jest.fn(() => new Promise(() => {})) },
  };
  Object.defineProperty(window, 'electronAPI', { configurable: true, writable: true, value: api });
  store.dispatch(setShellProfiles([otherProfile, profile]));
  store.dispatch(setDefaultProfile(profile.id));
  replaceSaved([]);
  return api;
}

export function key(target: EventTarget, name: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

export function button(text: string, root: ParentNode = document) {
  const el = Array.from(root.querySelectorAll('button')).find(el => el.textContent?.includes(text));
  if (!el) throw new Error(`Missing button: ${text}`);
  return el;
}
