import { watchSshLaunch } from '../sshLaunchGate';
import type { LaunchSnapshot, SshLaunchEvent } from '../../types/ssh';
import type { SshLaunchObservation } from '../sshLaunchAttempt';

const base: LaunchSnapshot = {
  terminalId: 'tm-a', connectionId: 'c-a', launchSeq: 4, revision: 7, stage: 'waiting-trust',
  attempt: { sessionGeneration: 3, attemptReceipt: { generation: 3, gate: 'blocked' },
    processIncarnation: 'pc-a', ownerIncarnation: { pg: 2, seq: 3 } },
};
const observation = (stage: LaunchSnapshot['stage'], revision: number): SshLaunchObservation => ({
  session: { terminalId: 'tm-a', connectionId: 'c-a', state: 'connecting', gate: 'pending', generation: 3 },
  snapshot: { ...base, stage, revision },
});
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

test('subscribes before hydrate and re-queries an event received during the first read', async () => {
  let receive!: (event: SshLaunchEvent) => void;
  let subscribed!: (stop: () => void) => void;
  let hydrated!: (result: SshLaunchObservation) => void;
  const stop = jest.fn();
  const subscribe = jest.fn((listener: typeof receive) => {
    receive = listener;
    return new Promise<() => void>(resolve => { subscribed = resolve; });
  });
  const query = jest.fn()
    .mockImplementationOnce(() => new Promise(resolve => { hydrated = resolve; }))
    .mockResolvedValue(observation('typed', 8));
  const observed = jest.fn();
  const gate = watchSshLaunch({ terminalId: 'tm-a', subscribe, query, observed, failed: jest.fn() });
  expect(subscribe).toHaveBeenCalledTimes(1);
  expect(query).not.toHaveBeenCalled();
  subscribed(stop);
  await flush();
  expect(query).toHaveBeenCalledTimes(1);
  receive({ terminalId: 'tm-a', state: 'running' }); // The event's state is not authoritative.
  expect(observed).not.toHaveBeenCalled();
  hydrated(observation('waiting-ready', 7));
  await flush();
  expect(query).toHaveBeenCalledTimes(2);
  expect(observed.mock.calls).toEqual([[observation('waiting-ready', 7)], [observation('typed', 8)]]);
  receive({ terminalId: 'tm-other', state: 'ended' });
  expect(query).toHaveBeenCalledTimes(2);
  gate.stop();
  expect(stop).toHaveBeenCalledTimes(1);
});

test('polls silent waiting-stage transitions and stops on disposal', async () => {
  jest.useFakeTimers();
  const query = jest.fn().mockResolvedValueOnce(observation('waiting-trust', 7)).mockResolvedValue(observation('blocked', 8));
  const gate = watchSshLaunch({ terminalId: 'tm-a', subscribe: async () => () => {}, query, observed: jest.fn(), failed: jest.fn() });
  try {
    await flush();
    jest.advanceTimersByTime(250);
    await flush();
    expect(query).toHaveBeenCalledTimes(2);
    gate.stop();
    jest.advanceTimersByTime(1000);
    expect(query).toHaveBeenCalledTimes(2);
  } finally { gate.stop(); jest.useRealTimers(); }
});

test.each([true, false])('no-snapshot polling with settled=%s', async settled => {
  jest.useFakeTimers();
  let receive!: (event: SshLaunchEvent) => void;
  const query = jest.fn().mockResolvedValue(undefined);
  const gate = watchSshLaunch({ terminalId: 'tm-a', subscribe: async listener => { receive = listener; return () => {}; }, query, observed: jest.fn(), failed: jest.fn(), settled: () => settled });
  try {
    await flush();
    for (let i = 0; i < 120; i++) { jest.advanceTimersByTime(250); await flush(); }
    if (settled) {
      expect(query.mock.calls.length).toBeGreaterThanOrEqual(1);
      expect(query.mock.calls.length).toBeLessThanOrEqual(2);
      const before = query.mock.calls.length;
      receive({ terminalId: 'tm-a', state: 'running' });
      await flush();
      expect(query).toHaveBeenCalledTimes(before + 1);
    } else expect(query.mock.calls.length).toBeGreaterThan(10);
  } finally { gate.stop(); jest.useRealTimers(); }
});
