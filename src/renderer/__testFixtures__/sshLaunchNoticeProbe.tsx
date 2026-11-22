import React from 'react';
import { createPortal } from 'react-dom';
import { useSelector } from 'react-redux';
import type { RootState } from '../store';
import { useSurfaceHost } from '../services/surfaceHosts';
import { SshLaunchNotice } from '../components/Ssh/SshLaunchNotice';
import type { LaunchSnapshot, SshPromptReceipt } from '../types/ssh';

/**
 * 066's `OwnedSshLaunchNotice` PLACEMENT around the real `SshLaunchNotice` (D51): portalled to the
 * surface host's parent while Canvas hosts the terminal, rendered in place (the pane) otherwise.
 * The owned wrapper needs 066's launch plumbing (pane incarnations, launch queries), so tests use
 * this probe; `sshCanvasPromptOwnership.test` pins the placement rule to the owned wrapper's source.
 */
export const OWNED_NOTICE_PLACEMENT = 'surface?.parentElement ? createPortal(notice, surface.parentElement) : notice';

export function LaunchNoticeProbe({ terminalId, stage = 'waiting-trust', onTrust, onReconnect }: {
  terminalId: string;
  stage?: LaunchSnapshot['stage'];
  onTrust(receipt: SshPromptReceipt): Promise<void>;
  onReconnect?(): void;
}) {
  const view = useSelector((state: RootState) => state.sshSession.byTerminal[terminalId]?.session);
  const surface = useSurfaceHost(terminalId);
  const generation = view?.generation ?? 1;
  const snapshot: LaunchSnapshot = {
    terminalId, connectionId: view?.connectionId ?? 'conn-probe', launchSeq: 1, revision: 1, stage,
    attempt: { sessionGeneration: generation, attemptReceipt: { generation, gate: 'pending' },
      processIncarnation: 'pc-probe', ownerIncarnation: { pg: 1, seq: 1 } },
  };
  const notice = <SshLaunchNotice snapshot={snapshot} view={view} onCancel={() => undefined}
    onReconnect={onReconnect ?? (() => undefined)} onTrust={onTrust} onSecret={async () => undefined} />;
  return surface?.parentElement ? createPortal(notice, surface.parentElement) : notice;
}
