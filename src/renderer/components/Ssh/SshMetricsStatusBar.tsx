import React, { useRef, useState } from 'react';
import { useDismissOnTabDeactivate } from '../../hooks/useDismissOnTabDeactivate';
import { ContextMenu, type ContextMenuItem } from '../Terminal/ContextMenu';
import { formatSshMetric } from './metricFormat';
import { SshIcon } from './SshIcons';
import { SSH_METRIC_ICONS, SSH_METRIC_KEYS, sshMetricLabel } from './sshMetricKeys';
import { useSshMetrics } from './useSshMetrics';
import './SshMetricsStatusBar.css';

const SESSION_LABELS = {
  connecting: 'Connecting', 'needs-secret': 'Waiting for credentials', 'needs-hostkey': 'Waiting for host key approval',
  connected: 'Connected', disconnected: 'Disconnected', error: 'SSH error',
};
// Matches the D57 restored-session strip, which owns the "Open a new SSH tab" action.
const RESTORED_REASON = 'Not available for a session restored from before TermFlow restarted';

export function SshMetricsStatusBar({ terminalId, isTabActive = true }: { terminalId: string; isTabActive?: boolean }) {
  const { identity, hidden, sample, session, ended, restored, paused, unavailable, delayed, setPreference, copy, resume, reconnect } =
    useSshMetrics(terminalId);
  const [menu, setMenu] = useState<{ x: number; y: number; terminalId: string } | null>(null);
  const bar = useRef<HTMLDivElement>(null);
  const connected = !ended && session?.state === 'connected';
  const canResume = connected && paused !== null;
  const canReconnect = ended || canResume || session?.state === 'disconnected' || session?.state === 'error';
  // A host with no collector answers every sample, so "Connected" over a row of n/a would hide why (D95).
  const unsupported = sample?.metrics.unsupportedPlatform;
  const failureReason = unavailable ?? sample?.metrics.unavailableReason;
  const live = !!sample && !unsupported && !failureReason;
  const status = !connected ? (ended ? 'SSH session ended' : session ? SESSION_LABELS[session.state] : restored ? 'Metrics unavailable' : 'Disconnected')
    : paused ?? (failureReason ? 'Metrics unavailable' : unsupported ? `Metrics not supported on ${unsupported}`
      : sample ? 'Connected' : delayed ? 'Metrics delayed' : 'Collecting first sample');
  const unsupportedReason = unsupported && sample?.metrics.cpu.available === false ? sample.metrics.cpu.reason : undefined;
  const waiting = connected && !canResume && !delayed && !failureReason;
  const visible = SSH_METRIC_KEYS.filter(key => !hidden.includes(key));
  const items: ContextMenuItem[] = [
    { label: 'Copy all metrics', enabled: !!sample, click: copy },
    { type: 'separator' },
    { type: 'heading', label: 'Show in status bar' },
    ...SSH_METRIC_KEYS.map(key => ({ label: sshMetricLabel(key, sample?.metrics.platform), checked: !hidden.includes(key), click: () => setPreference(key) })),
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
        <span className={`ssh-metrics-state${live ? ' is-live' : ''}`}
          title={[status, connected ? failureReason ?? unsupportedReason : restored ? RESTORED_REASON : session?.reason].filter(Boolean).join(' — ')}>
          <span aria-hidden="true">{live ? '●' : '○'}</span> {status}
        </span>
        {/* Before the values: overflowing items wrap out of the row from the end, never this action. */}
        {canResume && <button type="button" onClick={resume}>Resume metrics (F3)</button>}
        {visible.map(key => {
          const value = sample ? formatSshMetric(sample.metrics, key)
            : unavailable && connected && !canResume ? { text: 'n/a', detail: `n/a (${unavailable})` }
            // The status tooltip states the reason once; repeating it on every field is noise.
            : restored ? { text: 'n/a', detail: 'n/a' }
            : { text: waiting ? '…' : '—', detail: status };
          const label = sshMetricLabel(key, sample?.metrics.platform);
          const identityOnly = key === 'host' && !sample;
          // Compact RAM ("3.1/16.0 GiB"); the full spacing stays in the tooltip and copy text.
          const shown = key === 'ram' ? value.text.replace(' / ', '/') : value.text;
          const text = identityOnly ? `${identity} · ${shown}` : shown;
          const detail = identityOnly ? `${identity} (configured) · ${value.detail}`
            : key === 'users' && sample?.metrics.platform === 'Windows' ? `${value.detail} · SSH sessions are not listed`
            : value.detail;
          return <span className="ssh-metrics-value" key={key} data-metric={key} title={`${label}: ${detail}`}
            aria-label={`${label}: ${detail}`}><SshIcon name={SSH_METRIC_ICONS[key]} size={12} />{text}</span>;
        })}
      </>}
      {/* Portalled to body, so it carries the Canvas keyboard-owner marker itself (review 349 F6). */}
      {menuOpen && <ContextMenu x={menu.x} y={menu.y} className="ssh-keyboard-owner" items={items} onClose={closeMenu} />}
    </div>
  );
}
