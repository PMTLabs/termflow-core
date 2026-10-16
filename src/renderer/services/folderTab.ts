import type { AnyAction, Dispatch } from '@reduxjs/toolkit';
import { addTab } from '../store/slices/tabsSlice';
import { addTabTree } from '../store/slices/panesSlice';
import { generateId } from '../utils/id';
import { setInitialCwd } from './initialCwd';

type NewTab = Parameters<typeof addTab>[0];

/**
 * "Open in TermFlow": add a tab whose first terminal spawns in `folderPath`.
 *
 * The initial cwd is keyed by the root pane's terminalId, and since design 014 that is a fresh
 * `tm-` id, NOT the tab id. So the tab's tree is seeded here (the id is then known) instead of
 * being left to TerminalContainer, which mints one this code cannot see. The leaf mirrors what
 * tabTreeSeed.candidateFor builds, including `elevated`.
 */
export function addTabRootedAt(dispatch: Dispatch<AnyAction>, newTab: NewTab, folderPath: string): void {
  const terminalId = generateId('tm');
  const tree = {
    id: generateId('pn'),
    type: 'terminal' as const,
    terminalId,
    seededForTabId: newTab.id,
    name: newTab.title || 'Terminal',
    shellType: newTab.shellType,
    elevated: newTab.elevated,
  };
  setInitialCwd(terminalId, folderPath);
  if (!(window as any).tabPanes) (window as any).tabPanes = {};
  (window as any).tabPanes[newTab.id] = tree;
  dispatch(addTab(newTab));
  dispatch(addTabTree({ tabId: newTab.id, tree }));
}
