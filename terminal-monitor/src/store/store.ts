import { configureStore } from '@reduxjs/toolkit';
import terminalsReducer from './slices/terminalsSlice';
import connectionReducer from './slices/connectionSlice';
import outputReducer from './slices/outputSlice';
import authReducer from './slices/authSlice';
import gridReducer from './slices/gridSlice';
import recordingReducer from './slices/recordingSlice';
import searchReducer from './slices/searchSlice';
import uiReducer from './slices/uiSlice';

export const store = configureStore({
  reducer: {
    terminals: terminalsReducer,
    connection: connectionReducer,
    output: outputReducer,
    auth: authReducer,
    grid: gridReducer,
    recording: recordingReducer,
    search: searchReducer,
    ui: uiReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;
