import React, { useId, useRef } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { RootState } from '../../store';
import { hideDialog } from '../../store/slices/uiSlice';
import { useDialogA11y, Mnemonic as MnemonicType } from './useDialogA11y';
import { Mnemonic } from './Mnemonic';
import './GlobalDialog.css';

export const GlobalDialog: React.FC = () => {
    const { isOpen, title, message, type, showConfirm } = useSelector((state: RootState) => state.ui.dialog);
    const dispatch = useDispatch();
    const containerRef = useRef<HTMLDivElement>(null);
    const titleId = useId();

    const handleClose = () => {
        dispatch(hideDialog());
    };

    const handleConfirm = () => {
        // In a more complex app, we'd trigger a callback or another action
        // For now, we'll just close it. Real confirmation logic often stays local to the component.
        dispatch(hideDialog());
    };

    const mnemonics: MnemonicType[] = showConfirm
        ? [{ key: 'C', handler: handleConfirm }, { key: 'A', handler: handleClose }]
        : [{ key: 'O', handler: handleClose }];

    useDialogA11y(containerRef, {
        isOpen,
        onCancel: handleClose,
        mnemonics,
        initialFocus: 'confirm',
    });

    if (!isOpen) return null;

    const getIcon = () => {
        switch (type) {
            case 'success': return '✅';
            case 'warning': return '⚠️';
            case 'error': return '❌';
            default: return 'ℹ️';
        }
    };

    return (
        <div className="global-dialog-overlay" onClick={handleClose}>
            <div
                className={`global-dialog-content ${type}`}
                ref={containerRef}
                role="dialog"
                aria-modal="true"
                aria-labelledby={titleId}
                tabIndex={-1}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="dialog-header">
                    <div className="title-with-icon">
                        <span className="dialog-icon">{getIcon()}</span>
                        <h3 id={titleId}>{title}</h3>
                    </div>
                    <button className="close-btn" aria-label="Close" onClick={handleClose}>&times;</button>
                </div>
                <div className="dialog-body">
                    <p>{message}</p>
                </div>
                <div className="dialog-footer">
                    {showConfirm ? (
                        <>
                            <button className="dialog-btn secondary" data-dialog-cancel onClick={handleClose}>
                                <Mnemonic label="Cancel" char="A" />
                            </button>
                            <button className="dialog-btn" data-dialog-confirm onClick={handleConfirm}>
                                <Mnemonic label="Confirm" char="C" />
                            </button>
                        </>
                    ) : (
                        <button className="dialog-btn" data-dialog-confirm onClick={handleClose}>
                            <Mnemonic label="OK" char="O" />
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
