import React, { useId, useRef } from 'react';
import './ConfirmDialog.css';
import { useDialogA11y, Mnemonic as MnemonicType } from './useDialogA11y';
import { Mnemonic } from './Mnemonic';

interface Props {
  isOpen: boolean;
  /** The dirty scope being asked about, e.g. a Settings category name. Only used by
   *  the DEFAULT body copy below — a caller that supplies its own `body` (plan/025's
   *  Layout Manager, which has no "category") can omit it. */
  categoryLabel?: string;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
  /** Dialog heading. Defaults to today's exact copy ("Unsaved changes"). */
  title?: string;
  /** Dialog body. Defaults to the `categoryLabel` sentence below (today's exact copy)
   *  when omitted. */
  body?: React.ReactNode;
  /** Save button label. Defaults to "Save". `Mnemonic` requires its `char` to actually
   *  appear in the label it underlines — pass `saveMnemonic` alongside a custom
   *  `saveLabel` that no longer contains 'S'. */
  saveLabel?: string;
  saveMnemonic?: string;
  /** Discard button label. Defaults to "Discard" — same `discardMnemonic` pairing
   *  rule as `saveLabel`/`saveMnemonic` above. */
  discardLabel?: string;
  discardMnemonic?: string;
}

/**
 * Three-action unsaved-changes prompt (Save / Discard / Cancel). Mirrors
 * ConfirmDialog's structure + a11y; adds a third (destructive) Discard button.
 * Save is the primary action (initial focus); Esc / Cancel dismisses.
 *
 * Generalised (plan/025 §2.6) for a second caller — the Layout Manager's dirty-switch
 * gate — beyond its original Settings-category caller. Every addition above is
 * optional and defaults to Settings' exact original copy/mnemonics, so that caller
 * (SettingsPage.tsx) is unaffected.
 */
export const UnsavedChangesDialog: React.FC<Props> = ({
  isOpen,
  categoryLabel,
  onSave,
  onDiscard,
  onCancel,
  title = 'Unsaved changes',
  body,
  saveLabel = 'Save',
  saveMnemonic = 'S',
  discardLabel = 'Discard',
  discardMnemonic = 'D',
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  const mnemonics: MnemonicType[] = [
    { key: saveMnemonic, handler: onSave },
    { key: discardMnemonic, handler: onDiscard },
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
          <h3 id={titleId}>{title}</h3>
        </div>
        <div className="confirm-dialog-body">
          {body ?? (
            <p>
              You have unsaved changes in <strong>{categoryLabel}</strong>. Save them, discard them,
              or cancel?
            </p>
          )}
        </div>
        <div className="confirm-dialog-footer">
          <button className="confirm-btn cancel" data-dialog-cancel onClick={onCancel}>
            <Mnemonic label="Cancel" char="C" />
          </button>
          <button className="confirm-btn destructive" onClick={onDiscard}>
            <Mnemonic label={discardLabel} char={discardMnemonic} />
          </button>
          <button className="confirm-btn primary" data-dialog-confirm onClick={onSave}>
            <Mnemonic label={saveLabel} char={saveMnemonic} />
          </button>
        </div>
      </div>
    </div>
  );
};
