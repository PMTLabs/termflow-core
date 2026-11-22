import { METRIC_KEYS, normalizeHiddenMetrics } from './ssh';

test('hidden_metrics_ingress_filters_deduplicates_and_keeps_encoded_order', () => {
  expect(METRIC_KEYS).toEqual(['host', 'cpu', 'ram', 'netUp', 'netDown', 'uptime', 'users', 'partitions', 'nfs']);
  expect(normalizeHiddenMetrics(['nfs', 'unknown', 'cpu', 'nfs', null, 'cpu'])).toEqual(['nfs', 'cpu']);
  expect(normalizeHiddenMetrics(['nfs', 'cpu'])).toEqual(['nfs', 'cpu']);
  expect(normalizeHiddenMetrics(undefined)).toEqual([]);
  expect(normalizeHiddenMetrics('cpu')).toEqual([]);
});
