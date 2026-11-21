import React, { useRef, useState } from 'react';
export function SshDisconnectedBanner({ reason, onReconnect }: { reason?: string; onReconnect?: () => Promise<unknown> }) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState<string>();
  const reconnect = async () => {
    if (busy.current || !onReconnect) return;
    busy.current = true; setPending(true); setError(undefined);
    try { await onReconnect(); } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Reconnect did not complete.');
    } finally { busy.current = false; setPending(false); }
  };
  return <div className="ssh-disconnected" role="status"><span>{reason || 'SSH disconnected'}</span>
    {onReconnect && <button className="au-btn" disabled={pending} onClick={reconnect}>{pending ? 'Reconnecting…' : 'Reconnect'}</button>}
    {error && <span>{error}</span>}
  </div>;
}
