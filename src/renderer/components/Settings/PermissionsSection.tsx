import React, { useEffect, useRef, useState } from 'react';
import { useDispatch } from 'react-redux';
import { addToast } from '../../store/slices/uiSlice';
import type { PermissionKind, PermissionView, PermState } from '../../types/electron';

const REQUEST_TIMEOUT_MS = 30000;
const labels: Record<PermState, string> = {
    granted: 'Granted', notGranted: 'Not granted', unsupported: 'Unsupported', unknown: 'Unknown',
};
const sameSubject = (a: PermissionView, b: PermissionView) =>
    a.target === b.target && a.subject.pid === b.subject.pid &&
    a.subject.generation === b.subject.generation && a.subject.bundleId === b.subject.bundleId;

export function PermissionsSection() {
    const dispatch = useDispatch();
    const [view, setView] = useState<PermissionView | null>(null);
    const [unsupported, setUnsupported] = useState(false);
    const [busy, setBusy] = useState<PermissionKind | null>(null);
    const [paneError, setPaneError] = useState('');
    const current = useRef<PermissionView | null>(null);
    const epoch = useRef(0);
    const alive = useRef(false);
    const busyRef = useRef(false);

    useEffect(() => {
        alive.current = true;
        const api = window.electronAPI;
        if (!api?.macosPermissionStatus || !api.requestMacosPermission || !api.openMacosPermissionPane) {
            setUnsupported(true);
        } else {
            const refresh = async () => {
                const operation = ++epoch.current;
                try {
                    const result = await api.macosPermissionStatus!();
                    if (!alive.current || operation !== epoch.current) return;
                    current.current = result;
                    setView(result);
                    if (result.error) dispatch(addToast({ message: `Permission request failed: ${result.error}`, type: 'error' }));
                } catch (err) {
                    if (!alive.current || operation !== epoch.current) return;
                    dispatch(addToast({ message: `Permission request failed: ${String(err)}`, type: 'error' }));
                    if (current.current) {
                        const next = { ...current.current, accessibility: 'unknown' as const, screenRecording: 'unknown' as const };
                        current.current = next;
                        setView(next);
                    }
                }
            };
            const onFocus = () => { void refresh(); };
            const onHost = () => { if (document.hasFocus()) void refresh(); };
            void refresh();
            window.addEventListener('focus', onFocus);
            window.addEventListener('pty-host:state', onHost);
            const teardown = () => { alive.current = false; ++epoch.current; };
            window.addEventListener('pagehide', teardown);
            window.addEventListener('beforeunload', teardown);
            return () => {
                teardown();
                window.removeEventListener('focus', onFocus);
                window.removeEventListener('pty-host:state', onHost);
                window.removeEventListener('pagehide', teardown);
                window.removeEventListener('beforeunload', teardown);
            };
        }
        return () => { alive.current = false; ++epoch.current; };
    }, []);

    const request = async (kind: PermissionKind) => {
        const api = window.electronAPI;
        const subject = current.current;
        if (!subject || subject.target === 'unresolved' || busyRef.current || !api?.requestMacosPermission || !api.openMacosPermissionPane) return;
        busyRef.current = true;
        setBusy(kind);
        setPaneError('');
        const operation = ++epoch.current;
        const valid = () => alive.current && !!current.current && sameSubject(subject, current.current);
        const latest = () => operation === epoch.current;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            const result = await Promise.race([
                api.requestMacosPermission(kind, { target: subject.target, ...subject.subject }),
                new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Permission request timed out')), REQUEST_TIMEOUT_MS); }),
            ]);
            if (!valid()) return;
            const matches = sameSubject(subject, result);
            if (!matches && !result.error) return;
            if (latest()) {
                current.current = result;
                setView(result);
            }
            if (result.error) dispatch(addToast({ message: `Permission request failed: ${result.error}`, type: 'error' }));
            if (!matches) return;
            try {
                await api.openMacosPermissionPane(kind);
            } catch (err) {
                if (valid()) setPaneError(`Could not open System Settings: ${String(err)}`);
            }
        } catch (err) {
            if (valid()) {
                if (latest()) {
                    const next = { ...current.current!, accessibility: 'unknown' as const, screenRecording: 'unknown' as const };
                    current.current = next;
                    setView(next);
                }
                dispatch(addToast({ message: `Permission request failed: ${String(err)}`, type: 'error' }));
            }
        } finally {
            if (timer) clearTimeout(timer);
            busyRef.current = false;
            if (alive.current) setBusy(null);
        }
    };

    const target = view?.target === 'host' ? 'TermFlow Host' : view?.target === 'hostLegacy' ? 'legacy host' : view?.target === 'app' ? 'TermFlow' : null;
    return <section aria-label="Permissions">
        <h2>Permissions</h2>
        {target && <p>Permission target: {target}</p>}
        {view?.target === 'unresolved' && <p>Open a terminal to determine which program needs permission. No permission request can be sent yet.</p>}
        {view?.target === 'hostLegacy' && <p>New terminals will use TermFlow Host after the next app update; terminals already open keep their current identity until closed.</p>}
        {view && (view.otherHosts.length > 0 || view.appSessions) && <p role="note">Other terminal identities are not covered by this permission: {view.otherHosts.map(host => `PID ${host.pid}${host.generation ? ` (${host.generation})` : ''} — ${host.reason === 'appAttributed' ? "uses TermFlow's permission" : host.reason}`).join(', ')}{view.appSessions ? `${view.otherHosts.length ? ', ' : ''}TermFlow app sessions` : ''}.</p>}
        {(['accessibility', 'screenRecording'] as const).map(kind => <div key={kind}>
            <button type="button" disabled={unsupported || !view || view.target === 'unresolved' || busy !== null} onClick={() => void request(kind)}>
                Allow {kind === 'accessibility' ? 'Accessibility' : 'Screen Recording'}
            </button>
            <span> {labels[unsupported ? 'unsupported' : view?.[kind] ?? 'unknown']}</span>
            <p>Restart the program that needs this permission (for example InkSpoke). Terminals can stay open.</p>
            {view?.target === 'host' && view[kind] === 'notGranted' && <p>Programs in terminals now use the 'TermFlow Host' permission. If you previously allowed TermFlow, allow TermFlow Host once.</p>}
        </div>)}
        {paneError && <p role="alert">{paneError}</p>}
    </section>;
}
