import type { MetricKey } from '../../types/ssh';

export const SSH_METRIC_KEYS = ['host', 'cpu', 'ram', 'netUp', 'netDown', 'uptime', 'users', 'partitions', 'nfs'] as const satisfies readonly MetricKey[];
export const SSH_METRIC_LABELS: Record<MetricKey, string> = {
  host: 'Host', cpu: 'CPU', ram: 'RAM', netUp: 'Network upload', netDown: 'Network download',
  uptime: 'Uptime', users: 'Connected users', partitions: 'Partitions', nfs: 'NFS partitions',
};
