import { useCallback, useEffect, useState, type MutableRefObject } from 'react';
import { useSelector } from 'react-redux';
import type { PromptMarkState, TerminalEngine } from '@termflow/terminal-core';
import type { RootState } from '../../store';
import { agentSchemeTracker } from '../../services/AgentSchemeTracker';
import {
  dismissRemoteHint,
  isRemoteHintDismissed,
  shouldShowRemoteHint,
} from './remoteSuggestHint';

/**
 * Whether to show the "enable suggestions on this host" chip for a terminal (plan 061).
 *
 * Two inputs arrive by different routes and neither is read from private engine state:
 * the foreground program from the tracker's poll (its subscription fires when ssh
 * becomes or stops being the foreground), and the prompt-mark knowledge from the
 * engine's own `onPromptMark` subscription, which also reports once on subscribe so an
 * engine created after the last mark is not missed. `engineGeneration` re-runs the
 * engine subscription for each newly mounted engine — `engineRef` alone would not,
 * because writing a ref triggers no render.
 */
export function useRemoteSuggestHint(
  terminalId: string,
  engineRef: MutableRefObject<TerminalEngine | null>,
  engineGeneration: number,
): { show: boolean; dismiss: () => void } {
  const suggestEnabled = useSelector((s: RootState) => s.settings.commandSuggestions);
  const [sshForeground, setSshForeground] = useState(() => agentSchemeTracker.isSshForeground(terminalId));
  const [mark, setMark] = useState<PromptMarkState | null>(null);
  const [dismissed, setDismissed] = useState(() => isRemoteHintDismissed(terminalId));

  useEffect(() => {
    const sync = () => setSshForeground(agentSchemeTracker.isSshForeground(terminalId));
    sync(); // terminalId can change under a mounted hook; the lazy initializer will not rerun
    setDismissed(isRemoteHintDismissed(terminalId));
    return agentSchemeTracker.subscribe(sync);
  }, [terminalId]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine) {
      setMark(null);
      return undefined;
    }
    return engine.onPromptMark(setMark);
    // engineRef is a stable ref; engineGeneration is the render-visible "new engine" signal.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineGeneration, terminalId]);

  const dismiss = useCallback(() => {
    dismissRemoteHint(terminalId);
    setDismissed(true);
  }, [terminalId]);

  return {
    show: shouldShowRemoteHint({ sshForeground, mark, suggestEnabled: !!suggestEnabled, dismissed }),
    dismiss,
  };
}
