import React, { useId, useRef } from 'react';
import './ConfirmDialog.css';
import { useDialogA11y, Mnemonic as MnemonicType } from './useDialogA11y';
import { Mnemonic } from './Mnemonic';

interface ConfirmDialogProps {
  isOpen: boolean;
  title: string;
  /** Plain string (wrapped in <p>) or arbitrary JSX (e.g. a process list). */
  message: React.ReactNode;
  onConfirm: () => void;
  onCancel: () => void;
  confirmText?: string;
  cancelText?: string;
  /** Destructive confirms default focus to Cancel so a stray Enter never fires. */
  destructive?: boolean;
  /** Bare-letter shortcut + underlined mnemonic for the confirm button, e.g. "C". */
  confirmMnemonic?: string;
  /** Bare-letter shortcut + underlined mnemonic for the cancel button, e.g. "A". */
  cancelMnemonic?: string;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  isOpen,
  title,
  message,
  onConfirm,
  onCancel,
  confirmText = 'Confirm',
  cancelText = 'Cancel',
  destructive = false,
  confirmMnemonic,
  cancelMnemonic,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const mnemonics: MnemonicType[] = [];
  if (confirmMnemonic) mnemonics.push({ key: confirmMnemonic, handler: onConfirm });
  if (cancelMnemonic) mnemonics.push({ key: cancelMnemonic, handler: onCancel });

  useDialogA11y(containerRef, {
    isOpen,
    onCancel,
    mnemonics,
    initialFocus: destructive ? 'cancel' : 'confirm',
  });

  if (!isOpen) return null;

  return (
    <div className="confirm-dialog-overlay" onClick={onCancel}>
      <div
        className="confirm-dialog"
        ref={containerRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="confirm-dialog-header">
          <h3 id={titleId}>{title}</h3>
        </div>
        <div className="confirm-dialog-body">
          {typeof message === 'string' ? <p>{message}</p> : message}
        </div>
        <div className="confirm-dialog-footer">
          <button className="confirm-btn cancel" data-dialog-cancel onClick={onCancel}>
            {cancelMnemonic ? <Mnemonic label={cancelText} char={cancelMnemonic} /> : cancelText}
          </button>
          <button className="confirm-btn confirm" data-dialog-confirm onClick={onConfirm}>
            {confirmMnemonic ? (
              <Mnemonic label={confirmText} char={confirmMnemonic} />
            ) : (
              confirmText
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
