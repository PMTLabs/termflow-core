import { createPortal } from 'react-dom';
import React, { useEffect, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { removeToast, dismissAllToasts, Toast as ToastType } from '../../store/slices/uiSlice';
import { CANVAS_SHELL_TYPE } from '../../services/tabKinds';
import './ToastContainer.css';

// Mirrors SearchResults.tsx's formatTimestamp — same thresholds, kept local since toasts
// and search results have no shared timestamp-formatting module.
function formatRelativeTime(createdAt: number, now: number): string {
    const diffMs = now - createdAt;
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return new Date(createdAt).toLocaleDateString();
}

const ToastItem: React.FC<{ toast: ToastType }> = ({ toast }) => {
    const dispatch = useDispatch();
    // A sticky toast can sit visible for a long time; this forces a periodic re-render
    // so its "time ago" label keeps pace instead of freezing at whatever it said on mount.
    const [, tick] = useState(0);

    useEffect(() => {
        // Sticky toasts (e.g. activity notifications) never auto-dismiss — they stay
        // until the user clicks to close (the onClick handler below removes them).
        if (toast.sticky) return;
        const timer = setTimeout(() => {
            dispatch(removeToast(toast.id));
        }, toast.duration || 3000);

        return () => clearTimeout(timer);
    }, [dispatch, toast.id, toast.duration, toast.sticky]);

    useEffect(() => {
        const interval = setInterval(() => tick(t => t + 1), 30_000);
        return () => clearInterval(interval);
    }, []);

    const getIcon = () => {
        switch (toast.type) {
            case 'success': return '✅';
            case 'warning': return '⚠️';
            case 'error': return '❌';
            default: return 'ℹ️';
        }
    };

    return (
        <div className={`toast-item ${toast.type}`} onClick={() => dispatch(removeToast(toast.id))}>
            <span className="toast-icon">{getIcon()}</span>
            <span className="toast-message">{toast.message}</span>
            <span className="toast-time" title={new Date(toast.createdAt).toLocaleString()}>
                {formatRelativeTime(toast.createdAt, Date.now())}
            </span>
            <button
                className="toast-close"
                aria-label="Dismiss"
                onClick={(e) => { e.stopPropagation(); dispatch(removeToast(toast.id)); }}
            >
                &times;
            </button>
        </div>
    );
};

export const ToastContainer: React.FC = () => {
    const toasts = useSelector((state: RootState) => state.ui.toasts);
    // Guarded with optional chaining: the `tabs` slice isn't registered in every store
    // this component is mounted under in tests, and "not a canvas tab" is the right
    // fallback when that state is absent.
    const isCanvasActive = useSelector((state: RootState) => {
        const tabsState = state.tabs as RootState['tabs'] | undefined;
        const activeTab = tabsState?.tabs?.find(t => t.id === tabsState.activeTabId);
        return activeTab?.shellType === CANVAS_SHELL_TYPE;
    });
    const dispatch = useDispatch();
    const [expanded, setExpanded] = useState(false);
    const stackRef = useRef<HTMLDivElement>(null);

    // A single toast never needs stacking chrome — collapse only makes sense once there's
    // something to hide behind the front card.
    const isStacked = toasts.length > 1;

    useEffect(() => {
        if (!expanded) return;

        const collapse = () => setExpanded(false);
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') collapse();
        };
        const onMouseDown = (e: MouseEvent) => {
            if (stackRef.current && !stackRef.current.contains(e.target as Node)) collapse();
        };

        document.addEventListener('keydown', onKeyDown);
        document.addEventListener('mousedown', onMouseDown);
        return () => {
            document.removeEventListener('keydown', onKeyDown);
            document.removeEventListener('mousedown', onMouseDown);
        };
    }, [expanded]);

    // Collapsing away (e.g. the last toast got dismissed) never leaves stale expanded state.
    useEffect(() => {
        if (!isStacked) setExpanded(false);
    }, [isStacked]);

    const newestFirst = [...toasts].reverse();
    const containerClass = `toast-container${isCanvasActive ? ' toast-container--canvas' : ''}`;

    // Shared between the collapsed and expanded headers so "clear everything" is always
    // one click away — not gated behind first finding and clicking expand.
    const closeAllButton = (
        <button
            type="button"
            className="toast-close-all"
            onClick={() => dispatch(dismissAllToasts())}
            aria-label="Dismiss all notifications"
        >
            Clear all
        </button>
    );

  // Portalled to <body> for the same reason ConfirmDialog is: an overlay cannot escape an
  // ancestor stacking context, so rendering in place makes its z-index worth only whatever
  // its caller's ancestors allow. Found by the derived test in
  // components/Canvas/__tests__/canvasStacking.test.ts after exactly that trapped the tab-close
  // confirmation behind Canvas Mode.
    return createPortal(
        <div className={containerClass} role="status" aria-live="polite">
            {!isStacked && toasts.map(toast => (
                <ToastItem key={toast.id} toast={toast} />
            ))}

            {isStacked && !expanded && (
                <div className="toast-stack" ref={stackRef}>
                    <div className="toast-stack-header">
                        <button
                            type="button"
                            className="toast-stack-expand"
                            onClick={() => setExpanded(true)}
                            aria-label={`Show all ${toasts.length} notifications`}
                        >
                            <span className="toast-stack-chevron" aria-hidden="true">▾</span>
                            {toasts.length} notifications
                        </button>
                        {closeAllButton}
                    </div>
                    <ToastItem toast={newestFirst[0]} />
                </div>
            )}

            {isStacked && expanded && (
                <div className="toast-stack toast-stack--expanded" ref={stackRef}>
                    <div className="toast-stack-header">
                        <button
                            type="button"
                            className="toast-stack-expand"
                            onClick={() => setExpanded(false)}
                            aria-label="Collapse notifications"
                        >
                            <span className="toast-stack-chevron" aria-hidden="true">▴</span>
                            {toasts.length} notifications
                        </button>
                        {closeAllButton}
                    </div>
                    {newestFirst.map(toast => (
                        <ToastItem key={toast.id} toast={toast} />
                    ))}
                </div>
            )}
        </div>,
        document.body,
    );
};
