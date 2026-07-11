import { createSlice, PayloadAction } from '@reduxjs/toolkit';

// Per-surface zoom (decoupled from the font-size *number*). A surface is either a
// terminal pane (keyed by its terminalId — ephemeral, reset on new/restart) or a
// named screen like the Settings page (keyed 'settings' — persisted to config by
// the useSurfaceZoom hook). 1.0 = 100%. Browser-style: ~10% per step.
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 4.0;
export const ZOOM_STEP = 1.1; // multiply/divide => geometric ~10% notches
export const ZOOM_DEFAULT = 1.0;

export const clampZoom = (z: number): number =>
  Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, z));

// Round to 2 decimals so repeated *1.1 / /1.1 don't accumulate float drift and
// so a persisted value reads cleanly (e.g. 1.21, not 1.2100000000000002).
const normalize = (z: number): number => Math.round(clampZoom(z) * 100) / 100;

interface ZoomState {
  // Only surfaces the user has actually zoomed appear here; a missing key === 1.0.
  levels: Record<string, number>;
}

const initialState: ZoomState = { levels: {} };

const zoomSlice = createSlice({
  name: 'zoom',
  initialState,
  reducers: {
    setZoom: (state, action: PayloadAction<{ key: string; level: number }>) => {
      state.levels[action.payload.key] = normalize(action.payload.level);
    },
    nudgeZoom: (state, action: PayloadAction<{ key: string; direction: 'in' | 'out' }>) => {
      const { key, direction } = action.payload;
      const current = state.levels[key] ?? ZOOM_DEFAULT;
      state.levels[key] = normalize(direction === 'in' ? current * ZOOM_STEP : current / ZOOM_STEP);
    },
    // Set a surface back to 100% (keeps the key — used on terminal restart).
    resetZoom: (state, action: PayloadAction<string>) => {
      state.levels[action.payload] = ZOOM_DEFAULT;
    },
    // Forget a surface entirely (e.g. a closed terminal).
    clearZoom: (state, action: PayloadAction<string>) => {
      delete state.levels[action.payload];
    },
  },
});

export const { setZoom, nudgeZoom, resetZoom, clearZoom } = zoomSlice.actions;
export default zoomSlice.reducer;
