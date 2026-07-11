import React, { useId, useRef } from 'react';
import './ConfirmDialog.css';
import { useDialogA11y, Mnemonic as MnemonicType } from './useDialogA11y';
import { Mnemonic } from './Mnemonic';

interface Props {
  isOpen: boolean;
  categoryLabel: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

/**
 * Three-action unsaved-changes prompt (Save / Discard / Cancel). Mirrors
 * ConfirmDialog's structure + a11y; adds a third (destructive) Discard button.
 * Save is the primary action (initial focus); Esc / Cancel dismisses.
 */
export const UnsavedChangesDialog: React.FC<Props> = ({
  isOpen,
  categoryLabel,
  onSave,
  onDiscard,
  onCancel,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const mnemonics: MnemonicType[] = [
    { key: 'S', handler: onSave },
    { key: 'D', handler: onDiscard },
    { key: 'C', handler: onCancel },
  ];

  useDialogA11y(containerRef, { isOpen, onCancel, mnemonics, initialFocus: 'confirm' });

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
          <h3 id={titleId}>Unsaved changes</h3>
        </div>
        <div className="confirm-dialog-body">
          <p>
            You have unsaved changes in <strong>{categoryLabel}</strong>. Save them, discard them,
            or cancel?
          </p>
        </div>
        <div className="confirm-dialog-footer">
          <button className="confirm-btn cancel" data-dialog-cancel onClick={onCancel}>
            <Mnemonic label="Cancel" char="C" />
          </button>
          <button className="confirm-btn destructive" onClick={onDiscard}>
            <Mnemonic label="Discard" char="D" />
          </button>
          <button className="confirm-btn primary" data-dialog-confirm onClick={onSave}>
            <Mnemonic label="Save" char="S" />
          </button>
        </div>
      </div>
    </div>
  );
};
