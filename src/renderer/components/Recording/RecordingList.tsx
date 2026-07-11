import React, { useState, useEffect } from 'react';
import { useDispatch } from 'react-redux';
import { addToast } from '../../store/slices/uiSlice';
// import { TerminalRecording } from '../../../types/recording';
import './RecordingList.css';

interface RecordingListItem {
  id: string;
  terminalId: string;
  startTime: string;
  endTime?: string;
  metadata: any;
  size: number;
  compressed: boolean;
  eventCount: number;
  duration: number | null;
}

interface RecordingListProps {
  onPlayRecording: (recordingId: string) => void;
  onRefresh: () => void;
}

export const RecordingList: React.FC<RecordingListProps> = ({ onPlayRecording, onRefresh }) => {
  const dispatch = useDispatch();
  const [recordings, setRecordings] = useState<RecordingListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedRecordings, setSelectedRecordings] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<'date' | 'duration' | 'size'>('date');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    loadRecordings();
  }, []);

  const loadRecordings = async () => {
    try {
      setLoading(true);
      setError(null);

      // This would be replaced with actual API call
      const response = await fetch('/api/recordings', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('api_token')}`
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to load recordings: ${response.statusText}`);
      }

      const data = await response.json();
      setRecordings(data.recordings || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load recordings');
    } finally {
      setLoading(false);
    }
  };

  const deleteRecording = async (recordingId: string) => {
    if (!confirm('Are you sure you want to delete this recording?')) {
      return;
    }

    try {
      const response = await fetch(`/api/recordings/${recordingId}`, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('api_token')}`
        }
      });

      if (!response.ok) {
        throw new Error(`Failed to delete recording: ${response.statusText}`);
      }

      setRecordings(prev => prev.filter(r => r.id !== recordingId));
      setSelectedRecordings(prev => {
        const newSet = new Set(prev);
        newSet.delete(recordingId);
        return newSet;
      });
    } catch (err) {
      dispatch(addToast({
        message: err instanceof Error ? err.message : 'Failed to delete recording',
        type: 'error'
      }));
    }
  };

  const exportRecording = async (recordingId: string, format: 'json' | 'text' | 'html') => {
    try {
      const response = await fetch(`/api/recordings/${recordingId}/export`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${localStorage.getItem('api_token')}`
        },
        body: JSON.stringify({ format })
      });

      if (!response.ok) {
        throw new Error(`Failed to export recording: ${response.statusText}`);
      }

      // Trigger download
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `recording-${recordingId}.${format === 'text' ? 'txt' : format}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      dispatch(addToast({
        message: err instanceof Error ? err.message : 'Failed to export recording',
        type: 'error'
      }));
    }
  };

  const formatFileSize = (bytes: number): string => {
    const units = ['B', 'KB', 'MB', 'GB'];
    let size = bytes;
    let unitIndex = 0;

    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }

    return `${size.toFixed(1)} ${units[unitIndex]}`;
  };

  const formatDuration = (ms: number | null): string => {
    if (!ms) return 'Unknown';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const formatDate = (dateString: string): string => {
    const date = new Date(dateString);
    return date.toLocaleString();
  };

  const sortedAndFilteredRecordings = recordings
    .filter(recording => {
      if (!filter) return true;
      const searchTerm = filter.toLowerCase();
      return (
        recording.id.toLowerCase().includes(searchTerm) ||
        recording.terminalId.toLowerCase().includes(searchTerm) ||
        (recording.metadata.title && recording.metadata.title.toLowerCase().includes(searchTerm))
      );
    })
    .sort((a, b) => {
      let comparison = 0;

      switch (sortBy) {
        case 'date':
          comparison = new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
          break;
        case 'duration':
          comparison = (a.duration || 0) - (b.duration || 0);
          break;
        case 'size':
          comparison = a.size - b.size;
          break;
      }

      return sortOrder === 'asc' ? comparison : -comparison;
    });

  const toggleRecordingSelection = (recordingId: string) => {
    setSelectedRecordings(prev => {
      const newSet = new Set(prev);
      if (newSet.has(recordingId)) {
        newSet.delete(recordingId);
      } else {
        newSet.add(recordingId);
      }
      return newSet;
    });
  };

  const selectAllRecordings = () => {
    setSelectedRecordings(new Set(sortedAndFilteredRecordings.map(r => r.id)));
  };

  const clearSelection = () => {
    setSelectedRecordings(new Set());
  };

  const deleteSelectedRecordings = async () => {
    if (selectedRecordings.size === 0) return;

    if (!confirm(`Are you sure you want to delete ${selectedRecordings.size} recording(s)?`)) {
      return;
    }

    const deletePromises = Array.from(selectedRecordings).map(id => deleteRecording(id));
    await Promise.all(deletePromises);
    setSelectedRecordings(new Set());
  };

  if (loading) {
    return (
      <div className="recording-list-loading">
        <div className="loading-spinner"></div>
        Loading recordings...
      </div>
    );
  }

  if (error) {
    return (
      <div className="recording-list-error">
        <div className="error-message">{error}</div>
        <button onClick={loadRecordings} className="retry-button">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="recording-list">
      <div className="recording-list-header">
        <h2>Terminal Recordings</h2>
        <div className="header-actions">
          <button onClick={onRefresh} className="refresh-button" title="Refresh">
            ↻
          </button>
        </div>
      </div>

      <div className="recording-list-controls">
        <div className="search-filter">
          <input
            type="text"
            placeholder="Search recordings..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="search-input"
          />
        </div>

        <div className="sort-controls">
          <label>Sort by:</label>
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'date' | 'duration' | 'size')}
          >
            <option value="date">Date</option>
            <option value="duration">Duration</option>
            <option value="size">Size</option>
          </select>
          <button
            onClick={() => setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc')}
            className="sort-order-button"
            title={`Sort ${sortOrder === 'asc' ? 'descending' : 'ascending'}`}
          >
            {sortOrder === 'asc' ? '↑' : '↓'}
          </button>
        </div>

        {selectedRecordings.size > 0 && (
          <div className="selection-actions">
            <span>{selectedRecordings.size} selected</span>
            <button onClick={clearSelection} className="clear-selection">
              Clear
            </button>
            <button onClick={deleteSelectedRecordings} className="delete-selected">
              Delete Selected
            </button>
          </div>
        )}
      </div>

      {sortedAndFilteredRecordings.length === 0 ? (
        <div className="no-recordings">
          <div className="no-recordings-message">
            {filter ? 'No recordings match your search.' : 'No recordings found.'}
          </div>
        </div>
      ) : (
        <div className="recording-list-content">
          <div className="bulk-actions">
            <button onClick={selectAllRecordings}>Select All</button>
          </div>

          <div className="recordings-grid">
            {sortedAndFilteredRecordings.map((recording) => (
              <div
                key={recording.id}
                className={`recording-item ${selectedRecordings.has(recording.id) ? 'selected' : ''}`}
              >
                <div className="recording-checkbox">
                  <input
                    type="checkbox"
                    checked={selectedRecordings.has(recording.id)}
                    onChange={() => toggleRecordingSelection(recording.id)}
                  />
                </div>

                <div className="recording-info">
                  <div className="recording-title">
                    {recording.metadata.title || `Recording ${recording.id.substring(0, 8)}`}
                  </div>
                  <div className="recording-details">
                    <span>Terminal: {recording.terminalId}</span>
                    <span>Started: {formatDate(recording.startTime)}</span>
                    <span>Duration: {formatDuration(recording.duration)}</span>
                    <span>Size: {formatFileSize(recording.size)}</span>
                    <span>Events: {recording.eventCount}</span>
                  </div>
                </div>

                <div className="recording-actions">
                  <button
                    onClick={() => onPlayRecording(recording.id)}
                    className="play-button"
                    title="Play Recording"
                  >
                    ▶
                  </button>

                  <div className="export-dropdown">
                    <button className="export-button" title="Export">
                      ↓
                    </button>
                    <div className="export-menu">
                      <button onClick={() => exportRecording(recording.id, 'json')}>
                        Export as JSON
                      </button>
                      <button onClick={() => exportRecording(recording.id, 'text')}>
                        Export as Text
                      </button>
                      <button onClick={() => exportRecording(recording.id, 'html')}>
                        Export as HTML
                      </button>
                    </div>
                  </div>

                  <button
                    onClick={() => deleteRecording(recording.id)}
                    className="delete-button"
                    title="Delete Recording"
                  >
                    🗑
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};