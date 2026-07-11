import gridReducer, {
  setGridViewActive,
  setActiveLayout,
  addLayout,
  updateLayout,
  removeLayout,
  saveLayout,
  updateTerminalPosition,
  GridLayout,
} from './gridSlice';

interface GridState {
  layouts: GridLayout[];
  activeLayoutId: string | null;
  isGridViewActive: boolean;
  savedLayouts: GridLayout[];
}

describe('gridSlice', () => {
  const initialState: GridState = {
    layouts: [],
    activeLayoutId: null,
    isGridViewActive: false,
    savedLayouts: [],
  };

  const mockLayout: GridLayout = {
    id: '2x2',
    name: '2x2 Grid',
    terminals: [
      { terminalId: 'term-1', position: { row: 0, col: 0 } },
      { terminalId: 'term-2', position: { row: 0, col: 1 } },
      { terminalId: 'term-3', position: { row: 1, col: 0 } },
      { terminalId: 'term-4', position: { row: 1, col: 1 } },
    ],
    rows: 2,
    cols: 2,
  };

  describe('reducer', () => {
    it('should return the initial state', () => {
      expect(gridReducer(undefined, { type: 'unknown' })).toEqual(initialState);
    });
  });

  describe('setGridViewActive', () => {
    it('should activate grid view', () => {
      const state = gridReducer(initialState, setGridViewActive(true));
      expect(state.isGridViewActive).toBe(true);
    });

    it('should deactivate grid view', () => {
      const activeState: GridState = {
        ...initialState,
        isGridViewActive: true,
      };
      const state = gridReducer(activeState, setGridViewActive(false));
      expect(state.isGridViewActive).toBe(false);
    });
  });

  describe('setActiveLayout', () => {
    it('should set active layout', () => {
      const state = gridReducer(initialState, setActiveLayout('2x2'));
      expect(state.activeLayoutId).toBe('2x2');
    });

    it('should change active layout', () => {
      const stateWithActive: GridState = {
        ...initialState,
        activeLayoutId: '3x3',
      };
      const state = gridReducer(stateWithActive, setActiveLayout('2x2'));
      expect(state.activeLayoutId).toBe('2x2');
    });
  });

  describe('addLayout', () => {
    it('should add a new layout', () => {
      const state = gridReducer(initialState, addLayout(mockLayout));
      expect(state.layouts).toHaveLength(1);
      expect(state.layouts[0]).toEqual(mockLayout);
    });

    it('should add multiple layouts', () => {
      let state = gridReducer(initialState, addLayout(mockLayout));
      const anotherLayout: GridLayout = {
        ...mockLayout,
        id: '3x3',
        name: '3x3 Grid',
        rows: 3,
        cols: 3,
      };
      state = gridReducer(state, addLayout(anotherLayout));
      expect(state.layouts).toHaveLength(2);
      expect(state.layouts[1]).toEqual(anotherLayout);
    });
  });

  describe('updateLayout', () => {
    it('should update an existing layout', () => {
      const stateWithLayout: GridState = {
        ...initialState,
        layouts: [mockLayout],
      };
      const updatedLayout: GridLayout = {
        ...mockLayout,
        name: 'Updated 2x2 Grid',
      };
      const state = gridReducer(stateWithLayout, updateLayout(updatedLayout));
      expect(state.layouts[0].name).toBe('Updated 2x2 Grid');
    });

    it('should not modify state if layout not found', () => {
      const stateWithLayout: GridState = {
        ...initialState,
        layouts: [mockLayout],
      };
      const nonExistentLayout: GridLayout = {
        ...mockLayout,
        id: 'non-existent',
      };
      const state = gridReducer(
        stateWithLayout,
        updateLayout(nonExistentLayout)
      );
      expect(state.layouts).toEqual([mockLayout]);
    });
  });

  describe('removeLayout', () => {
    it('should remove a layout', () => {
      const stateWithLayouts: GridState = {
        ...initialState,
        layouts: [mockLayout],
      };
      const state = gridReducer(stateWithLayouts, removeLayout('2x2'));
      expect(state.layouts).toHaveLength(0);
    });

    it('should clear activeLayoutId if removed layout was active', () => {
      const stateWithActiveLayout: GridState = {
        ...initialState,
        layouts: [mockLayout],
        activeLayoutId: '2x2',
      };
      const state = gridReducer(stateWithActiveLayout, removeLayout('2x2'));
      expect(state.activeLayoutId).toBe(null);
    });

    it('should not affect activeLayoutId if different layout removed', () => {
      const anotherLayout: GridLayout = {
        ...mockLayout,
        id: '3x3',
        name: '3x3 Grid',
      };
      const stateWithLayouts: GridState = {
        ...initialState,
        layouts: [mockLayout, anotherLayout],
        activeLayoutId: '2x2',
      };
      const state = gridReducer(stateWithLayouts, removeLayout('3x3'));
      expect(state.activeLayoutId).toBe('2x2');
      expect(state.layouts).toHaveLength(1);
    });
  });

  describe('saveLayout', () => {
    it('should save a new layout', () => {
      const state = gridReducer(initialState, saveLayout(mockLayout));
      expect(state.savedLayouts).toHaveLength(1);
      expect(state.savedLayouts[0]).toEqual(mockLayout);
    });

    it('should update existing saved layout', () => {
      const stateWithSaved: GridState = {
        ...initialState,
        savedLayouts: [mockLayout],
      };
      const updatedLayout: GridLayout = {
        ...mockLayout,
        name: 'Updated Saved Layout',
      };
      const state = gridReducer(stateWithSaved, saveLayout(updatedLayout));
      expect(state.savedLayouts).toHaveLength(1);
      expect(state.savedLayouts[0].name).toBe('Updated Saved Layout');
    });
  });

  describe('updateTerminalPosition', () => {
    it('should update terminal position', () => {
      const stateWithLayout: GridState = {
        ...initialState,
        layouts: [mockLayout],
      };
      const action = updateTerminalPosition({
        layoutId: '2x2',
        terminalId: 'term-1',
        position: { row: 1, col: 1 },
      });
      const state = gridReducer(stateWithLayout, action);

      const updatedTerminal = state.layouts[0].terminals.find(
        (t) => t.terminalId === 'term-1'
      );
      expect(updatedTerminal?.position).toEqual({ row: 1, col: 1 });
    });

    it('should not modify other terminals', () => {
      const stateWithLayout: GridState = {
        ...initialState,
        layouts: [mockLayout],
      };
      const action = updateTerminalPosition({
        layoutId: '2x2',
        terminalId: 'term-1',
        position: { row: 1, col: 1 },
      });
      const state = gridReducer(stateWithLayout, action);

      const otherTerminal = state.layouts[0].terminals.find(
        (t) => t.terminalId === 'term-2'
      );
      expect(otherTerminal?.position).toEqual({ row: 0, col: 1 });
    });

    it('should handle non-existent layout', () => {
      const stateWithLayout: GridState = {
        ...initialState,
        layouts: [mockLayout],
      };
      const action = updateTerminalPosition({
        layoutId: 'non-existent',
        terminalId: 'term-1',
        position: { row: 0, col: 0 },
      });
      const state = gridReducer(stateWithLayout, action);

      // State should remain unchanged
      expect(state).toEqual(stateWithLayout);
    });

    it('should handle non-existent terminal', () => {
      const stateWithLayout: GridState = {
        ...initialState,
        layouts: [mockLayout],
      };
      const action = updateTerminalPosition({
        layoutId: '2x2',
        terminalId: 'non-existent',
        position: { row: 0, col: 0 },
      });
      const state = gridReducer(stateWithLayout, action);

      // Layout should remain unchanged
      expect(state.layouts[0].terminals).toEqual(mockLayout.terminals);
    });

    it('should handle updating position with size property', () => {
      const layoutWithSize: GridLayout = {
        ...mockLayout,
        terminals: [
          {
            terminalId: 'term-1',
            position: { row: 0, col: 0 },
            size: { rowSpan: 2, colSpan: 1 },
          },
        ],
      };
      const stateWithLayout: GridState = {
        ...initialState,
        layouts: [layoutWithSize],
      };
      const action = updateTerminalPosition({
        layoutId: '2x2',
        terminalId: 'term-1',
        position: { row: 1, col: 1 },
      });
      const state = gridReducer(stateWithLayout, action);

      const updatedTerminal = state.layouts[0].terminals.find(
        (t) => t.terminalId === 'term-1'
      );
      expect(updatedTerminal?.position).toEqual({ row: 1, col: 1 });
      expect(updatedTerminal?.size).toEqual({ rowSpan: 2, colSpan: 1 });
    });
  });

  describe('complex scenarios', () => {
    it('should handle grid view activation with layout management', () => {
      let state = initialState;

      // Activate grid view
      state = gridReducer(state, setGridViewActive(true));
      expect(state.isGridViewActive).toBe(true);

      // Add a new layout
      state = gridReducer(state, addLayout(mockLayout));
      expect(state.layouts).toHaveLength(1);

      // Set it as active
      state = gridReducer(state, setActiveLayout('2x2'));
      expect(state.activeLayoutId).toBe('2x2');

      // Update terminal positions
      state = gridReducer(
        state,
        updateTerminalPosition({
          layoutId: '2x2',
          terminalId: 'term-1',
          position: { row: 1, col: 1 },
        })
      );
      state = gridReducer(
        state,
        updateTerminalPosition({
          layoutId: '2x2',
          terminalId: 'term-4',
          position: { row: 0, col: 0 },
        })
      );

      // Verify positions
      const term1 = state.layouts[0].terminals.find(
        (t) => t.terminalId === 'term-1'
      );
      const term4 = state.layouts[0].terminals.find(
        (t) => t.terminalId === 'term-4'
      );
      expect(term1?.position).toEqual({ row: 1, col: 1 });
      expect(term4?.position).toEqual({ row: 0, col: 0 });

      // Save the layout
      state = gridReducer(state, saveLayout(state.layouts[0]));
      expect(state.savedLayouts).toHaveLength(1);

      // Deactivate grid view
      state = gridReducer(state, setGridViewActive(false));
      expect(state.isGridViewActive).toBe(false);
      // Layout should persist
      expect(state.activeLayoutId).toBe('2x2');
    });
  });
});
