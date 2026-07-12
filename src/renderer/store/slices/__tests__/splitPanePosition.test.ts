import { configureStore } from '@reduxjs/toolkit';
import panesReducer, { splitPaneWithTab, initializePane, setActiveTabId } from '../panesSlice';

/**
 * Directional pane split: `position` controls which side of the original pane
 * the NEW pane lands on. 'after' (default) = bottom/right, 'before' = top/left.
 * Used by the context-menu items "Open New Pane Right/Left/Up/Down".
 */
describe('splitPaneWithTab position', () => {
  const setup = () => {
    const store = configureStore({ reducer: { panes: panesReducer } });
    store.dispatch(setActiveTabId('tb-1'));
    store.dispatch(initializePane({ terminalId: 'tb-1' }));
    const paneId = (store.getState().panes.paneTree as any).id as string;
    return { store, paneId };
  };

  it("defaults to 'after': new pane is the second child (right)", async () => {
    const { store, paneId } = setup();
    const result: any = await store.dispatch(
      splitPaneWithTab({ paneId, direction: 'vertical' }) as any
    );
    const tree: any = store.getState().panes.paneTree;
    expect(tree.type).toBe('split');
    expect(tree.children[1].terminalId).toBe(result.payload.newTerminalId);
    expect(tree.children[1].name).toBe('Terminal Right');
    expect(tree.children[0].name).toBe('Terminal Left');
  });

  it("'before' + vertical puts the new pane first (left)", async () => {
    const { store, paneId } = setup();
    const result: any = await store.dispatch(
      splitPaneWithTab({ paneId, direction: 'vertical', position: 'before' }) as any
    );
    const tree: any = store.getState().panes.paneTree;
    expect(tree.children[0].terminalId).toBe(result.payload.newTerminalId);
    expect(tree.children[0].name).toBe('Terminal Left');
    expect(tree.children[1].name).toBe('Terminal Right');
  });

  it("'before' + horizontal puts the new pane first (top)", async () => {
    const { store, paneId } = setup();
    const result: any = await store.dispatch(
      splitPaneWithTab({ paneId, direction: 'horizontal', position: 'before' }) as any
    );
    const tree: any = store.getState().panes.paneTree;
    expect(tree.direction).toBe('horizontal');
    expect(tree.children[0].terminalId).toBe(result.payload.newTerminalId);
    expect(tree.children[0].name).toBe('Terminal Top');
    expect(tree.children[1].name).toBe('Terminal Bottom');
  });

  it('focuses the new pane regardless of position', async () => {
    const { store, paneId } = setup();
    await store.dispatch(
      splitPaneWithTab({ paneId, direction: 'vertical', position: 'before' }) as any
    );
    const state = store.getState().panes;
    const tree: any = state.paneTree;
    expect(state.activePaneId).toBe(tree.children[0].id);
  });
});
