import React, { useState } from 'react';
import { SearchResponse, SearchResult, SearchQuery } from '../../../types/search';
import './SearchResults.css';

interface SearchResultsProps {
  response: SearchResponse;
  query: SearchQuery;
  currentPage: number;
  onPageChange: (page: number) => void;
  onResultClick: (result: SearchResult) => void;
}

export const SearchResults: React.FC<SearchResultsProps> = ({
  response,
  query,
  currentPage,
  onPageChange,
  onResultClick
}) => {
  const [sortBy, setSortBy] = useState<'relevance' | 'date' | 'terminal'>('relevance');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [viewMode, setViewMode] = useState<'list' | 'compact'>('list');

  const sortedResults = [...response.results].sort((a, b) => {
    let comparison = 0;
    
    switch (sortBy) {
      case 'relevance':
        comparison = a.score - b.score;
        break;
      case 'date':
        comparison = new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime();
        break;
      case 'terminal':
        comparison = a.terminalId.localeCompare(b.terminalId);
        break;
    }
    
    return sortOrder === 'asc' ? comparison : -comparison;
  });

  const highlightMatches = (text: string, searchTerm: string, caseSensitive: boolean = false): React.ReactNode => {
    if (!query.highlight || !searchTerm) {
      return text;
    }

    const flags = caseSensitive ? 'g' : 'gi';
    const regex = new RegExp(`(${escapeRegExp(searchTerm)})`, flags);
    const parts = text.split(regex);
    
    return parts.map((part, index) => {
      const isMatch = regex.test(part);
      return isMatch ? (
        <mark key={index} className="search-highlight">{part}</mark>
      ) : (
        part
      );
    });
  };

  const escapeRegExp = (string: string): string => {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  };

  const formatTimestamp = (timestamp: string): string => {
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
  };

  const formatTime = (timestamp: string): string => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const getContentTypeIcon = (type: string): string => {
    switch (type) {
      case 'input': return '📝';
      case 'output': return '📄';
      case 'command': return '⚡';
      case 'error': return '❌';
      default: return '📄';
    }
  };

  const exportResults = (format: 'json' | 'csv' | 'txt') => {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    let content: string;
    let filename: string;
    let mimeType: string;

    switch (format) {
      case 'json':
        content = JSON.stringify({
          query: query,
          results: response.results,
          total: response.total,
          exportedAt: new Date().toISOString()
        }, null, 2);
        filename = `search-results-${timestamp}.json`;
        mimeType = 'application/json';
        break;
      
      case 'csv':
        const csvHeaders = ['Terminal', 'Type', 'Timestamp', 'Content', 'Score'];
        const csvRows = response.results.map(result => [
          result.terminalId,
          result.metadata.type,
          result.timestamp,
          `"${result.content.replace(/"/g, '""')}"`,
          result.score
        ]);
        content = [csvHeaders, ...csvRows].map(row => row.join(',')).join('\n');
        filename = `search-results-${timestamp}.csv`;
        mimeType = 'text/csv';
        break;
      
      case 'txt':
        content = response.results.map(result => 
          `[${result.timestamp}] ${result.terminalId} (${result.metadata.type})\n${result.content}\n${'='.repeat(80)}\n`
        ).join('\n');
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
  };

  const totalPages = Math.ceil(response.total / response.pageSize);

  return (
    <div className="search-results">
      <div className="results-header">
        <div className="results-info">
          <span className="results-count">
            {response.total} result{response.total !== 1 ? 's' : ''} 
            {response.total > 0 && ` (${response.executionTime}ms)`}
          </span>
          {response.suggestions && response.suggestions.length > 0 && (
            <div className="search-suggestions">
              Did you mean: {response.suggestions.map((suggestion, index) => (
                <button key={index} className="suggestion-link">
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="results-controls">
          <div className="sort-controls">
            <label>Sort by:</label>
            <select 
              value={sortBy} 
              onChange={(e) => setSortBy(e.target.value as 'relevance' | 'date' | 'terminal')}
            >
              <option value="relevance">Relevance</option>
              <option value="date">Date</option>
              <option value="terminal">Terminal</option>
            </select>
            <button 
              onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
              className="sort-order-button"
              title={`Sort ${sortOrder === 'asc' ? 'descending' : 'ascending'}`}
            >
              {sortOrder === 'asc' ? '↑' : '↓'}
            </button>
          </div>

          <div className="view-controls">
            <button
              className={`view-button ${viewMode === 'list' ? 'active' : ''}`}
              onClick={() => setViewMode('list')}
              title="List view"
            >
              ☰
            </button>
            <button
              className={`view-button ${viewMode === 'compact' ? 'active' : ''}`}
              onClick={() => setViewMode('compact')}
              title="Compact view"
            >
              ≡
            </button>
          </div>

          <div className="export-controls">
            <div className="export-dropdown">
              <button className="export-button">Export ↓</button>
              <div className="export-menu">
                <button onClick={() => exportResults('json')}>Export as JSON</button>
                <button onClick={() => exportResults('csv')}>Export as CSV</button>
                <button onClick={() => exportResults('txt')}>Export as Text</button>
              </div>
            </div>
          </div>
        </div>
      </div>

      {sortedResults.length === 0 ? (
        <div className="no-results">
          <div className="no-results-icon">🔍</div>
          <div className="no-results-message">No results found</div>
          <div className="no-results-suggestions">
            Try adjusting your search terms or filters
          </div>
        </div>
      ) : (
        <>
          <div className={`results-list ${viewMode}`}>
            {sortedResults.map((result) => (
              <div 
                key={result.id} 
                className="result-item"
                onClick={() => onResultClick(result)}
              >
                <div className="result-header">
                  <div className="result-meta">
                    <span className="result-icon">
                      {getContentTypeIcon(result.metadata.type || 'output')}
                    </span>
                    <span className="result-terminal">
                      {result.terminalId}
                    </span>
                    <span className="result-type">
                      {result.metadata.type}
                    </span>
                    <span className="result-time" title={formatTime(result.timestamp.toString())}>
                      {formatTimestamp(result.timestamp.toString())}
                    </span>
                    <span className="result-score">
                      Score: {result.score}
                    </span>
                  </div>
                </div>

                <div className="result-content">
                  {viewMode === 'compact' ? (
                    <div className="result-context">
                      {highlightMatches(result.context, query.text, query.caseSensitive)}
                    </div>
                  ) : (
                    <div className="result-full-content">
                      {highlightMatches(result.content, query.text, query.caseSensitive)}
                    </div>
                  )}
                </div>

                {result.matches && result.matches.length > 0 && (
                  <div className="result-matches">
                    {result.matches.length} match{result.matches.length !== 1 ? 'es' : ''} found
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="pagination">
              <button 
                className="pagination-button"
                disabled={currentPage === 1}
                onClick={() => onPageChange(currentPage - 1)}
              >
                ← Previous
              </button>

              <div className="pagination-info">
                Page {currentPage} of {totalPages}
              </div>

              <div className="pagination-pages">
                {Array.from({ length: Math.min(7, totalPages) }, (_, i) => {
                  let pageNum;
                  if (totalPages <= 7) {
                    pageNum = i + 1;
                  } else if (currentPage <= 4) {
                    pageNum = i + 1;
                  } else if (currentPage >= totalPages - 3) {
                    pageNum = totalPages - 6 + i;
                  } else {
                    pageNum = currentPage - 3 + i;
                  }

                  return (
                    <button
                      key={pageNum}
                      className={`pagination-page ${currentPage === pageNum ? 'active' : ''}`}
                      onClick={() => onPageChange(pageNum)}
                    >
                      {pageNum}
                    </button>
                  );
                })}
              </div>

              <button 
                className="pagination-button"
                disabled={currentPage === totalPages}
                onClick={() => onPageChange(currentPage + 1)}
              >
                Next →
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
};