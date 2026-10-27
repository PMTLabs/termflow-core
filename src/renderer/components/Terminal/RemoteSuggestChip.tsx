import React from 'react';
import { useDispatch } from 'react-redux';
import { addToast } from '../../store/slices/uiSlice';
import { writeClipboardText } from '../../utils/clipboard';
import {
  REMOTE_HOOK_SHELLS,
  REMOTE_HOOK_SNIPPETS,
  type RemoteHookShell,
} from './remoteHookSnippets';
import './RemoteSuggestChip.css';

interface RemoteSuggestChipProps {
  onDismiss: () => void;
}

/**
 * Offered while ssh is the foreground program in a tab whose local shell proved it renders
 * prompt marks (plan 061). The command-suggest popup is off at the remote prompt until that
 * host sends a prompt mark too; this hands the user a one-line hook to paste there.
 *
 * It only COPIES. Nothing is written to the pty: the remote end may be a pager, an editor or
 * an agent CLI, and text typed into those is not ours to place.
 */
export const RemoteSuggestChip: React.FC<RemoteSuggestChipProps> = ({ onDismiss }) => {
  const dispatch = useDispatch();
  const copy = (shell: RemoteHookShell) => {
    void writeClipboardText(REMOTE_HOOK_SNIPPETS[shell]).then(
      () => dispatch(addToast({ message: `Copied the ${shell} hook. Paste it at the remote prompt.`, type: 'success', duration: 4000 })),
      () => dispatch(addToast({ message: 'Could not copy the hook to the clipboard', type: 'error' })),
    );
  };

  return (
    <div className="remote-suggest-chip" role="group" aria-label="Enable command suggestions on this host">
      <span className="remote-suggest-chip-label">Suggestions are off over ssh. Copy hook:</span>
      {REMOTE_HOOK_SHELLS.map((shell) => (
        <button
          key={shell}
          type="button"
          className="remote-suggest-chip-btn"
          title={`Copy a one-line ${shell} hook, then paste it at the remote prompt`}
          onClick={() => copy(shell)}
        >
          {shell}
        </button>
      ))}
      <button
        type="button"
        className="remote-suggest-chip-btn remote-suggest-chip-close"
        title="Hide for this tab"
        aria-label="Hide for this tab"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
};
