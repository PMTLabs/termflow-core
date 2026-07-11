import axiosInstance from './axiosConfig';
import {
  SearchQuery,
  SearchResponse,
  SearchRequest,
  AdvancedSearchRequest,
  SearchSuggestionsResponse,
  SearchStatsResponse,
  SearchHistoryResponse,
} from '../types/search';

class SearchApiService {
  /**
   * Perform basic search
   */
  async search(params: SearchRequest): Promise<SearchResponse> {
    try {
      const response = await axiosInstance.get<SearchResponse>('/api/search', {
        params,
      });
      return response.data;
    } catch (error) {
      console.error('Failed to perform search:', error);
      throw error;
    }
  }

  /**
   * Perform advanced search with full query object
   */
  async advancedSearch(request: AdvancedSearchRequest): Promise<SearchResponse> {
    try {
      const response = await axiosInstance.post<SearchResponse>('/api/search', request);
      return response.data;
    } catch (error) {
      console.error('Failed to perform advanced search:', error);
      throw error;
    }
  }

  /**
   * Get search suggestions
   */
  async getSuggestions(query: string, limit: number = 10): Promise<SearchSuggestionsResponse> {
    try {
      const response = await axiosInstance.get<SearchSuggestionsResponse>(
        '/api/search/suggestions',
        {
          params: { q: query, limit },
        }
      );
      return response.data;
    } catch (error) {
      console.error('Failed to get search suggestions:', error);
      throw error;
    }
  }

  /**
   * Index content for search
   */
  async indexContent(
    terminalId: string,
    content: string,
    type: 'output' | 'input' | 'command' | 'error' = 'output',
    metadata: Record<string, any> = {}
  ): Promise<void> {
    try {
      await axiosInstance.post('/api/search/index/content', {
        terminalId,
        content,
        type,
        metadata,
      });
    } catch (error) {
      console.error('Failed to index content:', error);
      throw error;
    }
  }

  /**
   * Clear entire search index
   */
  async clearIndex(): Promise<void> {
    try {
      await axiosInstance.delete('/api/search/index');
    } catch (error) {
      console.error('Failed to clear search index:', error);
      throw error;
    }
  }

  /**
   * Clear search index for specific terminal
   */
  async clearTerminalIndex(terminalId: string): Promise<void> {
    try {
      await axiosInstance.delete(`/api/search/index/terminal/${terminalId}`);
    } catch (error) {
      console.error(`Failed to clear search index for terminal ${terminalId}:`, error);
      throw error;
    }
  }

  /**
   * Get search statistics
   */
  async getSearchStats(): Promise<SearchStatsResponse> {
    try {
      const response = await axiosInstance.get<SearchStatsResponse>('/api/search/stats');
      return response.data;
    } catch (error) {
      console.error('Failed to get search stats:', error);
      throw error;
    }
  }

  /**
   * Get search history
   */
  async getSearchHistory(
    terminalId?: string,
    limit: number = 50
  ): Promise<SearchHistoryResponse> {
    try {
      const params: any = { limit };
      if (terminalId) {
        params.terminalId = terminalId;
      }

      const response = await axiosInstance.get<SearchHistoryResponse>('/api/search/history', {
        params,
      });
      return response.data;
    } catch (error) {
      console.error('Failed to get search history:', error);
      throw error;
    }
  }

  /**
   * Export search results
   */
  async exportSearchResults(
    searchResponse: SearchResponse,
    format: 'json' | 'csv' | 'txt'
  ): Promise<void> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let content: string;
    let filename: string;
    let mimeType: string;

