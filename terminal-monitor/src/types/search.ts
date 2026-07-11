export interface SearchQuery {
  text: string;
  terminals?: string[];
  timeRange?: DateRange;
  filters?: SearchFilter[];
  highlight?: boolean;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
}

export interface DateRange {
  start: Date;
  end: Date;
}

export interface SearchFilter {
  type: 'terminal' | 'command' | 'error' | 'content_type' | 'size' | 'duration';
  value: any;
  operator?: 'equals' | 'contains' | 'greater_than' | 'less_than' | 'between';
}

export interface SearchResult {
  id: string;
  terminalId: string;
  timestamp: Date;
  content: string;
  context: string; // Surrounding context
  matches: SearchMatch[];
  score: number; // Relevance score
  metadata: SearchResultMetadata;
}

export interface SearchMatch {
  start: number;
  end: number;
  text: string;
  line: number;
  column: number;
}

export interface SearchResultMetadata {
  type: 'output' | 'input' | 'command' | 'error';
  processId?: string;
  shellType?: string;
  workingDirectory?: string;
  lineNumber?: number;
  eventId?: string;
}

export interface SearchResponse {
  results: SearchResult[];
  total: number;
  page: number;
  pageSize: number;
  query: SearchQuery;
  executionTime: number; // milliseconds
  suggestions?: string[];
}

export interface SearchIndex {
  id: string;
  terminalId: string;
  content: string;
  normalizedContent: string; // Lowercase, trimmed
  timestamp: Date;
  type: 'output' | 'input' | 'command' | 'error';
  metadata: Record<string, any>;
  keywords: string[];
  size: number;
}

export interface SearchEngineConfig {
  indexPath?: string;
  maxIndexSize: number; // MB
  maxRetentionDays: number;
  realtimeIndexing: boolean;
  batchSize: number;
  compressionEnabled: boolean;
}

export interface TerminalSearchHistory {
  terminalId: string;
  queries: SearchHistoryItem[];
  lastSearched: Date;
}

export interface SearchHistoryItem {
  query: string;
  timestamp: Date;
  resultCount: number;
  executionTime: number;
}

// Terminal Monitor specific types
export interface SearchRequest {
  q: string;
  terminals?: string[];
  startDate?: string;
  endDate?: string;
  type?: string;
  page?: number;
  pageSize?: number;
  caseSensitive?: boolean;
  regex?: boolean;
  wholeWord?: boolean;
  highlight?: boolean;
}

export interface AdvancedSearchRequest {
  query: SearchQuery;
  page?: number;
  pageSize?: number;
}

export interface SearchSuggestionsResponse {
  query: string;
  suggestions: string[];
}

export interface SearchStatsResponse {
  indexStats: {
    totalEntries: number;
    totalSize: number;
    typeDistribution: Record<string, number>;
    terminalDistribution: Record<string, number>;
    oldestEntry: Date | null;
    newestEntry: Date | null;
  };
  timestamp: string;
}

export interface SearchHistoryResponse {
  terminalId: string;
  queries: SearchHistoryItem[];
  total: number;
  limit: number;
}

// UI State types
export interface SearchUIState {
  isOpen: boolean;
  loading: boolean;
  error: string | null;
  query: SearchQuery;
  results: SearchResponse | null;
  suggestions: string[];
  showSuggestions: boolean;
  recentSearches: string[];
  currentPage: number;
  pageSize: number;
}

export interface SearchFiltersState {
  showFilters: boolean;
  availableTerminals: string[];
  selectedTerminals: string[];
  contentType: string;
  timeRangeType: 'all' | 'last_hour' | 'last_day' | 'last_week' | 'custom';
  customStartDate: string;
  customEndDate: string;
}

export interface SearchResultsState {
  sortBy: 'relevance' | 'date' | 'terminal';
  sortOrder: 'asc' | 'desc';
  viewMode: 'list' | 'compact';
}