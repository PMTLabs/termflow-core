import { METRIC_KEYS, type MetricKey, type SshMetrics } from '../../types/ssh';

export const SSH_METRIC_KEYS = METRIC_KEYS;
export const SSH_METRIC_LABELS: Record<MetricKey, string> = {
  host: 'Host', cpu: 'CPU', ram: 'RAM', netUp: 'Network upload', netDown: 'Network download',
  uptime: 'Uptime', users: 'Connected users', partitions: 'Partitions', nfs: 'NFS partitions',
};
/** Bar labels: value-first and short, so CPU/RAM never truncate. The long label stays in title/aria-label. */
export const SSH_METRIC_SHORT_LABELS: Record<MetricKey, string> = {
  host: '', cpu: 'CPU', ram: 'RAM', netUp: '↑', netDown: '↓',
  uptime: 'Up', users: 'Users', partitions: 'Disk', nfs: 'NFS',
};

// Windows reports mapped network drives in the `nfs` slot (plan 072 §5).
export function sshMetricLabel(key: MetricKey, platform?: SshMetrics['platform']): string {
  return key === 'nfs' && platform === 'Windows' ? 'Network drives' : SSH_METRIC_LABELS[key];
}

export function sshMetricShortLabel(key: MetricKey, platform?: SshMetrics['platform']): string {
  return key === 'nfs' && platform === 'Windows' ? 'Net drives' : SSH_METRIC_SHORT_LABELS[key];
}
