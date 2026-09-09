import React from 'react';
import { useSelector } from 'react-redux';
import type { RootState } from '../../store';
import { EyeIcon } from './EyeIcon';
import './canvasHiddenBadge.css';

const CanvasHiddenBadge: React.FC<{ count: number; tab: boolean }> = React.memo(({ count, tab }) => {
  if (count === 0) return null;
  const title = tab ? `${count} terminal${count === 1 ? '' : 's'} in this tab ${count === 1 ? 'is' : 'are'} hidden from the canvas` : 'Hidden from the canvas';
  return <span className="canvas-hidden-badge" title={title}><EyeIcon slashed size={14} />{tab && count > 1 && <span>{`+${count - 1}`}</span>}</span>;
});

const CanvasHiddenForTerminalImpl: React.FC<{ terminalId: string | null }> = ({ terminalId }) => {
  const hidden = useSelector((s: RootState) => terminalId ? !!s.canvas.hidden[terminalId] : false);
  return <CanvasHiddenBadge count={hidden ? 1 : 0} tab={false} />;
};

export const CanvasHiddenForTerminal = React.memo(CanvasHiddenForTerminalImpl);

/** Deliberately not memoised: tab terminal-id arrays are rebuilt by the host each render. */
export const CanvasHiddenForTerminals: React.FC<{ terminalIds: readonly string[] }> = ({ terminalIds }) => {
  const count = useSelector((s: RootState) => terminalIds.reduce((n, id) => n + (s.canvas.hidden[id] ? 1 : 0), 0));
  return <CanvasHiddenBadge count={count} tab />;
};
