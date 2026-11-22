import { gatedBridge } from '../__testFixtures__/gatedBridge';

test('records ordered arguments and settles only the selected deferred call', async () => {
  const bridge = gatedBridge();
  const invoke = bridge.command('adopt');
  const done: unknown[] = [];
  const first = invoke('host-a', { seq: 1 }).then(value => done.push(value));
  const second = invoke('host-b', { seq: 2 }).then(value => done.push(value));
  const control = bridge.command('control')('alive');
  bridge.release('control', 0, 'control-result');
  await expect(control).resolves.toBe('control-result');
  expect(bridge.calls('adopt')).toEqual([['host-a', { seq: 1 }], ['host-b', { seq: 2 }]]);
  expect(done).toEqual([]);
  bridge.release('adopt', 1, 'second');
  await second;
  expect(done).toEqual(['second']);
  bridge.release('adopt', 0, 'first');
  await first;
  expect(done).toEqual(['second', 'first']);
  const failed = invoke('host-c');
  const rejection = expect(failed).rejects.toThrow('dropped');
  bridge.fail('adopt', 2, new Error('dropped'));
  await rejection;
  expect(() => bridge.release('adopt', 2)).toThrow('No pending');
});
