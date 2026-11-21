import { selectSshLaunch, sshLaunchObserved, sshLaunchReducer, sshOwnersChanged } from './sshSessionSlice';
import type { LaunchSnapshot } from '../../types/ssh';

const base: LaunchSnapshot = {
  terminalId: 'tm-a', connectionId: 'c-a', launchSeq: 4, revision: 7, stage: 'waiting-trust',
  attempt: { sessionGeneration: 3, attemptReceipt: { generation: 3, gate: 'blocked' },
    processIncarnation: 'pc-a', ownerIncarnation: { pg: 2, seq: 3 } },
};
const initial = () => sshLaunchReducer(sshLaunchReducer(undefined, sshOwnersChanged({ 'tm-a': 'c-a' })), sshLaunchObserved(base));

test.each([
  ['generation', { ...base, attempt: { ...base.attempt, sessionGeneration: 2 }, launchSeq: 99, revision: 99 }],
  ['launch sequence', { ...base, launchSeq: 3, revision: 99 }],
  ['revision', { ...base, revision: 6 }],
] as const)('older %s cannot overwrite a newer SSH launch', (_field, old) => {
  const current = initial();
  expect(sshLaunchReducer(current, sshLaunchObserved({ ...old, stage: 'ended' }))).toBe(current);
  const fresh = sshLaunchReducer(current, sshLaunchObserved({ ...base, revision: 8, stage: 'running' }));
  expect(selectSshLaunch({ sshLaunch: fresh }, 'tm-a')?.stage).toBe('running');
});

test('selectSshLaunch exposes only ordered lifecycle fields and drops retired owners', () => {
  const running = sshLaunchReducer(initial(), sshLaunchObserved({ ...base, launchSeq: 5, stage: 'running' }));
  expect(selectSshLaunch({ sshLaunch: running }, 'tm-a')).toEqual({ stage: 'running', sessionGeneration: 3, launchSeq: 5, revision: 7 });
  const ended = sshLaunchReducer(running, sshLaunchObserved({ ...base, launchSeq: 6, stage: 'ended' }));
  expect(selectSshLaunch({ sshLaunch: ended }, 'tm-a')?.stage).toBe('ended');
  const retired = sshLaunchReducer(ended, sshOwnersChanged({}));
  expect(selectSshLaunch({ sshLaunch: sshLaunchReducer(retired, sshLaunchObserved(base)) }, 'tm-a')).toBeUndefined();
});
