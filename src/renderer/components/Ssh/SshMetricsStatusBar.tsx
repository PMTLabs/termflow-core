import React, { useRef, useState } from 'react';
import { useDismissOnTabDeactivate } from '../../hooks/useDismissOnTabDeactivate';
import { ContextMenu, type ContextMenuItem } from '../Terminal/ContextMenu';
import { formatSshMetric } from './metricFormat';
import { SSH_METRIC_KEYS, SSH_METRIC_LABELS } from './sshMetricKeys';
import { useSshMetrics } from './useSshMetrics';
import './SshMetricsStatusBar.css';

const SESSION_LABELS = {
  connecting: 'Connecting', 'needs-secret': 'Waiting for credentials', 'needs-hostkey': 'Waiting for host key approval',
  connected: 'Connected', disconnected: 'Disconnected', error: 'SSH error',
};

export function SshMetricsStatusBar({ terminalId, isTabActive = true }: { terminalId: string; isTabActive?: boolean }) {
  const { identity, hidden, sample, session, ended, paused, unavailable, delayed, setPreference, copy, resume, reconnect } =
    useSshMetrics(terminalId);
  const [menu, setMenu] = useState<{ x: number; y: number; terminalId: string } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const connected = !ended && session?.state === 'connected';
  const canResume = connected && paused !== null;
  const canReconnect = ended || canResume || session?.state === 'disconnected' || session?.state === 'error';
  const status = !connected ? (ended ? 'SSH session ended' : session ? SESSION_LABELS[session.state] : 'Disconnected')
    : paused ?? (unavailable ? 'Metrics unavailable' : sample ? 'Connected' : delayed ? 'Metrics delayed' : 'Collecting first sample');
  const waiting = connected && !canResume && !delayed && !unavailable;
  const visible = SSH_METRIC_KEYS.filter(key => !hidden.includes(key));
  const items: ContextMenuItem[] = [
    { label: 'Copy all metrics', enabled: !!sample, click: copy },
    { type: 'separator' },
    { type: 'heading', label: 'Show in status bar' },
    ...SSH_METRIC_KEYS.map(key => ({ label: SSH_METRIC_LABELS[key], checked: !hidden.includes(key), click: () => setPreference(key) })),
    { type: 'separator' },
    { label: 'Reset to defaults', click: () => setPreference() },
    ...(canReconnect ? [
      { type: 'separator' as const },
      ...(canResume ? [{ label: 'Resume metrics', accelerator: 'F3', click: resume }] : []),
      { label: 'Reconnect', click: reconnect },
    ] : []),
  ];

  function openMenu(event: React.MouseEvent<HTMLDivElement> | React.KeyboardEvent<HTMLDivElement>, x: number, y: number) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x, y, terminalId });
  }

  const menuOpen = isTabActive && menu?.terminalId === terminalId;
  const closeMenu = () => { setMenu(null); bar.current?.focus(); };
  useDismissOnTabDeactivate(isTabActive, () => setMenu(null));

  return (
    <div ref={bar} className="ssh-metrics-status-bar" role="status" aria-label="Remote host metrics"
      aria-live="off" tabIndex={0} aria-haspopup="menu"
      onContextMenu={event => {
        if (event.currentTarget.contains(event.target as Node)) openMenu(event, event.clientX, event.clientY);
      }}
      onKeyDownCapture={event => {
        // Capture F3 even when focus is inside the portalled menu, whose own
        // native key handler stops propagation.
        if (canResume && event.key === 'F3') {
          event.preventDefault();
          event.stopPropagation();
          resume();
          if (menuOpen) closeMenu();
        } else if (!menuOpen && (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) {
          const rect = event.currentTarget.getBoundingClientRect();
          openMenu(event, rect.left, rect.bottom);
        }
      }}>
      {!!visible.length && <>
        <span className={`ssh-metrics-state${sample ? ' is-live' : ''}`}
          title={[status, connected ? unavailable : session?.reason].filter(Boolean).join(' — ')}>
          <span aria-hidden="true">{sample ? '●' : '○'}</span> {status}
        </span>
        {visible.map(key => {
          const value = sample ? formatSshMetric(sample.metrics, key)
            : unavailable && connected && !canResume ? { text: 'n/a', detail: `n/a (${unavailable})` }
            : { text: waiting ? '…' : '—', detail: status };
          const label = SSH_METRIC_LABELS[key];
          const identityOnly = key === 'host' && !sample;
          const text = identityOnly ? `${identity} · ${value.text}` : value.text;
          const detail = identityOnly ? `${identity} (configured) · ${value.detail}` : value.detail;
          return <span className="ssh-metrics-value" key={key} data-metric={key} title={`${label}: ${detail}`}
            aria-label={`${label}: ${detail}`}>{label}: {text}</span>;
        })}
      </>}
      {canResume && !!visible.length && <button type="button" onClick={resume}>Resume metrics (F3)</button>}
      {menuOpen && <ContextMenu x={menu.x} y={menu.y} items={items} onClose={closeMenu} />}
    </div>
  );
}
