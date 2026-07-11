import { configureStore } from '@reduxjs/toolkit';
import panesReducer, { splitPaneWithTab } from '../panesSlice';
import { takeInitialCwd } from '../../../services/initialCwd';

describe('splitPaneWithTab cwd inheritance', () => {
  it('stashes the inherited cwd under the new terminalId', async () => {
    const store = configureStore({ reducer: { panes: panesReducer } });
    const result: any = await store.dispatch(
      splitPaneWithTab({ paneId: 'pn-x', direction: 'vertical', cwd: 'D:\\work' }) as any
    );
    const newTerminalId = result.payload.newTerminalId as string;
    expect(takeInitialCwd(newTerminalId)).toBe('D:\\work');
  });

  it('stashes nothing when no cwd is supplied', async () => {
    const store = configureStore({ reducer: { panes: panesReducer } });
    const result: any = await store.dispatch(
      splitPaneWithTab({ paneId: 'pn-y', direction: 'horizontal' }) as any
    );
    const newTerminalId = result.payload.newTerminalId as string;
    expect(takeInitialCwd(newTerminalId)).toBeUndefined();
  });
});
