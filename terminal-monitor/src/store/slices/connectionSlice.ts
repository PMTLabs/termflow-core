import { createSlice, PayloadAction } from '@reduxjs/toolkit';

interface ConnectionState {
  wsConnected: boolean;
  apiConnected: boolean;
  reconnectAttempts: number;
  lastError: string | null;
}

const initialState: ConnectionState = {
  wsConnected: false,
  apiConnected: true,
  reconnectAttempts: 0,
  lastError: null,
};

const connectionSlice = createSlice({
  name: 'connection',
  initialState,
  reducers: {
    setWsConnected: (state, action: PayloadAction<boolean>) => {
      state.wsConnected = action.payload;
      if (action.payload) {
        state.reconnectAttempts = 0;
        state.lastError = null;
      }
    },
    setApiConnected: (state, action: PayloadAction<boolean>) => {
      state.apiConnected = action.payload;
    },
    incrementReconnectAttempts: (state) => {
      state.reconnectAttempts += 1;
    },
    setConnectionError: (state, action: PayloadAction<string | null>) => {
      state.lastError = action.payload;
    },
  },
});

export const {
  setWsConnected,
  setApiConnected,
  incrementReconnectAttempts,
  setConnectionError,
} = connectionSlice.actions;

export default connectionSlice.reducer;
