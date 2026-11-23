import { METRIC_KEYS, type MetricKey } from '../../types/ssh';

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
