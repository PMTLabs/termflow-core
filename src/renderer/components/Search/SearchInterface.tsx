import React, { useState, useEffect, useCallback, useRef } from 'react';
import { SearchQuery, SearchResponse } from '../../../types/search';
import { SearchFilters } from './SearchFilters';
import { SearchResults } from './SearchResults';
import './SearchInterface.css';

interface SearchInterfaceProps {
  onClose: () => void;
}

export const SearchInterface: React.FC<SearchInterfaceProps> = ({ onClose }) => {
  const [query, setQuery] = useState<SearchQuery>({
    text: '',
    highlight: true,
    caseSensitive: false,
    regex: false,
    wholeWord: false
  });
  const [searchResponse, setSearchResponse] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize] = useState(50);

  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    // Load recent searches from localStorage
    const saved = localStorage.getItem('terminal_search_history');
    if (saved) {
      try {
        setRecentSearches(JSON.parse(saved));
      } catch (e) {
        console.warn('Failed to load search history:', e);
      }
    }

    // Focus search input
    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, []);

  const saveSearchToHistory = useCallback((searchText: string) => {
    if (!searchText.trim()) return;

    setRecentSearches(prev => {
      const newHistory = [searchText, ...prev.filter(s => s !== searchText)].slice(0, 20);
      localStorage.setItem('terminal_search_history', JSON.stringify(newHistory));
      return newHistory;
    });
  }, []);

  const performSearch = useCallback(async (searchQuery: SearchQuery, page: number = 1) => {
    if (!searchQuery.text.trim()) {
      setSearchResponse(null);
      return;
    }

    setLoading(true);
    setError(null);
    setCurrentPage(page);

    try {
      const response = await fetch('/api/search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('api_token')}`
        },
        body: JSON.stringify({
          query: searchQuery,
          page,
          pageSize
        })
      });

      if (!response.ok) {
        throw new Error(`Search failed: ${response.statusText}`);
      }

      const data: SearchResponse = await response.json();
      setSearchResponse(data);
      
      if (page === 1) {
        saveSearchToHistory(searchQuery.text);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
      setSearchResponse(null);
    } finally {
      setLoading(false);
    }
  }, [pageSize, saveSearchToHistory]);

  const fetchSuggestions = useCallback(async (searchText: string) => {
    if (!searchText.trim() || searchText.length < 2) {
      setSuggestions([]);
      return;
    }

    try {
      const response = await fetch(`/api/search/suggestions?q=${encodeURIComponent(searchText)}`, {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('api_token')}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setSuggestions(data.suggestions || []);
      }
    } catch (err) {
      console.warn('Failed to fetch suggestions:', err);
    }
  }, []);

  const handleSearchInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newText = e.target.value;
    setQuery(prev => ({ ...prev, text: newText }));

    // Clear previous timeout
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }

    // Fetch suggestions with debounce
    searchTimeoutRef.current = setTimeout(() => {
      fetchSuggestions(newText);
    }, 300);
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setShowSuggestions(false);
    performSearch(query, 1);
  };

  const handleSuggestionClick = (suggestion: string) => {
    const newQuery = { ...query, text: suggestion };
    setQuery(newQuery);
    setShowSuggestions(false);
    performSearch(newQuery, 1);
  };

  const handleRecentSearchClick = (searchText: string) => {
    const newQuery = { ...query, text: searchText };
    setQuery(newQuery);
    performSearch(newQuery, 1);
  };

  const handleQueryUpdate = (updatedQuery: SearchQuery) => {
    setQuery(updatedQuery);
    if (updatedQuery.text.trim()) {
      performSearch(updatedQuery, 1);
    }
  };

  const handlePageChange = (page: number) => {
    performSearch(query, page);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (showSuggestions) {
        setShowSuggestions(false);
      } else {
        onClose();
      }
    }
  };

  const clearSearch = () => {
    setQuery(prev => ({ ...prev, text: '' }));
    setSearchResponse(null);
    setError(null);
    setSuggestions([]);
    setShowSuggestions(false);
    if (searchInputRef.current) {
      searchInputRef.current.focus();
    }
  };

  return (
    <div className="search-interface" onKeyDown={handleKeyDown}>
      <div className="search-header">
        <div className="search-title">
          <h2>Terminal Search</h2>
          <button onClick={onClose} className="close-button" title="Close Search">
            ✕
          </button>
        </div>

        <form onSubmit={handleSearchSubmit} className="search-form">
          <div className="search-input-container">
            <input
              ref={searchInputRef}
              type="text"
              value={query.text}
              onChange={handleSearchInputChange}
              onFocus={() => setShowSuggestions(true)}
              placeholder="Search terminal output..."
              className="search-input"
              autoComplete="off"
            />
            
            {query.text && (
              <button
                type="button"
                onClick={clearSearch}
                className="clear-search-button"
                title="Clear search"
              >
                ✕
              </button>
            )}

            <button type="submit" className="search-button" disabled={loading}>
              {loading ? '⏳' : '🔍'}
            </button>

            {/* Suggestions dropdown */}
            {showSuggestions && (suggestions.length > 0 || recentSearches.length > 0) && (
              <div className="suggestions-dropdown">
                {suggestions.length > 0 && (
                  <div className="suggestions-section">
                    <div className="suggestions-header">Suggestions</div>
                    {suggestions.map((suggestion, index) => (
                      <button
                        key={index}
                        className="suggestion-item"
                        onClick={() => handleSuggestionClick(suggestion)}
                      >
                        🔍 {suggestion}
                      </button>
                    ))}
                  </div>
                )}

                {recentSearches.length > 0 && (
                  <div className="suggestions-section">
                    <div className="suggestions-header">Recent Searches</div>
                    {recentSearches.slice(0, 5).map((search, index) => (
                      <button
                        key={index}
                        className="suggestion-item recent-search"
                        onClick={() => handleRecentSearchClick(search)}
                      >
                        ⏱ {search}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="search-options">
            <label className="search-option">
              <input
                type="checkbox"
                checked={query.caseSensitive}
                onChange={(e) => setQuery(prev => ({ ...prev, caseSensitive: e.target.checked }))}
              />
              Case sensitive
            </label>
            
            <label className="search-option">
              <input
                type="checkbox"
                checked={query.regex}
                onChange={(e) => setQuery(prev => ({ ...prev, regex: e.target.checked }))}
              />
              Regex
            </label>
            
            <label className="search-option">
              <input
                type="checkbox"
                checked={query.wholeWord}
                onChange={(e) => setQuery(prev => ({ ...prev, wholeWord: e.target.checked }))}
              />
              Whole word
            </label>
          </div>
        </form>
      </div>

      <div className="search-content">
        <SearchFilters
          query={query}
          onQueryUpdate={handleQueryUpdate}
        />

        <div className="search-results-section">
          {error && (
            <div className="search-error">
              <div className="error-message">{error}</div>
              <button onClick={() => performSearch(query, currentPage)} className="retry-button">
                Retry Search
              </button>
            </div>
          )}

          {loading && (
            <div className="search-loading">
              <div className="loading-spinner"></div>
              Searching...
            </div>
          )}

          {searchResponse && !loading && (
            <SearchResults
              response={searchResponse}
              query={query}
              currentPage={currentPage}
              onPageChange={handlePageChange}
              onResultClick={(result) => {
                console.log('Result clicked:', result);
                // Could implement navigation to specific terminal/line
              }}
            />
          )}

          {!loading && !error && !searchResponse && query.text.trim() && (
            <div className="no-search-performed">
              <div className="search-placeholder">
                Enter a search term and press Enter to search terminal output.
              </div>
            </div>
          )}

          {!loading && !error && !searchResponse && !query.text.trim() && (
            <div className="search-help">
              <div className="help-section">
                <h3>Search Tips</h3>
                <ul>
                  <li>Use quotes for exact phrases: <code>"error message"</code></li>
                  <li>Use regex for pattern matching: <code>error.*failed</code></li>
                  <li>Filter by terminal, time range, or content type</li>
                  <li>Use <kbd>Esc</kbd> to close search</li>
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};