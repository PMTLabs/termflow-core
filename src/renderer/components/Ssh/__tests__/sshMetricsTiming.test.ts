import path from 'path';
import { SSH_METRICS_CADENCE_MS, SSH_METRICS_MAX_AGE } from '../../../store/slices/sshSessionSlice';
import { readSource } from '../../../utils/readSource';

test('metrics freshness covers the Rust cadence plus its exec deadline', () => {
  const sampler = readSource(path.resolve('src-tauri/src/ssh/metrics/sampler.rs'));
  const seconds = (name: string) => Number(sampler.match(
    new RegExp(`const ${name}: Duration = Duration::from_secs\\((\\d+)\\);`),
  )?.[1]);
  expect(SSH_METRICS_CADENCE_MS).toBe(seconds('CADENCE') * 1000);
  expect(SSH_METRICS_MAX_AGE).toBe((seconds('CADENCE') + seconds('DEADLINE')) * 1000);
});
