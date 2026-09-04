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
  /**
   * Is the primary action itself destructive?
   *
   * Two effects, and it used to have only the first: focus defaults to Cancel
   * so a stray Enter never fires it, AND the confirm button is red rather than
   * accent. The colour used to be unconditional, which made it say nothing —
   * `Restore`, `Bring back`, `Activate` and `Update` were as red as `Delete`,
   * so a genuinely dangerous confirm looked exactly like a safe one.
   */
  destructive?: boolean;
  /** Bare-letter shortcut + underlined mnemonic for the confirm button, e.g. "C". */
  confirmMnemonic?: string;
  /** Bare-letter shortcut + underlined mnemonic for the cancel button, e.g. "A". */
  cancelMnemonic?: string;
  /**
   * An optional THIRD action, sitting between Cancel and the primary — the reversible middle
   * ground, offered before the destructive one: *"Switch off instead"* beside *Delete*.
   *
   * Both props are required together and both are optional: with neither, this dialog renders
   * exactly the two buttons it always has, which is what keeps every existing caller unchanged.
   * Generalising a dialog for a second caller with every addition optional is precedented here —
   * `UnsavedChangesDialog`'s own doc comment records the same move.
   */
  secondaryText?: string;
  onSecondary?: () => void;
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
  secondaryText,
  onSecondary,
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
  // `z-index: 9999` was capped at an effective 100 and painted BEHIND what Canvas Mode was
  // then — a full-surface overlay at 900. Closing a tab from the canvas showed no
  // confirmation at all, and the app looked frozen until you left the mode.
  //
  // Canvas Mode has since become a tab, so that particular overlay is gone. The fix is not:
  // the trap is `.title-bar-tabs` being a stacking context, which is still true, and the
  // next thing to paint above 100 would hit it identically. A modal has to be a child of
  // <body>.
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
          {secondaryText && onSecondary && (
            <button className="confirm-btn secondary" onClick={onSecondary}>
              {secondaryText}
            </button>
          )}
          <button
            className={`confirm-btn ${destructive ? 'danger' : 'primary'}`}
            data-dialog-confirm
            onClick={onConfirm}
          >
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
