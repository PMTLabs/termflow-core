import { METRIC_KEYS, type MetricKey, type SshMetrics } from '../../types/ssh';

export const SSH_METRIC_KEYS = METRIC_KEYS;
export const SSH_METRIC_LABELS: Record<MetricKey, string> = {
  host: 'Host', cpu: 'CPU', ram: 'RAM', netUp: 'Network upload', netDown: 'Network download',
  uptime: 'Uptime', users: 'Connected users', partitions: 'Partitions', nfs: 'NFS partitions',
};

export function sshMetricLabel(key: MetricKey, platform?: SshMetrics['platform']): string {
  return key === 'nfs' && platform === 'Windows' ? 'Network drives' : SSH_METRIC_LABELS[key];
}
