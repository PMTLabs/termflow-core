import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import recordingApiService from '../../services/recordingApiService';
import {
  TerminalRecording,
  RecordingListItem,
  RecordingStatus,
  StartRecordingRequest,
  StartRecordingResponse,
  StopRecordingResponse,
  PlaybackState,
} from '../../types/recording';

// Async thunks
export const startRecording = createAsyncThunk(
  'recording/startRecording',
  async (request: StartRecordingRequest) => {
    const response = await recordingApiService.startRecording(request);
    return response;
  }
);

export const stopRecording = createAsyncThunk(
  'recording/stopRecording',
  async (recordingId: string) => {
    const response = await recordingApiService.stopRecording(recordingId);
    return response;
  }
);

export const fetchRecordings = createAsyncThunk(
  'recording/fetchRecordings',
  async (params: { limit?: number; offset?: number; terminalId?: string } = {}) => {
    const response = await recordingApiService.getRecordings(
      params.limit,
      params.offset,
      params.terminalId
    );
    return response;
  }
);

export const fetchRecording = createAsyncThunk(
  'recording/fetchRecording',
  async (params: { recordingId: string; includeEvents?: boolean }) => {
    const response = await recordingApiService.getRecording(
      params.recordingId,
      params.includeEvents
    );
    return response;
  }
);

export const deleteRecording = createAsyncThunk(
  'recording/deleteRecording',
  async (recordingId: string) => {
    await recordingApiService.deleteRecording(recordingId);
    return recordingId;
  }
);

export const fetchRecordingStatus = createAsyncThunk(
  'recording/fetchRecordingStatus',
  async (terminalId: string) => {
    const response = await recordingApiService.getRecordingStatus(terminalId);
    return response;
  }
);

export const fetchActiveRecordings = createAsyncThunk(
  'recording/fetchActiveRecordings',
  async () => {
    const response = await recordingApiService.getActiveRecordings();
    return response;
  }
);

export const exportRecording = createAsyncThunk(
  'recording/exportRecording',
  async (params: {
    recordingId: string;
    format: 'json' | 'text' | 'html' | 'asciinema';
    includeMetadata?: boolean;
  }) => {
    await recordingApiService.exportAndDownloadRecording(
      params.recordingId,
      params.format,
      params.includeMetadata
    );
    return params;
  }
);

// State interface
interface RecordingState {
  // Recording management
  recordings: RecordingListItem[];
  currentRecording: TerminalRecording | null;
  recordingStatuses: Record<string, RecordingStatus>;
  activeRecordings: string[];
  
  // UI state
  isLoading: boolean;
  error: string | null;
  
  // List management
  totalRecordings: number;
  currentPage: number;
  pageSize: number;
  
  // Filters
  selectedTerminalFilter: string | null;
  sortBy: 'date' | 'duration' | 'size';
  sortOrder: 'asc' | 'desc';
  
  // Playback
  playbackState: PlaybackState | null;
  isPlaybackOpen: boolean;
  
  // Recording dialog
  isRecordingDialogOpen: boolean;
  recordingTarget: string | null;
  
  // Export
  isExporting: boolean;
  exportProgress: number;
}

const initialState: RecordingState = {
  recordings: [],
  currentRecording: null,
  recordingStatuses: {},
  activeRecordings: [],
  
  isLoading: false,
  error: null,
  
  totalRecordings: 0,
  currentPage: 1,
  pageSize: 50,
  
  selectedTerminalFilter: null,
  sortBy: 'date',
  sortOrder: 'desc',
  
  playbackState: null,
  isPlaybackOpen: false,
  
  isRecordingDialogOpen: false,
  recordingTarget: null,
  
  isExporting: false,
  exportProgress: 0,
};

