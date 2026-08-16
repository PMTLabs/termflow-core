import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
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

  // PORTALLED TO <body>, and that is a correctness requirement rather than tidiness.
  // Rendered in place, this dialog sits wherever its caller does — and `TabManager`'s
  // caller lives inside `.title-bar-tabs`, which is `position: relative; z-index: 100`
  // and therefore a STACKING CONTEXT. A descendant cannot escape one, so the overlay's
  // `z-index: 9999` was capped at an effective 100 and painted BEHIND Canvas Mode's
  // overlay at 900: closing a tab from the canvas showed no confirmation at all, and the
  // app looked frozen until you left the mode. A modal has to be a child of <body>.
  return createPortal(
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
    </div>,
    document.body,
  );
};
