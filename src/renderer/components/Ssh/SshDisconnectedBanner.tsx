import React, { useRef, useState } from 'react';
export function SshDisconnectedBanner({ reason, onReconnect }: { reason?: string; onReconnect?: () => Promise<unknown> }) {
  const busy = useRef(false);
  const [pending, setPending] = useState(false), [error, setError] = useState(false);
  const reconnect = async () => {
    if (busy.current || !onReconnect) return;
    busy.current = true; setPending(true); setError(false);
    try { await onReconnect(); } catch { setError(true); } finally { busy.current = false; setPending(false); }
  };
  return <div className="ssh-disconnected" role="status"><span>{reason || 'SSH disconnected'}</span>
    {onReconnect && <button disabled={pending} onClick={reconnect}>{pending ? 'Reconnecting…' : 'Reconnect'}</button>}
    {error && <span>Reconnect did not complete.</span>}
  </div>;
}
