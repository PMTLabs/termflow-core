import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import { cleanupTerminalCache } from '@termflow/terminal-core';
import axios from '../../services/axiosConfig';
import { Terminal } from '../../types/terminal';

interface TerminalsState {
  terminals: Terminal[];
  selectedTerminalId: string | null;
  selectedTerminalIds: string[]; // For multi-selection
  loading: boolean;
  error: string | null;
  lastFetchTime: number;
  lastFetchId: number | null;
  hasInitiallyFetched: boolean;
}

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

// Number of consecutive polls a previously-known terminal must be absent from
// the server response before its cached xterm + WS subscription is disposed.
const ABSENCE_THRESHOLD = 2;

// Tracks how many consecutive ~10s polls each previously-known terminal id has
// been missing. Module-level so it persists across thunk invocations. A single
// transient/partial/empty poll (terminal reappears next poll) must never dispose
// a still-alive terminal — only a genuine removal (absent on 2 consecutive
// polls) triggers cleanup.
const absenceCounts = new Map<string, number>();

// Async thunks
export const fetchTerminals = createAsyncThunk(
  'terminals/fetchTerminals',
  async (_, { getState }) => {
    const fetchId = Date.now(); // Use number instead of string
    console.log('Fetching terminals from API...');
    const previousTerminals = (getState() as any).terminals.terminals as Terminal[];
    const response = await axios.get('/api/terminals');
    console.log('API response:', response.data);
    const rawTerminals = response.data?.terminals;
    const newTerminals: Terminal[] = rawTerminals || [];

    // Cache-leak fix (terminal-core phase-4): the 10s poll replaces the terminal
    // list wholesale, so terminals closed server-side (not via deleteTerminal)
    // never trigger cleanup. Diff prev vs new ids here (in the thunk, keeping the
    // reducer pure) and free each vanished terminal's cached xterm + its
    // cache-lifetime WS subscription. cacheKey === terminalId (see TerminalView).
    //
    // 2-poll debounce: a transient/partial/empty/errored poll must not dispose a
    // still-alive terminal (which would blank its pane). Only run the diff on a
    // successful fetch with a valid array payload, and only dispose a vanished id
    // after it has been absent on ABSENCE_THRESHOLD consecutive polls. An id that
    // reappears (one-poll blip) has its counter reset and is never disposed.
    if (Array.isArray(rawTerminals)) {
      const newIds = new Set(newTerminals.map((t) => t.id));
      for (const prev of previousTerminals) {
        if (newIds.has(prev.id)) {
          // Still present — clear any pending absence so a future blip restarts
          // the count from zero.
          absenceCounts.delete(prev.id);
        } else {
          const count = (absenceCounts.get(prev.id) ?? 0) + 1;
          if (count >= ABSENCE_THRESHOLD) {
            cleanupTerminalCache(prev.id);
            absenceCounts.delete(prev.id);
          } else {
            absenceCounts.set(prev.id, count);
          }
        }
      }
    }

    return {
      terminals: newTerminals,
      fetchId,
      previousFetchId: (getState() as any).terminals.lastFetchId,
    };
  }
);

export const createTerminal = createAsyncThunk(
  'terminals/createTerminal',
  async (params: { name?: string; profile?: string }) => {
    const response = await axios.post('/api/terminals', params);
    return response.data;
  }
);

export const deleteTerminal = createAsyncThunk(
  'terminals/deleteTerminal',
  async (terminalId: string) => {
    await axios.delete(`/api/terminals/${terminalId}`);
    // Free the cached xterm instance + its cache-lifetime WS subscription so a
    // removed terminal does not leak. cacheKey === terminalId (see TerminalView).
    cleanupTerminalCache(terminalId);
    return terminalId;
  }
);

export const resetTerminal = createAsyncThunk(
  'terminals/resetTerminal',
  async (terminalId: string) => {
    const response = await axios.post(`/api/terminals/${terminalId}/reset`);
    return response.data;
  }
);

