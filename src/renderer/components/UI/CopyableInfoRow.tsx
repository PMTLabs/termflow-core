import React, { useState } from 'react';

/**
 * An ID/info row showing a label, its value, and an inline copy button on the
 * right. Used by the tab and pane context menus so each ID can be copied in
 * place. Copying does NOT close the surrounding menu, so several values can be
 * copied in a row. Relies on `.info-row` / `.info-label` / `.info-value` /
 * `.info-copy-btn` styles defined alongside each menu.
 */
export const CopyableInfoRow: React.FC<{ label: string; value: string }> = ({ label, value }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1000);
    }).catch(err => console.error(`Failed to copy ${label}:`, err));
  };

  const name = label.replace(/:$/, '');
  return (
    <div className="info-row">
      <span className="info-label">{label}</span>
      <span className="info-value" title={value}>{value}</span>
      <button
        className="info-copy-btn"
        onClick={handleCopy}
        title={`Copy ${name}`}
        aria-label={`Copy ${name}`}
      >
        {copied ? '✓' : '📋'}
      </button>
    </div>
  );
};
