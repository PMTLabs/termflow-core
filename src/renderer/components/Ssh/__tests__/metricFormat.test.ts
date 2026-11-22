import type { MountUsage, SshMetricsSample } from '../../../types/ssh';
import { formatSshMetric, formatSshMetricsCopy } from '../metricFormat';

const gib = 1024 ** 3;
const mount = (mountPoint: string, size: number, usedPercent: number): MountUsage => ({
  mountPoint, totalBytes: size * gib, usedPercent, source: '/dev/sda', fsType: 'ext4',
  availableBytes: size * gib * (1 - usedPercent / 100), usedBytes: size * gib * usedPercent / 100,
});
const sample = (): SshMetricsSample => ({
  terminalId: 'ssh-1', sampledAt: Date.UTC(2026, 10, 13, 3, 42, 7),
  metrics: {
    host: { available: true, hostname: 'db-1', os: { available: true, name: 'Ubuntu 22.04' }, architecture: { available: true, name: 'x86_64' } },
    cpu: { available: true, percent: 61, cores: { available: true, count: 8 }, load1: { available: true, value: 4.91 } },
    ram: { available: true, usedBytes: Math.round(27.4 * gib), totalBytes: Math.round(31.2 * gib), percent: 88 },
    netUp: { available: true, bytesPerSecond: 3_200_000 }, netDown: { available: true, bytesPerSecond: 880_000 },
    uptime: { available: true, seconds: 12 * 86400 + 7 * 3600 },
    users: { available: true, count: 1, names: ['postgres'] },
    partitions: { available: true, mounts: [mount('/', 100, 48), mount('/var/lib/pg', 2048, 77)] },
    nfs: { available: true, mounts: [] },
  },
});

test('artboard5_copy_text_matches_literal_including_hidden_metrics_and_offset', () => {
  expect(formatSshMetricsCopy(sample(), 420)).toBe(`Host:        db-1 (Ubuntu 22.04, x86_64)
CPU:         61% · 8 cores · load 4.91
RAM:         27.4 / 31.2 GiB (88%)
Upload:      3.2 MB/s
Download:    880 KB/s
Uptime:      12d 7h
Users:       1 (postgres)
Partitions:  / 48% of 100 G · /var/lib/pg 77% of 2 T
NFS:         none mounted
Sampled:     2026-11-13 10:42:07 (+07:00)`);
  const other = sample();
  other.metrics.cpu = { available: false, reason: 'missing proc stat' };
  other.metrics.users = { available: true, count: 3, names: ['zoe', 'ana', 'zoe'] };
  other.metrics.uptime = { available: true, seconds: 3699 };
  other.metrics.ram = { available: true, usedBytes: gib / 4, totalBytes: 2 * gib, percent: 12.5 };
  other.metrics.nfs = { available: true, mounts: [{ ...mount('/mnt/backup', 4, 25), source: 'nas:/backup', fsType: 'nfs4' }] };
  expect(formatSshMetricsCopy(other, -210)).toBe(`Host:        db-1 (Ubuntu 22.04, x86_64)
CPU:         n/a (missing proc stat)
RAM:         0.3 / 2.0 GiB (13%)
Upload:      3.2 MB/s
Download:    880 KB/s
Uptime:      1h 1m
Users:       3 (ana, zoe)
Partitions:  / 48% of 100 G · /var/lib/pg 77% of 2 T
NFS:         nas:/backup /mnt/backup 25% of 4 G
Sampled:     2026-11-13 00:12:07 (-03:30)`);
});

test('copy_uses_sample_time_not_click_time', () => {
  const reading = sample();
  const clock = jest.spyOn(Date, 'now');
  const zone = jest.spyOn(Date.prototype, 'getTimezoneOffset').mockImplementation(function (this: Date) {
    return this.getUTCDate() === 13 ? -420 : 330;
  });
  try {
    clock.mockReturnValue(Date.UTC(2030, 0, 1));
    const first = formatSshMetricsCopy(reading);
    expect(first.split('\n')[9]).toBe('Sampled:     2026-11-13 10:42:07 (+07:00)');
    clock.mockReturnValue(Date.UTC(2040, 0, 1));
    expect(formatSshMetricsCopy(reading)).toBe(first);
    reading.sampledAt += 86400_000;
    expect(formatSshMetricsCopy(reading).split('\n')[9]).toBe('Sampled:     2026-11-13 22:12:07 (-05:30)');
  } finally {
    zone.mockRestore();
    clock.mockRestore();
  }
});

test('unavailable_and_loading_are_never_zero_in_copy', () => {
  const reading = sample();
  reading.metrics.cpu = { available: true, percent: null, cores: { available: true, count: 4 }, load1: { available: false, reason: 'missing loadavg' } };
  reading.metrics.netUp = { available: true, bytesPerSecond: null };
  reading.metrics.netDown = { available: true, bytesPerSecond: 0 };
  reading.metrics.users = { available: false, reason: 'who unavailable' };
  expect(formatSshMetricsCopy(reading, 0).split('\n').slice(1, 7)).toEqual([
    'CPU:         … · 4 cores · load n/a (missing loadavg)', 'RAM:         27.4 / 31.2 GiB (88%)',
    'Upload:      …', 'Download:    0 B/s', 'Uptime:      12d 7h', 'Users:       n/a (who unavailable)',
  ]);
  expect(formatSshMetric(reading.metrics, 'users')).toEqual({ text: 'n/a', detail: 'n/a (who unavailable)' });
});

test('full_mount_list_is_not_bar_truncated', () => {
  const reading = sample();
  const mounts = Array.from({ length: 40 }, (_, i) => mount(`/mnt/disk${i}`, 100 + i, i));
  reading.metrics.partitions = { available: true, mounts };
  expect(formatSshMetric(reading.metrics, 'partitions', 1).text).toBe('/mnt/disk0 0% · …');
  const copied = formatSshMetricsCopy(reading, 0).split('\n')[7].slice(13).split(' · ');
  expect(copied).toHaveLength(40);
  expect(copied).toEqual(Array.from({ length: 40 }, (_, i) => `/mnt/disk${i} ${i}% of ${100 + i} G`));
});

test('rate_units_and_rounding_match_mockup', () => {
  const { metrics } = sample();
  expect(formatSshMetric(metrics, 'netUp').text).toBe('3.2MB/s');
  expect(formatSshMetric(metrics, 'netDown').text).toBe('880KB/s');
  expect(formatSshMetric(metrics, 'ram').text).toBe('27.4 / 31.2 GiB');
  expect(formatSshMetric(metrics, 'partitions').detail).toBe('/ 48% of 100 G · /var/lib/pg 77% of 2 T');
  const cases: [number, string][] = [
    [0, '0B/s'], [999, '999B/s'], [1000, '1KB/s'], [1049, '1KB/s'], [1050, '1.1KB/s'],
    [999_999, '1000KB/s'], [1e6, '1MB/s'], [1_250_000, '1.3MB/s'],
    [999_999_999, '1000MB/s'], [1e9, '1GB/s'], [42_550_000_000, '42.6GB/s'],
  ];
  for (const [bytesPerSecond, expected] of cases) {
    metrics.netUp = { available: true, bytesPerSecond };
    expect(formatSshMetric(metrics, 'netUp').text).toBe(expected);
  }
});
