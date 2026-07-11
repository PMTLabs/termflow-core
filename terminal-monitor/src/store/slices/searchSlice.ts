import { createSlice, createAsyncThunk, PayloadAction } from '@reduxjs/toolkit';
import searchApiService from '../../services/searchApiService';
import {
  SearchQuery,
  SearchResponse,
  SearchRequest,
  AdvancedSearchRequest,
  SearchSuggestionsResponse,
  SearchStatsResponse,
  SearchHistoryResponse,
  SearchUIState,
  SearchFiltersState,
  SearchResultsState,
} from '../../types/search';

// Async thunks
export const performSearch = createAsyncThunk(
  'search/performSearch',
  async (params: SearchRequest) => {
    const response = await searchApiService.search(params);
    // Save search to local history
    searchApiService.saveSearchToHistory(params.q);
    return response;
  }
);

export const performAdvancedSearch = createAsyncThunk(
  'search/performAdvancedSearch',
  async (request: AdvancedSearchRequest) => {
    const response = await searchApiService.advancedSearch(request);
    // Save search to local history
    searchApiService.saveSearchToHistory(request.query.text);
    return response;
  }
);

export const fetchSearchSuggestions = createAsyncThunk(
  'search/fetchSearchSuggestions',
  async (params: { query: string; limit?: number }) => {
    const response = await searchApiService.getSuggestions(params.query, params.limit);
    return response;
  }
);

export const indexContent = createAsyncThunk(
  'search/indexContent',
  async (params: {
    terminalId: string;
    content: string;
    type: 'output' | 'input' | 'command' | 'error';
    metadata?: Record<string, any>;
  }) => {
    await searchApiService.indexContent(
      params.terminalId,
      params.content,
      params.type,
      params.metadata
    );
    return params;
  }
);

export const clearSearchIndex = createAsyncThunk(
  'search/clearSearchIndex',
  async () => {
    await searchApiService.clearIndex();
  }
);

export const clearTerminalIndex = createAsyncThunk(
  'search/clearTerminalIndex',
  async (terminalId: string) => {
    await searchApiService.clearTerminalIndex(terminalId);
    return terminalId;
  }
);

export const fetchSearchStats = createAsyncThunk(
  'search/fetchSearchStats',
  async () => {
    const response = await searchApiService.getSearchStats();
    return response;
  }
);

export const fetchSearchHistory = createAsyncThunk(
  'search/fetchSearchHistory',
  async (params: { terminalId?: string; limit?: number } = {}) => {
    const response = await searchApiService.getSearchHistory(
      params.terminalId,
      params.limit
    );
    return response;
  }
);

export const exportSearchResults = createAsyncThunk(
  'search/exportSearchResults',
  async (params: {
    searchResponse: SearchResponse;
    format: 'json' | 'csv' | 'txt';
  }) => {
    await searchApiService.exportSearchResults(
      params.searchResponse,
      params.format
    );
    return params;
  }
);

// State interface
interface SearchState {
  // Core search state
  currentResults: SearchResponse | null;
  isSearching: boolean;
  error: string | null;
  
  // Search suggestions
  suggestions: string[];
  isLoadingSuggestions: boolean;
  showSuggestions: boolean;
  
  // Search history
  recentSearches: string[];
  searchHistory: SearchHistoryResponse | null;
  
  // Search statistics
  searchStats: SearchStatsResponse | null;
  
  // UI state
  uiState: SearchUIState;
  filtersState: SearchFiltersState;
  resultsState: SearchResultsState;
  
  // Indexing state
  isIndexing: boolean;
  indexingProgress: number;
  indexingTerminal: string | null;
  
  // Export state
  isExporting: boolean;
  exportProgress: number;
  
  // Quick search
  quickSearchQuery: string;
  quickSearchResults: SearchResponse | null;
  isQuickSearching: boolean;
}

