import type { MetricKey, MountUsage, SshMetrics, SshMetricsSample } from '../../types/ssh';
import { SSH_METRIC_KEYS, SSH_METRIC_LABELS } from './sshMetricKeys';

const GIB = 1024 ** 3;
const LOADING = '…';
const percent = (value: number) => `${Math.round(value)}%`;
const tenth = (value: number) => String(Math.round(value * 10) / 10);
const unavailable = (reason: string) => `n/a (${reason})`;

function rate(bytes: number | null, space: string): string {
  if (bytes === null) return LOADING;
  const [unit, scale] = bytes >= 1e9 ? ['GB', 1e9] as const
    : bytes >= 1e6 ? ['MB', 1e6] as const
    : bytes >= 1e3 ? ['KB', 1e3] as const : ['B', 1] as const;
  return `${tenth(bytes / scale)}${space}${unit}/s`;
}

function duration(seconds: number): string {
  const whole = Math.floor(seconds);
  if (whole >= 86400) return `${Math.floor(whole / 86400)}d ${Math.floor(whole / 3600) % 24}h`;
  if (whole >= 3600) return `${Math.floor(whole / 3600)}h ${Math.floor(whole / 60) % 60}m`;
  return `${Math.floor(whole / 60)}m ${whole % 60}s`;
}

function capacity(bytes: number): string {
  if (bytes >= 1024 * GIB) return `${tenth(bytes / (1024 * GIB))} T`;
  if (bytes >= GIB) return `${tenth(bytes / GIB)} G`;
  if (bytes >= 1024 ** 2) return `${tenth(bytes / 1024 ** 2)} M`;
  if (bytes >= 1024) return `${tenth(bytes / 1024)} K`;
  return `${bytes} B`;
}

function mountsText(mounts: MountUsage[], nfs: boolean, compact: boolean): string {
  return mounts.map(mount => {
    const location = nfs ? [mount.source, compact ? '' : mount.mountPoint].filter(Boolean).join(' ') : mount.mountPoint;
    const usage = percent(mount.usedPercent);
    return `${location} ${usage}${compact ? '' : ` of ${capacity(mount.totalBytes)}`}`;
  }).join(' · ') || 'none mounted';
}

export interface FormattedMetric {
  /** Compact status bar text, without the metric label. */
  text: string;
  /** Full value for tooltip/accessible description and clipboard. */
  detail: string;
}

/** Formats an eligible sample; the caller owns connection, freshness and loading state. */
export function formatSshMetric(metrics: SshMetrics, key: MetricKey, mountLimit = 2): FormattedMetric {
  const metric = metrics[key];
  if (!metric.available) return { text: 'n/a', detail: unavailable(metric.reason) };
  const same = (text: string) => ({ text, detail: text });
  switch (key) {
    case 'host': {
      const { hostname, os, architecture } = metrics.host as Extract<SshMetrics['host'], { available: true }>;
      return { text: hostname, detail: `${hostname} (${[os, architecture].map(part => part.available ? part.name : unavailable(part.reason)).join(', ')})` };
    }
    case 'cpu': {
      const { percent: usage, cores, load1 } = metrics.cpu as Extract<SshMetrics['cpu'], { available: true }>;
      const text = usage === null ? LOADING : percent(usage);
      return { text, detail: `${text} · ${cores.available ? `${cores.count} cores` : unavailable(cores.reason)} · load ${load1.available ? load1.value.toFixed(2) : unavailable(load1.reason)}` };
    }
    case 'ram': {
      const { usedBytes, totalBytes, percent: usage } = metrics.ram as Extract<SshMetrics['ram'], { available: true }>;
      const text = `${(usedBytes / GIB).toFixed(1)} / ${(totalBytes / GIB).toFixed(1)} GiB`;
      return { text, detail: `${text} (${percent(usage)})` };
    }
    case 'netUp': case 'netDown': {
      const { bytesPerSecond } = metrics[key] as Extract<SshMetrics['netUp'], { available: true }>;
      return { text: rate(bytesPerSecond, ''), detail: rate(bytesPerSecond, ' ') };
    }
    case 'uptime': {
      const { seconds } = metrics.uptime as Extract<SshMetrics['uptime'], { available: true }>;
      return same(duration(seconds));
    }
    case 'users': {
      const { count, names } = metrics.users as Extract<SshMetrics['users'], { available: true }>;
      const unique = [...new Set(names)].sort();
      return { text: String(count), detail: unique.length ? `${count} (${unique.join(', ')})` : String(count) };
    }
    case 'partitions': case 'nfs': {
      const { mounts } = metrics[key] as Extract<SshMetrics['partitions'], { available: true }>;
      const compact = mountsText(mounts.slice(0, mountLimit), key === 'nfs', true);
      return { text: mounts.length > mountLimit ? `${compact} · …` : compact, detail: mountsText(mounts, key === 'nfs', false) };
    }
  }
}

const COPY_LABELS: Partial<Record<MetricKey, string>> = {
  netUp: 'Upload', netDown: 'Download', users: 'Users', nfs: 'NFS',
};

/** Offset in minutes east of UTC, evaluated at the sample instant by default (including DST). */
export function formatSshMetricsCopy(sample: SshMetricsSample, offsetMinutes = -new Date(sample.sampledAt).getTimezoneOffset()): string {
  const local = new Date(sample.sampledAt + offsetMinutes * 60_000).toISOString().slice(0, 19).replace('T', ' ');
  const absolute = Math.abs(offsetMinutes);
  const pad = (value: number) => String(value).padStart(2, '0');
  const offset = `${offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  const line = (label: string, value: string) => `${`${label}:`.padEnd(13)}${value}`;
  return [
    ...SSH_METRIC_KEYS.map(key => line(COPY_LABELS[key] ?? SSH_METRIC_LABELS[key], formatSshMetric(sample.metrics, key).detail)),
    line('Sampled', `${local} (${offset})`),
  ].join('\n');
}
