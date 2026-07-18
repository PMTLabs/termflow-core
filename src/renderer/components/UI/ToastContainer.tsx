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

    return (
        <div className="toast-container">
            {toasts.map(toast => (
                <ToastItem key={toast.id} toast={toast} />
            ))}
        </div>
    );
};