const recordingSlice = createSlice({
  name: 'recording',
  initialState,
  reducers: {
    // UI state management
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
    },
    
    clearError: (state) => {
      state.error = null;
    },
    
    // List management
    setCurrentPage: (state, action: PayloadAction<number>) => {
      state.currentPage = action.payload;
    },
    
    setPageSize: (state, action: PayloadAction<number>) => {
      state.pageSize = action.payload;
      state.currentPage = 1; // Reset to first page when changing page size
    },
    
    // Filters
    setTerminalFilter: (state, action: PayloadAction<string | null>) => {
      state.selectedTerminalFilter = action.payload;
      state.currentPage = 1; // Reset to first page when filtering
    },
    
    setSortBy: (state, action: PayloadAction<'date' | 'duration' | 'size'>) => {
      state.sortBy = action.payload;
    },
    
    setSortOrder: (state, action: PayloadAction<'asc' | 'desc'>) => {
      state.sortOrder = action.payload;
    },
    
    // Playback
    setPlaybackState: (state, action: PayloadAction<PlaybackState | null>) => {
      state.playbackState = action.payload;
    },
    
    openPlayback: (state, action: PayloadAction<string>) => {
      state.isPlaybackOpen = true;
      // Initialize playback state for the recording
      if (action.payload) {
        const recording = state.recordings.find(r => r.id === action.payload);
        if (recording) {
          state.playbackState = {
            recordingId: action.payload,
            currentTime: 0,
            duration: recording.duration || 0,
            isPlaying: false,
            isPaused: false,
            speed: 1.0,
            loop: false,
          };
        }
      }
    },
    
    closePlayback: (state) => {
      state.isPlaybackOpen = false;
      state.playbackState = null;
      state.currentRecording = null;
    },
    
    // Recording dialog
    openRecordingDialog: (state, action: PayloadAction<string>) => {
      state.isRecordingDialogOpen = true;
      state.recordingTarget = action.payload;
    },
    
    closeRecordingDialog: (state) => {
      state.isRecordingDialogOpen = false;
      state.recordingTarget = null;
    },
    
    // Export progress
    setExportProgress: (state, action: PayloadAction<number>) => {
      state.exportProgress = action.payload;
    },
    
    // Recording status updates
    updateRecordingStatus: (state, action: PayloadAction<RecordingStatus>) => {
      state.recordingStatuses[action.payload.terminalId] = action.payload;
    },
    
    // Clear recordings
    clearRecordings: (state) => {
      state.recordings = [];
      state.totalRecordings = 0;
      state.currentPage = 1;
    },
  },
  
  extraReducers: (builder) => {
    // Start recording
    builder
      .addCase(startRecording.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(startRecording.fulfilled, (state, action) => {
        state.isLoading = false;
        state.isRecordingDialogOpen = false;
        state.recordingTarget = null;
        
        // Update recording status for the terminal
        if (action.payload.terminalId) {
          state.recordingStatuses[action.payload.terminalId] = {
            terminalId: action.payload.terminalId,
            isRecording: true,
            status: 'recording',
          };
          
          // Add to active recordings
          if (!state.activeRecordings.includes(action.payload.recordingId)) {
            state.activeRecordings.push(action.payload.recordingId);
          }
        }
      })
      .addCase(startRecording.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to start recording';
      });
    
    // Stop recording
    builder
      .addCase(stopRecording.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(stopRecording.fulfilled, (state, action) => {
        state.isLoading = false;
        
        // Update recording status for the terminal
        if (action.payload.terminalId) {
          state.recordingStatuses[action.payload.terminalId] = {
            terminalId: action.payload.terminalId,
            isRecording: false,
            status: 'not_recording',
          };
          
          // Remove from active recordings
          state.activeRecordings = state.activeRecordings.filter(
            id => id !== action.payload.recordingId
          );
        }
        
        // Refresh recordings list to include the new completed recording
        // This will be handled by the component calling fetchRecordings
      })
      .addCase(stopRecording.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to stop recording';
      });
    
    // Fetch recordings
    builder
      .addCase(fetchRecordings.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(fetchRecordings.fulfilled, (state, action) => {
        state.isLoading = false;
        state.recordings = action.payload.recordings;
        state.totalRecordings = action.payload.total;
      })
      .addCase(fetchRecordings.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to fetch recordings';
      });
    
    // Fetch recording
    builder
      .addCase(fetchRecording.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(fetchRecording.fulfilled, (state, action) => {
        state.isLoading = false;
        state.currentRecording = action.payload;
      })
      .addCase(fetchRecording.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to fetch recording';
      });
    
    // Delete recording
    builder
      .addCase(deleteRecording.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(deleteRecording.fulfilled, (state, action) => {
        state.isLoading = false;
        
        // Remove from recordings list
        state.recordings = state.recordings.filter(r => r.id !== action.payload);
        state.totalRecordings = Math.max(0, state.totalRecordings - 1);
        
        // Close playback if this recording was being played
        if (state.playbackState?.recordingId === action.payload) {
          state.isPlaybackOpen = false;
          state.playbackState = null;
          state.currentRecording = null;
        }
      })
      .addCase(deleteRecording.rejected, (state, action) => {
        state.isLoading = false;
        state.error = action.error.message || 'Failed to delete recording';
      });
    
    // Fetch recording status
    builder
      .addCase(fetchRecordingStatus.fulfilled, (state, action) => {
        state.recordingStatuses[action.payload.terminalId] = action.payload;
      });
    
    // Fetch active recordings
    builder
      .addCase(fetchActiveRecordings.fulfilled, (state, action) => {
        state.activeRecordings = action.payload.activeRecordings;
      });
    
    // Export recording
    builder
      .addCase(exportRecording.pending, (state) => {
        state.isExporting = true;
        state.exportProgress = 0;
        state.error = null;
      })
      .addCase(exportRecording.fulfilled, (state) => {
        state.isExporting = false;
        state.exportProgress = 100;
      })
      .addCase(exportRecording.rejected, (state, action) => {
        state.isExporting = false;
        state.exportProgress = 0;
        state.error = action.error.message || 'Failed to export recording';
      });
  },
});

export const {
  setError,
  clearError,
  setCurrentPage,
  setPageSize,
  setTerminalFilter,
  setSortBy,
  setSortOrder,
  setPlaybackState,
  openPlayback,
  closePlayback,
  openRecordingDialog,
  closeRecordingDialog,
  setExportProgress,
  updateRecordingStatus,
  clearRecordings,
} = recordingSlice.actions;

export default recordingSlice.reducer;