const initialState: SearchState = {
  currentResults: null,
  isSearching: false,
  error: null,
  
  suggestions: [],
  isLoadingSuggestions: false,
  showSuggestions: false,
  
  recentSearches: [],
  searchHistory: null,
  
  searchStats: null,
  
  uiState: {
    isOpen: false,
    loading: false,
    error: null,
    query: {
      text: '',
      highlight: true,
      caseSensitive: false,
      regex: false,
      wholeWord: false,
    },
    results: null,
    suggestions: [],
    showSuggestions: false,
    recentSearches: [],
    currentPage: 1,
    pageSize: 50,
  },
  
  filtersState: {
    showFilters: false,
    availableTerminals: [],
    selectedTerminals: [],
    contentType: 'all',
    timeRangeType: 'all',
    customStartDate: '',
    customEndDate: '',
  },
  
  resultsState: {
    sortBy: 'relevance',
    sortOrder: 'desc',
    viewMode: 'list',
  },
  
  isIndexing: false,
  indexingProgress: 0,
  indexingTerminal: null,
  
  isExporting: false,
  exportProgress: 0,
  
  quickSearchQuery: '',
  quickSearchResults: null,
  isQuickSearching: false,
};

const searchSlice = createSlice({
  name: 'search',
  initialState,
  reducers: {
    // UI state management
    setError: (state, action: PayloadAction<string | null>) => {
      state.error = action.payload;
      state.uiState.error = action.payload;
    },
    
    clearError: (state) => {
      state.error = null;
      state.uiState.error = null;
    },
    
    // Search UI
    openSearch: (state, action: PayloadAction<string | undefined>) => {
      state.uiState.isOpen = true;
      if (action.payload) {
        state.uiState.query.text = action.payload;
        state.quickSearchQuery = action.payload;
      }
      // Load recent searches from local storage
      state.recentSearches = searchApiService.loadSearchHistory();
      state.uiState.recentSearches = state.recentSearches;
    },
    
    closeSearch: (state) => {
      state.uiState.isOpen = false;
      state.showSuggestions = false;
      state.uiState.showSuggestions = false;
      state.error = null;
      state.uiState.error = null;
    },
    
    // Query management
    setSearchQuery: (state, action: PayloadAction<Partial<SearchQuery>>) => {
      state.uiState.query = { ...state.uiState.query, ...action.payload };
    },
    
    setQuickSearchQuery: (state, action: PayloadAction<string>) => {
      state.quickSearchQuery = action.payload;
    },
    
    clearSearchQuery: (state) => {
      state.uiState.query = {
        text: '',
        highlight: true,
        caseSensitive: false,
        regex: false,
        wholeWord: false,
      };
      state.quickSearchQuery = '';
    },
    
    // Suggestions
    setSuggestions: (state, action: PayloadAction<string[]>) => {
      state.suggestions = action.payload;
      state.uiState.suggestions = action.payload;
    },
    
    showSuggestions: (state) => {
      state.showSuggestions = true;
      state.uiState.showSuggestions = true;
    },
    
    hideSuggestions: (state) => {
      state.showSuggestions = false;
      state.uiState.showSuggestions = false;
    },
    
    // Pagination
    setCurrentPage: (state, action: PayloadAction<number>) => {
      state.uiState.currentPage = action.payload;
    },
    
    setPageSize: (state, action: PayloadAction<number>) => {
      state.uiState.pageSize = action.payload;
      state.uiState.currentPage = 1; // Reset to first page
    },
    
    // Filters
    toggleFilters: (state) => {
      state.filtersState.showFilters = !state.filtersState.showFilters;
    },
    
    setSelectedTerminals: (state, action: PayloadAction<string[]>) => {
      state.filtersState.selectedTerminals = action.payload;
      state.uiState.currentPage = 1; // Reset pagination
    },
    
    setContentType: (state, action: PayloadAction<string>) => {
      state.filtersState.contentType = action.payload;
      state.uiState.currentPage = 1;
    },
    
    setTimeRangeType: (state, action: PayloadAction<SearchFiltersState['timeRangeType']>) => {
      state.filtersState.timeRangeType = action.payload;
      state.uiState.currentPage = 1;
    },
    
    setCustomDateRange: (state, action: PayloadAction<{ start: string; end: string }>) => {
      state.filtersState.customStartDate = action.payload.start;
      state.filtersState.customEndDate = action.payload.end;
      state.uiState.currentPage = 1;
    },
    
    setAvailableTerminals: (state, action: PayloadAction<string[]>) => {
      state.filtersState.availableTerminals = action.payload;
    },
    
    clearFilters: (state) => {
      state.filtersState.selectedTerminals = [];
      state.filtersState.contentType = 'all';
      state.filtersState.timeRangeType = 'all';
      state.filtersState.customStartDate = '';
      state.filtersState.customEndDate = '';
      state.uiState.currentPage = 1;
    },
    
    // Results display
    setSortBy: (state, action: PayloadAction<SearchResultsState['sortBy']>) => {
      state.resultsState.sortBy = action.payload;
    },
    
    setSortOrder: (state, action: PayloadAction<SearchResultsState['sortOrder']>) => {
      state.resultsState.sortOrder = action.payload;
    },
    
    setViewMode: (state, action: PayloadAction<SearchResultsState['viewMode']>) => {
      state.resultsState.viewMode = action.payload;
    },
    
    // Indexing progress
    setIndexingProgress: (state, action: PayloadAction<number>) => {
      state.indexingProgress = action.payload;
    },
    
    setIndexingTerminal: (state, action: PayloadAction<string | null>) => {
      state.indexingTerminal = action.payload;
    },
    
    // Export progress
    setExportProgress: (state, action: PayloadAction<number>) => {
      state.exportProgress = action.payload;
    },
    
    // Recent searches
    addRecentSearch: (state, action: PayloadAction<string>) => {
      const query = action.payload.trim();
      if (query && !state.recentSearches.includes(query)) {
        state.recentSearches = [query, ...state.recentSearches.slice(0, 19)];
        state.uiState.recentSearches = state.recentSearches;
      }
    },
    
    clearRecentSearches: (state) => {
      state.recentSearches = [];
      state.uiState.recentSearches = [];
      searchApiService.clearSearchHistory();
    },
    
    // Clear results
    clearSearchResults: (state) => {
      state.currentResults = null;
      state.uiState.results = null;
      state.quickSearchResults = null;
    },
  },
  
  extraReducers: (builder) => {
    // Perform search
    builder
      .addCase(performSearch.pending, (state) => {
        state.isSearching = true;
        state.uiState.loading = true;
        state.error = null;
        state.uiState.error = null;
      })
      .addCase(performSearch.fulfilled, (state, action) => {
        state.isSearching = false;
        state.uiState.loading = false;
        state.currentResults = action.payload;
        state.uiState.results = action.payload;
        
        // Add to recent searches
        const query = action.payload.query.text;
        if (query && !state.recentSearches.includes(query)) {
          state.recentSearches = [query, ...state.recentSearches.slice(0, 19)];
          state.uiState.recentSearches = state.recentSearches;
        }
      })
      .addCase(performSearch.rejected, (state, action) => {
        state.isSearching = false;
        state.uiState.loading = false;
        state.error = action.error.message || 'Search failed';
        state.uiState.error = state.error;
      });
    
    // Perform advanced search
    builder
      .addCase(performAdvancedSearch.pending, (state) => {
        state.isSearching = true;
        state.uiState.loading = true;
        state.error = null;
        state.uiState.error = null;
      })
      .addCase(performAdvancedSearch.fulfilled, (state, action) => {
        state.isSearching = false;
        state.uiState.loading = false;
        state.currentResults = action.payload;
        state.uiState.results = action.payload;
        
        // Add to recent searches
        const query = action.payload.query.text;
        if (query && !state.recentSearches.includes(query)) {
          state.recentSearches = [query, ...state.recentSearches.slice(0, 19)];
          state.uiState.recentSearches = state.recentSearches;
        }
      })
      .addCase(performAdvancedSearch.rejected, (state, action) => {
        state.isSearching = false;
        state.uiState.loading = false;
        state.error = action.error.message || 'Advanced search failed';
        state.uiState.error = state.error;
      });
    
    // Fetch search suggestions
    builder
      .addCase(fetchSearchSuggestions.pending, (state) => {
        state.isLoadingSuggestions = true;
      })
      .addCase(fetchSearchSuggestions.fulfilled, (state, action) => {
        state.isLoadingSuggestions = false;
        state.suggestions = action.payload.suggestions;
        state.uiState.suggestions = action.payload.suggestions;
      })
      .addCase(fetchSearchSuggestions.rejected, (state) => {
        state.isLoadingSuggestions = false;
        state.suggestions = [];
        state.uiState.suggestions = [];
      });
    
    // Index content
    builder
      .addCase(indexContent.pending, (state, action) => {
        state.isIndexing = true;
        state.indexingTerminal = action.meta.arg.terminalId;
        state.indexingProgress = 0;
      })
      .addCase(indexContent.fulfilled, (state) => {
        state.isIndexing = false;
        state.indexingTerminal = null;
        state.indexingProgress = 100;
      })
      .addCase(indexContent.rejected, (state, action) => {
        state.isIndexing = false;
        state.indexingTerminal = null;
        state.indexingProgress = 0;
        state.error = action.error.message || 'Failed to index content';
      });
    
    // Clear search index
    builder
      .addCase(clearSearchIndex.pending, (state) => {
        state.isIndexing = true;
        state.indexingProgress = 0;
      })
      .addCase(clearSearchIndex.fulfilled, (state) => {
        state.isIndexing = false;
        state.indexingProgress = 100;
        // Clear current results as they're no longer valid
        state.currentResults = null;
        state.uiState.results = null;
        state.quickSearchResults = null;
      })
      .addCase(clearSearchIndex.rejected, (state, action) => {
        state.isIndexing = false;
        state.indexingProgress = 0;
        state.error = action.error.message || 'Failed to clear search index';
      });
    
    // Clear terminal index
    builder
      .addCase(clearTerminalIndex.pending, (state, action) => {
        state.isIndexing = true;
        state.indexingTerminal = action.meta.arg;
        state.indexingProgress = 0;
      })
      .addCase(clearTerminalIndex.fulfilled, (state, action) => {
        state.isIndexing = false;
        state.indexingTerminal = null;
        state.indexingProgress = 100;
        
        // Clear results for this terminal
        if (state.currentResults) {
          state.currentResults.results = state.currentResults.results.filter(
            r => r.terminalId !== action.payload
          );
          state.currentResults.total = state.currentResults.results.length;
          state.uiState.results = state.currentResults;
        }
      })
      .addCase(clearTerminalIndex.rejected, (state, action) => {
        state.isIndexing = false;
        state.indexingTerminal = null;
        state.indexingProgress = 0;
        state.error = action.error.message || 'Failed to clear terminal index';
      });
    
    // Fetch search stats
    builder
      .addCase(fetchSearchStats.fulfilled, (state, action) => {
        state.searchStats = action.payload;
      })
      .addCase(fetchSearchStats.rejected, (state, action) => {
        state.error = action.error.message || 'Failed to fetch search statistics';
      });
    
    // Fetch search history
    builder
      .addCase(fetchSearchHistory.fulfilled, (state, action) => {
        state.searchHistory = action.payload;
      })
      .addCase(fetchSearchHistory.rejected, (state, action) => {
        state.error = action.error.message || 'Failed to fetch search history';
      });
    
    // Export search results
    builder
      .addCase(exportSearchResults.pending, (state) => {
        state.isExporting = true;
        state.exportProgress = 0;
        state.error = null;
      })
      .addCase(exportSearchResults.fulfilled, (state) => {
        state.isExporting = false;
        state.exportProgress = 100;
      })
      .addCase(exportSearchResults.rejected, (state, action) => {
        state.isExporting = false;
        state.exportProgress = 0;
        state.error = action.error.message || 'Failed to export search results';
      });
  },
});

export const {
  setError,
  clearError,
  openSearch,
  closeSearch,
  setSearchQuery,
  setQuickSearchQuery,
  clearSearchQuery,
  setSuggestions,
  showSuggestions,
  hideSuggestions,
  setCurrentPage,
  setPageSize,
  toggleFilters,
  setSelectedTerminals,
  setContentType,
  setTimeRangeType,
  setCustomDateRange,
  setAvailableTerminals,
  clearFilters,
  setSortBy,
  setSortOrder,
  setViewMode,
  setIndexingProgress,
  setIndexingTerminal,
  setExportProgress,
  addRecentSearch,
  clearRecentSearches,
  clearSearchResults,
} = searchSlice.actions;

export default searchSlice.reducer;