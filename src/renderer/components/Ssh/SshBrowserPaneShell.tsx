import React, { useState } from 'react';
import type { EditOpen } from './sshFileTypes';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { SshFileBrowser, SshFileBrowserView, type SshBrowserController, type SshFileBrowserProps } from './SshFileBrowser';
import { SshPaneShell, type SshPaneShellProps } from './SshPaneShell';
import { readReconnectCoordinator, readSshLaunchState } from './ssh066Contract';

type Props = SshFileBrowserProps & Omit<SshPaneShellProps,
  'browser' | 'browserHandlesOffline' | 'launchDisconnected' | 'browserCollapsed' | 'onBrowserCollapsedChange'> & {
  /**
   * The terminal's one file controller, owned by the pane composition (plan 070 §4.1 A).
   * `undefined` (only standalone tests) owns a controller here; `null` means this presentation
   * has no controller to show and renders the shell's unavailable browser instead of a second one.
   */
  browserController?: SshBrowserController | null;
};

// The SSH leaf supplies its existing terminal subtree as-is, and passes the owning tag and the
// visible-surface activity here. Pane and Canvas both render this; only one is interactive.
export function SshBrowserPaneShell({ terminalId, sshTag, surfaceActive, onPatchTag, onEntryContextMenu, onEditOpen, browserController, ...shell }: Props) {
  const [opened, setOpened] = useState<{ terminalId: string; result: EditOpen }>();
  const stage = useSelector((state: RootState) => readSshLaunchState(state, terminalId)?.stage);
  const launchDisconnected = stage === undefined || stage === 'ended' || stage === 'blocked'
    || stage === 'cancelled' || stage === 'error';
  const reconnect = readReconnectCoordinator();
  const editOpened = (result: EditOpen) => {
    setOpened({ terminalId, result });
    onEditOpen?.(result);
  };
  const browserProps = { terminalId, sshTag, surfaceActive, onPatchTag, onEntryContextMenu };
  return <SshPaneShell {...shell} editOpenResult={opened?.terminalId === terminalId ? opened.result : shell.editOpenResult}
    browserCollapsed={sshTag.browserCollapsed} browserHandlesOffline={browserController !== null}
    launchDisconnected={launchDisconnected}
    onBrowserCollapsedChange={browserCollapsed => onPatchTag({ browserCollapsed })}
    onReconnect={reconnect ? async () => {
      const result = await reconnect(terminalId);
      if (result.ok === false) throw new Error(result.error.message);
    } : shell.onReconnect}
    browser={browserController === null ? undefined
      : browserController ? <SshFileBrowserView {...browserProps} browser={browserController} onEditOpen={editOpened} />
      : <SshFileBrowser {...browserProps} onEditOpen={editOpened} />} />;
}
