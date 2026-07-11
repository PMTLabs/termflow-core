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