import React from 'react';
import './SessionClosedBanner.css';

interface SessionClosedBannerProps {
  exitCode: number | null;
  onRestart: () => void;
  onDismiss: () => void;
  /** Terminal font size (px) from settings; the banner scales relative to it. */
  fontSize?: number;
}

// Bottom-of-pane banner shown when a pane's process exits but the pane is kept
// open (tab terminals with closeTabOnProcessExit off, and all split panes). It
// surfaces the exit and offers a one-key restart in place (Ctrl+R is bound in
// TerminalPane while this banner is visible). Purely presentational.
export const SessionClosedBanner: React.FC<SessionClosedBannerProps> = ({
  exitCode,
  onRestart,
  onDismiss,
  fontSize,
}) => {
  const codeLabel = exitCode === null ? '' : ` (exit ${exitCode})`;

  return (
    <div
      className="session-closed-banner"
      role="status"
      aria-live="polite"
      style={fontSize ? { fontSize: `${fontSize}px` } : undefined}
    >
      <button
        className="session-closed-banner__close"
        onClick={onDismiss}
        title="Dismiss"
        aria-label="Dismiss"
      >
        ×
      </button>
      <div className="session-closed-banner__text">
        <span className="session-closed-banner__title">Session closed{codeLabel}</span>
        <span className="session-closed-banner__hint">
          Press <kbd>Ctrl</kbd>+<kbd>R</kbd> to start a new session
        </span>
      </div>
      <div className="session-closed-banner__actions">
        <button
          className="session-closed-banner__button session-closed-banner__button--primary"
          onClick={onRestart}
        >
          Restart
        </button>
        <button className="session-closed-banner__button" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
};
