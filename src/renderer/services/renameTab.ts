import { store } from '../store';
import { updateTabTitle } from '../store/slices/tabsSlice';
import { renameTabProcesses } from './tabProcessIds';
import { StateManager } from './StateManager';

/**
 * Rename a tab, everywhere a tab's name lives.
 *
 * Centralised here for the same reason as `paneActions`: there is now more than one way to
 * rename a tab — the tab strip, the Canvas Mode group menu, and the canvas sidebar's group
 * header — and a rename is three writes, not one:
 *
 *  1. the store title, through `updateTabTitle` so `titleIsCustom` pins it against the shell's
 *     own OSC auto-title (`setAutoTabTitle` refuses to overwrite a custom name);
 *  2. the backend name of EVERY live leaf process, because a tab title is tab-level and a split
 *     tab owns several (re-review 111 finding 3);
 *  3. a save, so the name is still there after a restart.
 *
 * Each entry point that re-implements this drops a different one of the three. `CanvasSidebar`
 * had already dropped (2) and (3) before this existed.
 *
 * `saveState` is called directly rather than behind the `setTimeout(100)` the tab strip used:
 * a Redux dispatch is synchronous, so the title is in the store before the awaited backend
 * rename above it even starts, and a timer here only makes the write harder to observe.
 */
export async function renameTab(tabId: string, title: string): Promise<void> {
  const trimmed = title.trim();
  // A cleared box committed on blur is a cancel. A tab named '' is an unclickable sliver in the
  // strip and an invisible group label on the canvas — there is no way back from it in the UI.
  if (!trimmed) return;

  store.dispatch(updateTabTitle({ id: tabId, title: trimmed }));

  const tree = store.getState().panes.treesByTabId[tabId] ?? null;
  const renamed = await renameTabProcesses(tree, tabId, trimmed);
  console.log(`renameTab: renamed backend processes [${renamed.join(', ')}] to "${trimmed}"`);

  await StateManager.saveState();
}

export default renameTab;
