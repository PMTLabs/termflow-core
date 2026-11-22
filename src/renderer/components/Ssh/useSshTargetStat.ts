import { useEffect, useState } from 'react';
import type { RemoteStat } from './sshFileTypes';
import type { SshRowScope } from './useSshFileBrowser';
import { operationError } from './sshFileFeedback';

export const staleTarget = 'The remote listing changed. Reopen the action from a live listing.';

export async function statTarget(scope: SshRowScope): Promise<RemoteStat> {
  if (!scope.isLive()) throw new Error(staleTarget);
  const stat = await scope.api.fsStat(scope.request);
  if (!scope.isLive()) throw new Error(staleTarget);
  return stat;
}

export function useSshTargetStat(scope: SshRowScope) {
  const [stat, setStat] = useState<RemoteStat>();
  const [loadError, setLoadError] = useState<string>();
  useEffect(() => {
    let active = true;
    void statTarget(scope).then(value => {
      if (active) setStat(value);
    }, failure => {
      if (active) setLoadError(operationError(failure, scope.request.path));
    });
    return () => { active = false; };
  }, [scope]);
  return { stat, setStat, loadError };
}