const terminalsSlice = createSlice({
  name: 'terminals',
  initialState,
  reducers: {
    selectTerminal: (state, action: PayloadAction<string | null>) => {
      state.selectedTerminalId = action.payload;
      // Clear multi-selection when selecting a single terminal
      state.selectedTerminalIds = action.payload ? [action.payload] : [];
    },
    toggleTerminalSelection: (state, action: PayloadAction<string>) => {
      const terminalId = action.payload;
      const index = state.selectedTerminalIds.indexOf(terminalId);
      if (index !== -1) {
        state.selectedTerminalIds.splice(index, 1);
      } else {
        state.selectedTerminalIds.push(terminalId);
      }
    },
    selectMultipleTerminals: (state, action: PayloadAction<string[]>) => {
      state.selectedTerminalIds = action.payload;
      // Update single selection to the first selected
      state.selectedTerminalId =
        action.payload.length > 0 ? action.payload[0] : null;
    },
    clearSelection: (state) => {
      state.selectedTerminalId = null;
      state.selectedTerminalIds = [];
    },
    updateTerminalStatus: (
      state,
      action: PayloadAction<{ id: string; status: 'running' | 'exited' | 'inactive' }>
    ) => {
      const index = state.terminals.findIndex(
        (t) => t.id === action.payload.id
      );
      if (index !== -1) {
        // Create a new terminal object to ensure immutability
        state.terminals[index] = {
          ...state.terminals[index],
          status: action.payload.status,
        };
      }
    },
  },
  extraReducers: (builder) => {
    builder
      // Fetch terminals
      .addCase(fetchTerminals.pending, (state, action) => {
        // Only show loading on the very first fetch
        if (!state.hasInitiallyFetched) {
          state.loading = true;
        }
      })
      .addCase(fetchTerminals.fulfilled, (state, action) => {
        const { terminals: newTerminals, fetchId } = action.payload;

        console.log(
          'fetchTerminals.fulfilled - received terminals:',
          newTerminals
        );
        console.log('Current loading state:', state.loading);

        // Always update loading to false when we get a response
        state.loading = false;
        state.error = null;
        state.terminals = newTerminals;
        state.lastFetchTime = Date.now();
        state.lastFetchId = fetchId;
        state.hasInitiallyFetched = true;

        // Check if selected terminal still exists
        if (state.selectedTerminalId) {
          const stillExists = newTerminals.some(
            (t: Terminal) => t.id === state.selectedTerminalId
          );
          if (!stillExists) {
            state.selectedTerminalId = null;
          }
        }
      })
      .addCase(fetchTerminals.rejected, (state, action) => {
        console.error('fetchTerminals.rejected:', action.error);
        // Only update if values actually change
        if (state.loading) {
          state.loading = false;
        }
        const errorMessage =
          action.error.message || 'Failed to fetch terminals';
        if (state.error !== errorMessage) {
          state.error = errorMessage;
        }
        state.hasInitiallyFetched = true;
      })
      // Create terminal
      .addCase(createTerminal.fulfilled, (state, action) => {
        state.terminals.push(action.payload);
        state.selectedTerminalId = action.payload.id;
        state.lastFetchTime = Date.now();
      })
      // Delete terminal
      .addCase(deleteTerminal.fulfilled, (state, action) => {
        state.terminals = state.terminals.filter(
          (t) => t.id !== action.payload
        );
        if (state.selectedTerminalId === action.payload) {
          state.selectedTerminalId =
            state.terminals.length > 0 ? state.terminals[0].id : null;
        }
        state.lastFetchTime = Date.now();
      })
      // Reset terminal
      .addCase(resetTerminal.pending, (state, action) => {
        const terminalId = action.meta.arg;
        const index = state.terminals.findIndex((t) => t.id === terminalId);
        if (index !== -1) {
          // Mark terminal as resetting
          state.terminals[index].status = 'resetting';
        }
      })
      .addCase(resetTerminal.fulfilled, (state, action) => {
        const index = state.terminals.findIndex(
          (t) => t.id === action.payload.id
        );
        if (index !== -1) {
          // Update the terminal with the new process information
          state.terminals[index] = {
            ...state.terminals[index],
            ...action.payload,
            status: 'running', // Ensure status is set to running after successful reset
          };
        }
        state.lastFetchTime = Date.now();
      })
      .addCase(resetTerminal.rejected, (state, action) => {
        console.error('resetTerminal.rejected:', action.error);
        const terminalId = action.meta.arg;
        const index = state.terminals.findIndex((t) => t.id === terminalId);
        if (index !== -1) {
          // Restore original status on failure
          state.terminals[index].status = 'error';
        }
        state.error = action.error.message || 'Failed to reset terminal';
      });
  },
});

export const {
  selectTerminal,
  updateTerminalStatus,
  toggleTerminalSelection,
  selectMultipleTerminals,
  clearSelection,
} = terminalsSlice.actions;
export default terminalsSlice.reducer;
