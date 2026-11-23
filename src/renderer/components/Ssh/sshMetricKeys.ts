import { METRIC_KEYS, type MetricKey, type SshMetrics } from '../../types/ssh';
import type { SshIconName } from './SshIcons';

export const SSH_METRIC_KEYS = METRIC_KEYS;
export const SSH_METRIC_LABELS: Record<MetricKey, string> = {
  host: 'Host', cpu: 'CPU', ram: 'RAM', netUp: 'Network upload', netDown: 'Network download',
  uptime: 'Uptime', users: 'Connected users', partitions: 'Partitions', nfs: 'NFS partitions',
};
/** Bar glyphs (D101): icon then value, so CPU/RAM never truncate. The long label stays in title/aria-label. */
export const SSH_METRIC_ICONS: Record<MetricKey, SshIconName> = {
  host: 'server', cpu: 'chip', ram: 'memory', netUp: 'up', netDown: 'down',
  uptime: 'clock', users: 'user', partitions: 'disk', nfs: 'networkDrive',
};

// Windows reports mapped network drives in the `nfs` slot (plan 072 §5).
export function sshMetricLabel(key: MetricKey, platform?: SshMetrics['platform']): string {
  return key === 'nfs' && platform === 'Windows' ? 'Network drives' : SSH_METRIC_LABELS[key];
}
