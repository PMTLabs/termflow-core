import React from 'react';
import './ScrollToBottomButton.css';

interface ScrollToBottomButtonProps {
  visible: boolean;
  onClick: () => void;
}

/**
 * Floating button in the pane's bottom-right corner. Shown only while the
 * viewport is scrolled away from the live tail (see TerminalEngine's
 * isScrolledToBottom/onScrollPosition, driven by TerminalDisplay). Unlike the
 * purely-informational AgentChip, this must be clickable.
 */
export const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({ visible, onClick }) => {
  if (!visible) return null;

  return (
    <button
      type="button"
      className="scroll-to-bottom-button"
      onClick={onClick}
      title="Scroll to bottom"
      aria-label="Scroll to bottom"
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
        <path
          d="M3 6l5 5 5-5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </button>
  );
};