    switch (format) {
      case 'json':
        content = JSON.stringify(
          {
            query: searchResponse.query,
            results: searchResponse.results,
            total: searchResponse.total,
            exportedAt: new Date().toISOString(),
          },
          null,
          2
        );
        filename = `search-results-${timestamp}.json`;
        mimeType = 'application/json';
        break;

      case 'csv':
        const csvHeaders = ['Terminal', 'Type', 'Timestamp', 'Content', 'Score'];
        const csvRows = searchResponse.results.map((result) => [
          result.terminalId,
          result.metadata.type,
          result.timestamp,
          `"${result.content.replace(/"/g, '""')}"`,
          result.score,
        ]);
        content = [csvHeaders, ...csvRows].map((row) => row.join(',')).join('\n');
        filename = `search-results-${timestamp}.csv`;
        mimeType = 'text/csv';
        break;

      case 'txt':
        content = searchResponse.results
          .map(
            (result) =>
              `[${result.timestamp}] ${result.terminalId} (${result.metadata.type})\n${result.content}\n${'='.repeat(80)}\n`
          )
          .join('\n');
        filename = `search-results-${timestamp}.txt`;
        mimeType = 'text/plain';
        break;
    }

    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /**
   * Build search query for simple search
   */
  buildSearchRequest(
    text: string,
    options: {
      terminals?: string[];
      contentType?: string;
      timeRangeType?: string;
      customStartDate?: string;
      customEndDate?: string;
      caseSensitive?: boolean;
      regex?: boolean;
      wholeWord?: boolean;
      page?: number;
      pageSize?: number;
    } = {}
  ): SearchRequest {
    const request: SearchRequest = {
      q: text,
      page: options.page || 1,
      pageSize: options.pageSize || 50,
      caseSensitive: options.caseSensitive || false,
      regex: options.regex || false,
      wholeWord: options.wholeWord || false,
      highlight: true,
    };

    if (options.terminals && options.terminals.length > 0) {
      request.terminals = options.terminals;
    }

    if (options.contentType && options.contentType !== 'all') {
      request.type = options.contentType;
    }

    // Handle time range
    if (options.timeRangeType && options.timeRangeType !== 'all') {
      const now = new Date();
      switch (options.timeRangeType) {
        case 'last_hour':
          request.startDate = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
          request.endDate = now.toISOString();
          break;
        case 'last_day':
          request.startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
          request.endDate = now.toISOString();
          break;
        case 'last_week':
          request.startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
          request.endDate = now.toISOString();
          break;
        case 'custom':
          if (options.customStartDate && options.customEndDate) {
            request.startDate = options.customStartDate;
            request.endDate = options.customEndDate;
          }
          break;
      }
    }

    return request;
  }

  /**
   * Build advanced search query
   */
  buildAdvancedSearchRequest(
    query: SearchQuery,
    page: number = 1,
    pageSize: number = 50
  ): AdvancedSearchRequest {
    return {
      query,
      page,
      pageSize,
    };
  }

  /**
   * Highlight search matches in text
   */
  highlightMatches(
    text: string,
    searchTerm: string,
    caseSensitive: boolean = false
  ): string {
    if (!searchTerm) return text;

    const flags = caseSensitive ? 'g' : 'gi';
    const escapedTerm = searchTerm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`(${escapedTerm})`, flags);

    return text.replace(regex, '<mark>$1</mark>');
  }

  /**
   * Format search execution time
   */
  formatExecutionTime(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    }
    return `${(ms / 1000).toFixed(2)}s`;
  }

  /**
   * Get content type icon
   */
  getContentTypeIcon(type: string): string {
    switch (type) {
      case 'input':
        return '📝';
      case 'output':
        return '📄';
      case 'command':
        return '⚡';
      case 'error':
        return '❌';
      default:
        return '📄';
    }
  }

  /**
   * Format timestamp for search results
   */
  formatTimestamp(timestamp: string | Date): string {
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;

    return date.toLocaleDateString();
  }

  /**
   * Get local storage key for search history
   */
  private getSearchHistoryKey(): string {
    return 'terminal_monitor_search_history';
  }

  /**
   * Save search to local history
   */
  saveSearchToHistory(searchText: string): void {
    if (!searchText.trim()) return;

    try {
      const saved = localStorage.getItem(this.getSearchHistoryKey());
      const history = saved ? JSON.parse(saved) : [];
      
      const newHistory = [
        searchText,
        ...history.filter((s: string) => s !== searchText)
      ].slice(0, 20);
      
      localStorage.setItem(this.getSearchHistoryKey(), JSON.stringify(newHistory));
    } catch (e) {
      console.warn('Failed to save search history:', e);
    }
  }

  /**
   * Load search history from local storage
   */
  loadSearchHistory(): string[] {
    try {
      const saved = localStorage.getItem(this.getSearchHistoryKey());
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      console.warn('Failed to load search history:', e);
      return [];
    }
  }

  /**
   * Clear search history
   */
  clearSearchHistory(): void {
    try {
      localStorage.removeItem(this.getSearchHistoryKey());
    } catch (e) {
      console.warn('Failed to clear search history:', e);
    }
  }
}

export default new SearchApiService();