import { createPortal } from 'react-dom';
import React, { useEffect } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { removeToast, Toast as ToastType } from '../../store/slices/uiSlice';
import './ToastContainer.css';

const ToastItem: React.FC<{ toast: ToastType }> = ({ toast }) => {
    const dispatch = useDispatch();

    useEffect(() => {
        // Sticky toasts (e.g. activity notifications) never auto-dismiss — they stay
        // until the user clicks to close (the onClick handler below removes them).
        if (toast.sticky) return;
        const timer = setTimeout(() => {
            dispatch(removeToast(toast.id));
        }, toast.duration || 3000);

        return () => clearTimeout(timer);
    }, [dispatch, toast.id, toast.duration, toast.sticky]);

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
            <button className="toast-close">&times;</button>
        </div>
    );
};

export const ToastContainer: React.FC = () => {
    const toasts = useSelector((state: RootState) => state.ui.toasts);

  // Portalled to <body> for the same reason ConfirmDialog is: an overlay cannot escape an
  // ancestor stacking context, so rendering in place makes its z-index worth only whatever
  // its caller's ancestors allow. Found by the derived test in
  // components/Canvas/__tests__/canvasStacking.test.ts after exactly that trapped the tab-close
  // confirmation behind Canvas Mode.
    return createPortal(
        <div className="toast-container">
            {toasts.map(toast => (
                <ToastItem key={toast.id} toast={toast} />
            ))}
        </div>,
        document.body,
    );
};
