import { store } from '../store';
import { selectFolderConnectionIds } from '../store/slices/sshSlice';
import { launchSshConnection } from './sshLaunch';
import { sshPickerUnavailable } from './sshPicker';

export interface ConnectAllFailure { id: string; name: string; message: string }
export interface ConnectAllSummary {
  folderId: string;
  /** Every id dispatched to the launcher, whatever happened next. */
  attempted: number;
  /** Tabs actually inserted. A tab is an attempt in progress, never a confirmed connection. */
  started: number;
  failures: ConnectAllFailure[];
  recentFailures: { id: string; name: string }[];
  message: string;
}
export interface ConnectOutcome { error: string | null; recentFailed: boolean }

const inFlight = new Set<string>();

function summarize(folderId: string, attempted: number, started: number, failures: ConnectAllFailure[], recentFailures: { id: string; name: string }[]): ConnectAllSummary {
  const parts = [`Opened ${started} of ${attempted} SSH tab${attempted === 1 ? '' : 's'}; each tab shows its own result.`];
  if (failures.length) parts.push(`Could not start: ${failures.map(f => `${f.name} (${f.message})`).join('; ')}.`);
  if (recentFailures.length) parts.push(`Recent could not be updated for: ${recentFailures.map(f => f.name).join(', ')}.`);
  return { folderId, attempted, started, failures, recentFailures, message: parts.join(' ') };
}

/**
 * Connect all in tabs for ONE folder click. The id list is snapshotted once from the clicked folder (never the
 * selection or the filter); each id is re-resolved by the launcher at dispatch time, so a connection deleted
 * mid-batch fails by name while the other tabs stay. Launches run one at a time. A second click for the same
 * folder while this one is pending returns null; once it settles a deliberate click starts a new set.
 */
export async function connectAllInTabs(
  folderId: string,
  launch = launchSshConnection,
  unavailable = sshPickerUnavailable,
): Promise<ConnectAllSummary | null> {
  if (inFlight.has(folderId)) return null;
  inFlight.add(folderId);
  try {
    const state = store.getState();
    const blocked = unavailable(state);
    if (blocked) return { folderId, attempted: 0, started: 0, failures: [], recentFailures: [], message: blocked };
    const ids = selectFolderConnectionIds(state.ssh.view, folderId);
    const names = new Map(state.ssh.view.connections.map(c => [c.id, c.name]));
    const failures: ConnectAllFailure[] = [];
    const recentFailures: { id: string; name: string }[] = [];
    let started = 0;
    for (const id of ids) {
      const name = names.get(id) ?? id;
      const result = launch(id);
      if (!result.ok) { failures.push({ id, name, message: result.error.message }); continue; }
      started += 1;
      const recent = await result.recent;
      if (!recent.ok) recentFailures.push({ id, name });
    }
    return summarize(folderId, ids.length, started, failures, recentFailures);
  } finally {
    inFlight.delete(folderId);
  }
}

/** Single Settings connect of a SAVED id. `error` is set when no tab was opened. */
export async function connectSavedInTab(id: string, launch = launchSshConnection, unavailable = sshPickerUnavailable): Promise<ConnectOutcome> {
  const blocked = unavailable(store.getState());
  if (blocked) return { error: blocked, recentFailed: false };
  const result = launch(id);
  if (!result.ok) return { error: result.error.message, recentFailed: false };
  const recent = await result.recent;
  return { error: null, recentFailed: !recent.ok };
}
