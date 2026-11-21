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

export function SshFileDialog({ title, onCancel, onSubmit, children, footer }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useDialogA11y(ref, { isOpen: true, onCancel, initialFocus: 'cancel' });
  return createPortal(<div className="confirm-dialog-overlay" onClick={onCancel}>
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
      className="confirm-dialog ssh-file-dialog" onClick={event => event.stopPropagation()}>
      <div className="confirm-dialog-header"><h3 id={titleId}>{title}</h3></div>
      <form onSubmit={event => { event.preventDefault(); onSubmit?.(); }}>
        <div className="confirm-dialog-body">{children}</div>
        <div className="confirm-dialog-footer">{footer}</div>
      </form>
    </div>
  </div>, document.body);
}
