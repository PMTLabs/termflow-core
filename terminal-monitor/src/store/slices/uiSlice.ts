import { createSlice, PayloadAction } from '@reduxjs/toolkit';

const STORAGE_KEY = 'terminal-monitor-sidebar-collapsed';

interface UiState {
  sidebarCollapsed: boolean;
}

const loadSidebarCollapsed = (): boolean => {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored !== null) {
      return JSON.parse(stored);
    }
  } catch {
    // Ignore localStorage errors
  }
  return false;
};

const saveSidebarCollapsed = (collapsed: boolean): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(collapsed));
  } catch {
    // Ignore localStorage errors
  }
};

const initialState: UiState = {
  sidebarCollapsed: loadSidebarCollapsed(),
};

const uiSlice = createSlice({
  name: 'ui',
  initialState,
  reducers: {
    toggleSidebar: (state) => {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      saveSidebarCollapsed(state.sidebarCollapsed);
    },
    setSidebarCollapsed: (state, action: PayloadAction<boolean>) => {
      state.sidebarCollapsed = action.payload;
      saveSidebarCollapsed(state.sidebarCollapsed);
    },
  },
});

export const { toggleSidebar, setSidebarCollapsed } = uiSlice.actions;

export default uiSlice.reducer;
