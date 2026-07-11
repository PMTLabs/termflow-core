import terminalsReducer, {
  fetchTerminals,
  resetTerminal,
  selectTerminal,
  updateTerminalStatus,
  toggleTerminalSelection,
  selectMultipleTerminals,
  clearSelection,
} from './terminalsSlice';
import { Terminal } from '../../types/terminal';
import axios from 'axios';

// Mock axios
jest.mock('axios');

interface TerminalsState {
  terminals: Terminal[];
  selectedTerminalId: string | null;
  selectedTerminalIds: string[];
  loading: boolean;
  error: string | null;
  lastFetchTime: number;
  lastFetchId: number | null;
  hasInitiallyFetched: boolean;
}

describe('terminalsSlice', () => {
  const mockTerminal1: Terminal = {
    id: 'term-1',
    name: 'Terminal 1',
    profile: 'bash',
    processId: 'proc-1',
    status: 'running',
    createdAt: '2023-01-01T00:00:00Z',
  };

  const mockTerminal2: Terminal = {
    id: 'term-2',
    name: 'Terminal 2',
    profile: 'cmd',
    processId: 'proc-2',
    status: 'running',
    createdAt: '2023-01-01T00:00:00Z',
  };

  const initialState: TerminalsState = {
    terminals: [],
    selectedTerminalId: null,
    selectedTerminalIds: [],
    loading: false,
    error: null,
    lastFetchTime: 0,
    lastFetchId: null,
    hasInitiallyFetched: false,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('reducer', () => {
    it('should return the initial state', () => {
      expect(terminalsReducer(undefined, { type: 'unknown' })).toEqual(
        initialState
      );
    });
  });

  describe('fetchTerminals', () => {
    it('should handle successful fetch', async () => {
      const mockTerminals = [mockTerminal1, mockTerminal2];
      const mockAxios = axios as jest.Mocked<typeof axios>;
      mockAxios.get.mockResolvedValue({
        data: { terminals: mockTerminals },
      });

      const dispatch = jest.fn();
      const getState = jest.fn(() => ({
        terminals: { lastFetchId: 123 },
      }));

      await fetchTerminals()(dispatch, getState, undefined);

      expect(mockAxios.get).toHaveBeenCalledWith('/api/terminals');
      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: fetchTerminals.fulfilled.type,
          payload: expect.objectContaining({
            terminals: mockTerminals,
            fetchId: expect.any(Number),
            previousFetchId: 123,
          }),
        })
      );
    });

    it('should handle fetch failure', async () => {
      const mockError = new Error('Failed to fetch terminals');
      const mockAxios = axios as jest.Mocked<typeof axios>;
      mockAxios.get.mockRejectedValue(mockError);

      const dispatch = jest.fn();
      const getState = jest.fn(() => ({
        terminals: { lastFetchId: 123 },
      }));

      await fetchTerminals()(dispatch, getState, undefined);

      expect(dispatch).toHaveBeenCalledWith(
        expect.objectContaining({
          type: fetchTerminals.rejected.type,
          error: expect.objectContaining({
            message: 'Failed to fetch terminals',
          }),
        })
      );
    });
  });

  describe('slice reducers', () => {
    describe('selectTerminal', () => {
      it('should select a terminal', () => {
        const stateWithTerminals: TerminalsState = {
          ...initialState,
          terminals: [mockTerminal1, mockTerminal2],
        };
        const action = selectTerminal('term-1');
        const state = terminalsReducer(stateWithTerminals, action);
        expect(state.selectedTerminalId).toBe('term-1');
      });

      it('should deselect when selecting null', () => {
        const stateWithSelection: TerminalsState = {
          ...initialState,
          terminals: [mockTerminal1, mockTerminal2],
          selectedTerminalId: 'term-1',
        };
        const action = selectTerminal(null);
        const state = terminalsReducer(stateWithSelection, action);
        expect(state.selectedTerminalId).toBe(null);
      });
    });

    describe('updateTerminalStatus', () => {
      it('should update terminal status', () => {
        const stateWithTerminals: TerminalsState = {
          ...initialState,
          terminals: [mockTerminal1, mockTerminal2],
        };
        const action = updateTerminalStatus({
          id: 'term-1',
          status: 'exited',
        });
        const state = terminalsReducer(stateWithTerminals, action);
        expect(state.terminals[0].status).toBe('exited');
      });

      it('should not update if terminal not found', () => {
        const stateWithTerminals: TerminalsState = {
          ...initialState,
          terminals: [mockTerminal1, mockTerminal2],
        };
        const action = updateTerminalStatus({
          id: 'term-999',
          status: 'exited',
        });
        const state = terminalsReducer(stateWithTerminals, action);
        expect(state).toEqual(stateWithTerminals);
      });
    });

    describe('toggleTerminalSelection', () => {
      it('should add terminal to selection', () => {
        const state = terminalsReducer(
          initialState,
          toggleTerminalSelection('term-1')
        );
        expect(state.selectedTerminalIds).toContain('term-1');
      });

      it('should remove terminal from selection if already selected', () => {
        const stateWithSelection: TerminalsState = {
          ...initialState,
          selectedTerminalIds: ['term-1', 'term-2'],
        };
        const state = terminalsReducer(
          stateWithSelection,
          toggleTerminalSelection('term-1')
        );
        expect(state.selectedTerminalIds).toEqual(['term-2']);
      });
    });

    describe('selectMultipleTerminals', () => {
      it('should set multiple terminals as selected', () => {
        const terminalIds = ['term-1', 'term-2', 'term-3'];
        const state = terminalsReducer(
          initialState,
          selectMultipleTerminals(terminalIds)
        );
        expect(state.selectedTerminalIds).toEqual(terminalIds);
      });
    });

    describe('clearSelection', () => {
      it('should clear all selections', () => {
        const stateWithSelection: TerminalsState = {
          ...initialState,
          selectedTerminalIds: ['term-1', 'term-2'],
        };
        const state = terminalsReducer(stateWithSelection, clearSelection());
        expect(state.selectedTerminalIds).toEqual([]);
      });
    });

    describe('fetchTerminals async actions', () => {
      it('should handle fetchTerminals.pending on first fetch', () => {
        const action = { type: fetchTerminals.pending.type };
        const state = terminalsReducer(initialState, action);
        expect(state.loading).toBe(true);
        expect(state.error).toBe(null);
      });

      it('should not show loading on subsequent fetches', () => {
        const stateAfterFirstFetch: TerminalsState = {
          ...initialState,
          hasInitiallyFetched: true,
        };
        const action = { type: fetchTerminals.pending.type };
        const state = terminalsReducer(stateAfterFirstFetch, action);
        expect(state.loading).toBe(false);
      });

      it('should handle fetchTerminals.fulfilled', () => {
        const mockTerminals = [mockTerminal1, mockTerminal2];
        const action = {
          type: fetchTerminals.fulfilled.type,
          payload: {
            terminals: mockTerminals,
            fetchId: 12345,
            previousFetchId: null,
          },
        };
        const state = terminalsReducer(initialState, action);
        expect(state.terminals).toEqual(mockTerminals);
        expect(state.loading).toBe(false);
        expect(state.error).toBe(null);
        expect(state.lastFetchId).toBe(12345);
        expect(state.hasInitiallyFetched).toBe(true);
      });

      it('should handle fetchTerminals.rejected', () => {
        const mockError = 'Failed to fetch';
        const action = {
          type: fetchTerminals.rejected.type,
          error: { message: mockError },
        };
        const state = terminalsReducer(initialState, action);
        expect(state.loading).toBe(false);
        expect(state.error).toBe(mockError);
      });

      it('should preserve selected terminal when updating list', () => {
        const stateWithSelection: TerminalsState = {
          ...initialState,
          terminals: [mockTerminal1],
          selectedTerminalId: 'term-1',
        };
        const updatedTerminals = [
          { ...mockTerminal1, status: 'exited' as const },
          mockTerminal2,
        ];
        const action = {
          type: fetchTerminals.fulfilled.type,
          payload: {
            terminals: updatedTerminals,
            fetchId: 12346,
            previousFetchId: 12345,
          },
        };
        const state = terminalsReducer(stateWithSelection, action);
        expect(state.selectedTerminalId).toBe('term-1');
        expect(state.terminals).toEqual(updatedTerminals);
      });

      it('should clear selection if selected terminal is removed', () => {
        const stateWithSelection: TerminalsState = {
          ...initialState,
          terminals: [mockTerminal1, mockTerminal2],
          selectedTerminalId: 'term-1',
        };
        const action = {
          type: fetchTerminals.fulfilled.type,
          payload: {
            terminals: [mockTerminal2], // term-1 is removed
            fetchId: 12347,
            previousFetchId: 12346,
          },
        };
        const state = terminalsReducer(stateWithSelection, action);
        expect(state.selectedTerminalId).toBe(null);
      });
    });

    describe('resetTerminal async actions', () => {
      it('should handle resetTerminal.pending', () => {
        const stateWithTerminal: TerminalsState = {
          ...initialState,
          terminals: [mockTerminal1, mockTerminal2],
        };
        const action = {
          type: resetTerminal.pending.type,
          meta: { arg: 'term-1' },
        };
        const state = terminalsReducer(stateWithTerminal, action);
        expect(state.terminals[0].status).toBe('resetting');
        expect(state.terminals[1].status).toBe('running'); // unchanged
      });

      it('should handle resetTerminal.fulfilled', () => {
        const stateWithTerminal: TerminalsState = {
          ...initialState,
          terminals: [{ ...mockTerminal1, status: 'resetting' as const }],
        };
        const resetResponse = {
          id: 'term-1',
          processId: 'new-proc-1',
          name: 'Terminal 1',
          profile: 'bash',
          status: 'running',
          createdAt: '2023-01-01T01:00:00Z',
        };
        const action = {
          type: resetTerminal.fulfilled.type,
          payload: resetResponse,
        };
        const state = terminalsReducer(stateWithTerminal, action);
        expect(state.terminals[0]).toEqual({
          ...mockTerminal1,
          processId: 'new-proc-1',
          status: 'running',
          createdAt: '2023-01-01T01:00:00Z',
        });
        expect(state.lastFetchTime).toBeGreaterThan(0);
      });

      it('should handle resetTerminal.rejected', () => {
        const stateWithTerminal: TerminalsState = {
          ...initialState,
          terminals: [{ ...mockTerminal1, status: 'resetting' as const }],
        };
        const mockError = 'Reset failed';
        const action = {
          type: resetTerminal.rejected.type,
          meta: { arg: 'term-1' },
          error: { message: mockError },
        };
        const state = terminalsReducer(stateWithTerminal, action);
        expect(state.terminals[0].status).toBe('error');
        expect(state.error).toBe(mockError);
      });
    });
  });
});
