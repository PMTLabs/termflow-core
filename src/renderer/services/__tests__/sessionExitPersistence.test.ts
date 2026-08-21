/**
 * @jest-environment jsdom
 *
 * `sessionExit` must never be persisted — `plan/024` Req 4.
 *
 * A restored workspace has not started its shells yet, so an entry surviving a restart would
 * draw a "Session closed" banner, and mute a canvas node, for a session that never ran. The
 * transient live-status flags next to it (`isRunning`, `hasUnseenOutput`) have exactly this
 * hazard and are stripped in `sanitizeLayoutData`.
 *
 * This one is safe for a stronger reason — `saveState` builds its blob from an explicit
 * ALLOWLIST, so a new slice is excluded by default rather than by remembering to strip it — and
 * that is precisely why it is worth a test. The protection is the SHAPE of one object literal,
 * which the next person to add a field to it can undo without noticing. Nothing else in the
 * codebase says "do not add sessionExit here".
 */
jest.mock('../../components/TerminalContainer', () => ({ clearTabPanes: jest.fn() }));
jest.mock('../tabPanesStore', () => ({ restoreTabPanesInPlace: jest.fn() }));

import { configureStore } from '@reduxjs/toolkit';
import tabsReducer from '../../store/slices/tabsSlice';
import panesReducer from '../../store/slices/panesSlice';
import settingsReducer from '../../store/slices/settingsSlice';
import canvasReducer from '../../store/slices/canvasSlice';
import sessionExitReducer, { markSessionClosed } from '../../store/slices/sessionExitSlice';
import { StateManager } from '../StateManager';

describe('saveState never persists sessionExit', () => {
  beforeEach(() => localStorage.clear());

  it('omits the slice even when terminals have exited', async () => {
    const store = configureStore({
      reducer: {
        tabs: tabsReducer,
        panes: panesReducer,
        settings: settingsReducer,
        canvas: canvasReducer,
        sessionExit: sessionExitReducer,
      },
    });
    store.dispatch(markSessionClosed({ terminalId: 'tm-1', exitCode: 137 }));
    (window as any).__REDUX_STORE__ = store;

    await StateManager.saveState();

    const keys = Object.keys(localStorage);
    expect(keys.length).toBeGreaterThan(0); // precondition: something really was written
    const blob = localStorage.getItem(keys[0])!;
    // Both the slice name and its payload: a field renamed on the way out would still leak the
    // exit code, and it is the VALUE that would resurrect a banner.
    expect(blob).not.toContain('sessionExit');
    expect(blob).not.toContain('137');
    expect(JSON.parse(blob).sessionExit).toBeUndefined();

    // ...and the store really did hold it, so the assertions above are not passing on an empty
    // slice (see [[test-arrange-right-assert-blind]]).
    expect(store.getState().sessionExit.byTerminalId['tm-1']).toEqual({ exitCode: 137 });
  });
});
