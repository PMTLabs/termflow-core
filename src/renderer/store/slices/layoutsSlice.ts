import { createSlice, PayloadAction, createAsyncThunk } from '@reduxjs/toolkit';
import { StateManager, SavedLayout } from '../../services/StateManager';

interface LayoutsState {
  savedLayouts: SavedLayout[];
  isLoading: boolean;
  error: string | null;
  showLayoutManager: boolean;
}

const initialState: LayoutsState = {
  savedLayouts: [],
  isLoading: false,
  error: null,
  showLayoutManager: false,
};

// Thunk actions
export const saveCurrentLayout = createAsyncThunk(
  'layouts/saveCurrentLayout',
  async ({ name, description }: { name: string; description?: string }) => {
    const layoutId = await StateManager.saveLayout(name, description);
    return { layoutId, name, description };
  }
);

export const loadLayout = createAsyncThunk(
  'layouts/loadLayout',
  async (layoutId: string, { dispatch }) => {
    await StateManager.loadLayout(layoutId, dispatch);
    return layoutId;
  }
);

export const deleteLayout = createAsyncThunk(
  'layouts/deleteLayout',
  async (layoutId: string) => {
    const success = StateManager.deleteLayout(layoutId);
    if (!success) {
      throw new Error('Failed to delete layout');
    }
    return layoutId;
  }
);

export const renameLayout = createAsyncThunk(
  'layouts/renameLayout',
  async ({ layoutId, name, description }: { layoutId: string; name: string; description?: string }) => {
    const success = StateManager.renameLayout(layoutId, name, description);
    if (!success) {
      throw new Error('Failed to rename layout');
    }
    return { layoutId, name, description };
  }
);

export const updateLayout = createAsyncThunk(
  'layouts/updateLayout',
  async (layoutId: string) => {
    const success = await StateManager.updateLayout(layoutId);
    if (!success) {
      throw new Error('Failed to update layout');
    }
    return layoutId;
  }
);

const layoutsSlice = createSlice({
  name: 'layouts',
  initialState,
  reducers: {
    refreshLayouts: (state) => {
      state.savedLayouts = StateManager.getSavedLayouts();
    },
    
    setShowLayoutManager: (state, action: PayloadAction<boolean>) => {
      state.showLayoutManager = action.payload;
    },
    
    clearError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // Save layout
      .addCase(saveCurrentLayout.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(saveCurrentLayout.fulfilled, (state) => {
        state.isLoading = false;
        // Refresh layouts list
        state.savedLayouts = StateManager.getSavedLayouts();
      })
      .addCase(saveCurrentLayout.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to save layout';
      })
      
      // Load layout
      .addCase(loadLayout.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(loadLayout.fulfilled, (state) => {
        state.isLoading = false;
        // Refresh layouts list to update timestamps
        state.savedLayouts = StateManager.getSavedLayouts();
      })
      .addCase(loadLayout.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to load layout';
      })
      
      // Delete layout
      .addCase(deleteLayout.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(deleteLayout.fulfilled, (state, action) => {
        state.isLoading = false;
        state.savedLayouts = state.savedLayouts.filter(l => l.id !== action.payload);
      })
      .addCase(deleteLayout.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to delete layout';
      })
      
      // Rename layout
      .addCase(renameLayout.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(renameLayout.fulfilled, (state, action) => {
        state.isLoading = false;
        const { layoutId, name, description } = action.payload;
        const layout = state.savedLayouts.find(l => l.id === layoutId);
        if (layout) {
          layout.name = name;
          if (description !== undefined) {
            layout.description = description;
          }
          layout.updatedAt = Date.now();
        }
      })
      .addCase(renameLayout.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to rename layout';
      })
      
      // Update layout
      .addCase(updateLayout.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(updateLayout.fulfilled, (state) => {
        state.isLoading = false;
        // Refresh layouts list to get updated timestamps
        state.savedLayouts = StateManager.getSavedLayouts();
      })
      .addCase(updateLayout.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to update layout';
      });
  },
});

export const { 
  refreshLayouts, 
  setShowLayoutManager, 
  clearError 
} = layoutsSlice.actions;

export default layoutsSlice.reducer;