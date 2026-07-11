import { createSlice, PayloadAction } from '@reduxjs/toolkit';

export interface GridTerminal {
  terminalId: string;
  position: { row: number; col: number };
  size?: { rowSpan?: number; colSpan?: number };
}

export interface GridLayout {
  id: string;
  name: string;
  terminals: GridTerminal[];
  rows: number;
  cols: number;
}

interface GridState {
  layouts: GridLayout[];
  activeLayoutId: string | null;
  isGridViewActive: boolean;
  savedLayouts: GridLayout[];
}

const initialState: GridState = {
  layouts: [],
  activeLayoutId: null,
  isGridViewActive: false,
  savedLayouts: [],
};

const gridSlice = createSlice({
  name: 'grid',
  initialState,
  reducers: {
    setGridViewActive: (state, action: PayloadAction<boolean>) => {
      state.isGridViewActive = action.payload;
    },
    setActiveLayout: (state, action: PayloadAction<string>) => {
      state.activeLayoutId = action.payload;
    },
    addLayout: (state, action: PayloadAction<GridLayout>) => {
      state.layouts.push(action.payload);
    },
    updateLayout: (state, action: PayloadAction<GridLayout>) => {
      const index = state.layouts.findIndex((l) => l.id === action.payload.id);
      if (index !== -1) {
        state.layouts[index] = action.payload;
      }
    },
    removeLayout: (state, action: PayloadAction<string>) => {
      state.layouts = state.layouts.filter((l) => l.id !== action.payload);
      if (state.activeLayoutId === action.payload) {
        state.activeLayoutId = null;
      }
    },
    saveLayout: (state, action: PayloadAction<GridLayout>) => {
      const existing = state.savedLayouts.find(
        (l) => l.id === action.payload.id
      );
      if (existing) {
        const index = state.savedLayouts.indexOf(existing);
        state.savedLayouts[index] = action.payload;
      } else {
        state.savedLayouts.push(action.payload);
      }
    },
    updateTerminalPosition: (
      state,
      action: PayloadAction<{
        layoutId: string;
        terminalId: string;
        position: { row: number; col: number };
      }>
    ) => {
      const layout = state.layouts.find(
        (l) => l.id === action.payload.layoutId
      );
      if (layout) {
        const terminal = layout.terminals.find(
          (t) => t.terminalId === action.payload.terminalId
        );
        if (terminal) {
          terminal.position = action.payload.position;
        }
      }
    },
  },
});

export const {
  setGridViewActive,
  setActiveLayout,
  addLayout,
  updateLayout,
  removeLayout,
  saveLayout,
  updateTerminalPosition,
} = gridSlice.actions;

export default gridSlice.reducer;
