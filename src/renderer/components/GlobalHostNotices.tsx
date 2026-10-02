import React, { useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { AppDispatch } from '../store';
import { addToast } from '../store/slices/uiSlice';

/** The backend's one-time announcement that two hosts both claim the same terminal sessions,
 *  re-dispatched on `window` by the Tauri bridge. */
export const DUPLICATE_SESSION_EVENT = 'pty-host:duplicate-session';

/**
 * App-level owner of the host advisories that have no pane to attach to. Mounted once at the
 * App root. The announcement is global (the host table is per process), so every open window
 * shows it; it is sent once per run, so that stays rare.
 */
export const GlobalHostNotices: React.FC = () => {
    const dispatch = useDispatch<AppDispatch>();

    useEffect(() => {
        const onDuplicate = (event: Event) => {
            const keys = (event as CustomEvent<{ sessionKeys?: unknown } | undefined>).detail?.sessionKeys;
            const count = Array.isArray(keys) ? keys.length : 0;
            if (count === 0) return;
            dispatch(addToast({
                message: count === 1
                    ? 'One terminal session is held by two background hosts. Both copies were left running; close the extra terminal if one looks duplicated.'
                    : `${count} terminal sessions are held by two background hosts. Both copies were left running; close the extra terminals if some look duplicated.`,
                type: 'warning',
                duration: 12000,
            }));
        };
        window.addEventListener(DUPLICATE_SESSION_EVENT, onDuplicate);
        return () => window.removeEventListener(DUPLICATE_SESSION_EVENT, onDuplicate);
    }, [dispatch]);

    return null;
};
