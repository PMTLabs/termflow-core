import React from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { SshFileBrowser, type SshFileBrowserProps } from './SshFileBrowser';
import { SshPaneShell, type SshPaneShellProps } from './SshPaneShell';
import { readReconnectCoordinator, readSshLaunchState } from './ssh066Contract';

type Props = SshFileBrowserProps & Omit<SshPaneShellProps,
  'browser' | 'browserHandlesOffline' | 'launchDisconnected' | 'browserCollapsed' | 'onBrowserCollapsedChange'>;

// TerminalPane doesn't compose 067's shell yet. The SSH leaf supplies its existing
// terminal subtree as-is, and passes the owning tag and visible-surface activity here.
export function SshBrowserPaneShell({ terminalId, sshTag, surfaceActive, onPatchTag, onEntryContextMenu, ...shell }: Props) {
  const stage = useSelector((state: RootState) => readSshLaunchState(state, terminalId)?.stage);
  const launchDisconnected = stage === undefined || stage === 'ended' || stage === 'blocked'
    || stage === 'cancelled' || stage === 'error';
  const reconnect = readReconnectCoordinator();
  return <SshPaneShell {...shell} browserCollapsed={sshTag.browserCollapsed} browserHandlesOffline
    launchDisconnected={launchDisconnected}
    onBrowserCollapsedChange={browserCollapsed => onPatchTag({ browserCollapsed })}
    onReconnect={reconnect ? async () => {
      const result = await reconnect(terminalId);
      if (result.ok === false) throw new Error(result.error.message);
    } : shell.onReconnect}
    browser={<SshFileBrowser terminalId={terminalId} sshTag={sshTag} surfaceActive={surfaceActive}
      onPatchTag={onPatchTag} onEntryContextMenu={onEntryContextMenu} />} />;
}
