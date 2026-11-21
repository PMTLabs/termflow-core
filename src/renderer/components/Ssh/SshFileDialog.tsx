import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDialogA11y } from '../UI/useDialogA11y';
import '../UI/ConfirmDialog.css';

interface Props {
  title: string;
  onCancel(): void;
  onSubmit?(): void;
  children: React.ReactNode;
  footer: React.ReactNode;
}

/**
 * 068 F5 (handed to plan 070 T4): restore focus to the trigger only while its SSH presentation
 * still owns interaction. The pane presentation stays laid out (and, on Canvas, a node stays
 * visible) after it hands interaction to the other presentation; a dialog closing there must not
 * pull focus back into it. A trigger no longer connected never restores (there is nothing to
 * return to on that surface). A trigger outside any SSH shell (the standalone browser) keeps the
 * default restore.
 */
export function sshShellOwnsFocusRestore(trigger: HTMLElement): boolean {
  if (!trigger.isConnected) return false;
  const shell = trigger.closest('.ssh-pane-shell');
  return !shell || shell.getAttribute('data-ssh-interaction-owner') === 'true';
}

export function SshFileDialog({ title, onCancel, onSubmit, children, footer }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogA11y(ref, { isOpen: true, onCancel, initialFocus: 'cancel', restoreFocusIf: sshShellOwnsFocusRestore });
  return createPortal(<div className="confirm-dialog-overlay" onClick={onCancel}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} data-ssh-keyboard-owner=""
      className="confirm-dialog ssh-file-dialog" onClick={event => event.stopPropagation()}>
      <div className="confirm-dialog-header"><h3 id={titleId}>{title}</h3></div>
      <form onSubmit={event => { event.preventDefault(); onSubmit?.(); }}>
        <div className="confirm-dialog-body">{children}</div>
        <div className="confirm-dialog-footer">{footer}</div>
      </form>
    </div>
  </div>, document.body);
}
