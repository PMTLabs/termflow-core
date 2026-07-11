import React, { useCallback } from 'react';
import { usePaneDragContext } from './PaneDragController';

export interface UsePaneDragSource {
  terminalId: string;
  sourcePaneId: string;
  name?: string;
  shellType?: string;
}

/**
 * Returns an `onPointerDown` handler for a pane's title bar. The drag's source
 * tab is resolved from the DOM (`[data-tab-id]` ancestor) so no tab id needs to
 * be threaded through props. Clicks on buttons/inputs are ignored so the
 * existing header controls and double-click-rename keep working.
 */
export function usePaneDrag(source: UsePaneDragSource): (e: React.PointerEvent) => void {
  const { beginPress } = usePaneDragContext();
  return useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const tgt = e.target as HTMLElement;
      if (tgt.closest('button') || tgt.closest('input')) return;
      const tabEl = (e.currentTarget as HTMLElement).closest('[data-tab-id]') as HTMLElement | null;
      const sourceTabId = tabEl?.getAttribute('data-tab-id') || '';
      if (!sourceTabId) return;
      beginPress(e, { ...source, sourceTabId });
    },
    [beginPress, source.terminalId, source.sourcePaneId, source.name, source.shellType],
  );
}
