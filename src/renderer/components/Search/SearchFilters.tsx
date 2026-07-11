import React, { useState, useEffect } from 'react';
import { SearchQuery, SearchFilter } from '../../../types/search';
import './SearchFilters.css';

interface SearchFiltersProps {
  query: SearchQuery;
  onQueryUpdate: (query: SearchQuery) => void;
}

export const SearchFilters: React.FC<SearchFiltersProps> = ({ query, onQueryUpdate }) => {
  const [showFilters, setShowFilters] = useState(false);
  const [availableTerminals, setAvailableTerminals] = useState<string[]>([]);
  const [selectedTerminals, setSelectedTerminals] = useState<string[]>(query.terminals || []);
  const [contentType, setContentType] = useState<string>('all');
  const [timeRangeType, setTimeRangeType] = useState<'all' | 'last_hour' | 'last_day' | 'last_week' | 'custom'>('all');
  const [customStartDate, setCustomStartDate] = useState('');
  const [customEndDate, setCustomEndDate] = useState('');

  useEffect(() => {
    // Load available terminals
    fetchAvailableTerminals();
  }, []);

  useEffect(() => {
    // Update query when filters change
    updateQuery();
  }, [selectedTerminals, contentType, timeRangeType, customStartDate, customEndDate]);

  const fetchAvailableTerminals = async () => {
    try {
      const response = await fetch('/api/terminals', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('api_token')}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        const terminalIds = data.map((terminal: any) => terminal.id);
        setAvailableTerminals(terminalIds);
      }
    } catch (err) {
      console.warn('Failed to fetch terminals:', err);
    }
  };

  const updateQuery = () => {
    const updatedQuery: SearchQuery = {
      ...query,
      terminals: selectedTerminals.length > 0 ? selectedTerminals : undefined,
      timeRange: getTimeRange(),
      filters: getContentFilters()
    };

    onQueryUpdate(updatedQuery);
  };

  const getTimeRange = () => {
    const now = new Date();
    
    switch (timeRangeType) {
      case 'last_hour':
        return {
          start: new Date(now.getTime() - 60 * 60 * 1000),
          end: now
        };
      case 'last_day':
        return {
          start: new Date(now.getTime() - 24 * 60 * 60 * 1000),
          end: now
        };
      case 'last_week':
        return {
          start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
          end: now
        };
      case 'custom':
        if (customStartDate && customEndDate) {
          return {
            start: new Date(customStartDate),
            end: new Date(customEndDate)
          };
        }
        return undefined;
      default:
        return undefined;
    }
  };

  const getContentFilters = (): SearchFilter[] => {
    const filters: SearchFilter[] = [];

    if (contentType !== 'all') {
      filters.push({
        type: 'content_type',
        value: contentType,
        operator: 'equals'
      });
    }

    return filters;
  };

  const handleTerminalToggle = (terminalId: string) => {
    setSelectedTerminals(prev => 
      prev.includes(terminalId)
        ? prev.filter(id => id !== terminalId)
        : [...prev, terminalId]
    );
  };

  const clearAllFilters = () => {
    setSelectedTerminals([]);
    setContentType('all');
    setTimeRangeType('all');
    setCustomStartDate('');
    setCustomEndDate('');
  };

  const activeFilterCount = [
    selectedTerminals.length > 0,
    contentType !== 'all',
    timeRangeType !== 'all'
  ].filter(Boolean).length;

  return (
    <div className="search-filters">
      <div className="filters-header">
        <button 
          className={`filters-toggle ${showFilters ? 'active' : ''}`}
          onClick={() => setShowFilters(!showFilters)}
        >
          🔧 Filters {activeFilterCount > 0 && <span className="filter-count">({activeFilterCount})</span>}
        </button>

        {activeFilterCount > 0 && (
          <button className="clear-filters" onClick={clearAllFilters}>
            Clear All
          </button>
        )}
      </div>

      {showFilters && (
        <div className="filters-content">
          {/* Terminal Filter */}
          <div className="filter-group">
            <label className="filter-label">Terminals</label>
            <div className="terminal-filters">
              {availableTerminals.length === 0 ? (
                <div className="no-terminals">No terminals available</div>
              ) : (
                <>
                  <button
                    className={`terminal-filter ${selectedTerminals.length === 0 ? 'active' : ''}`}
                    onClick={() => setSelectedTerminals([])}
                  >
                    All Terminals
                  </button>
                  {availableTerminals.map(terminalId => (
                    <button
                      key={terminalId}
                      className={`terminal-filter ${selectedTerminals.includes(terminalId) ? 'active' : ''}`}
                      onClick={() => handleTerminalToggle(terminalId)}
                    >
                      {terminalId.length > 15 ? `${terminalId.substring(0, 15)}...` : terminalId}
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>

          {/* Content Type Filter */}
          <div className="filter-group">
            <label className="filter-label">Content Type</label>
            <div className="content-type-filters">
              <select 
                value={contentType} 
                onChange={(e) => setContentType(e.target.value)}
                className="content-type-select"
              >
                <option value="all">All Content</option>
                <option value="output">Output Only</option>
                <option value="input">Input Only</option>
                <option value="command">Commands Only</option>
                <option value="error">Errors Only</option>
              </select>
            </div>
          </div>

          {/* Time Range Filter */}
          <div className="filter-group">
            <label className="filter-label">Time Range</label>
            <div className="time-range-filters">
              <div className="time-range-options">
                {[
                  { value: 'all', label: 'All Time' },
                  { value: 'last_hour', label: 'Last Hour' },
                  { value: 'last_day', label: 'Last 24 Hours' },
                  { value: 'last_week', label: 'Last Week' },
                  { value: 'custom', label: 'Custom Range' }
                ].map(option => (
                  <button
                    key={option.value}
                    className={`time-range-option ${timeRangeType === option.value ? 'active' : ''}`}
                    onClick={() => setTimeRangeType(option.value as any)}
                  >
                    {option.label}
                  </button>
                ))}
              </div>

              {timeRangeType === 'custom' && (
                <div className="custom-date-range">
                  <div className="date-input-group">
                    <label>From:</label>
                    <input
                      type="datetime-local"
                      value={customStartDate}
                      onChange={(e) => setCustomStartDate(e.target.value)}
                      className="date-input"
                    />
                  </div>
                  <div className="date-input-group">
                    <label>To:</label>
                    <input
                      type="datetime-local"
                      value={customEndDate}
                      onChange={(e) => setCustomEndDate(e.target.value)}
                      className="date-input"
                    />
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Active Filters Summary */}
          {activeFilterCount > 0 && (
            <div className="active-filters">
              <div className="active-filters-header">Active Filters:</div>
              <div className="active-filters-list">
                {selectedTerminals.length > 0 && (
                  <div className="active-filter">
                    Terminals: {selectedTerminals.length} selected
                  </div>
                )}
                {contentType !== 'all' && (
                  <div className="active-filter">
                    Type: {contentType}
                  </div>
                )}
                {timeRangeType !== 'all' && (
                  <div className="active-filter">
                    Time: {timeRangeType === 'custom' ? 'Custom range' : timeRangeType.replace('_', ' ')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};