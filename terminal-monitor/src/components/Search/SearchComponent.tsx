import React, { useState, useEffect } from 'react';
import {
  TextField,
  InputAdornment,
  IconButton,
  Box,
  List,
  ListItem,
  ListItemText,
  Paper,
  Typography,
  CircularProgress,
  Chip,
  Card,
  CardContent,
  Button,
  Fade,
  Collapse,
} from '@mui/material';
import {
  Search as SearchIcon,
  Clear as ClearIcon,
  Settings as SettingsIcon,
  FilterList as FilterIcon,
} from '@mui/icons-material';
import { useDebounce } from '../../hooks/useDebounce';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../store/store';
import {
  performSearch,
  openSearch,
  setSearchQuery,
  clearSearchResults,
  hideSuggestions,
} from '../../store/slices/searchSlice';
import searchApiService from '../../services/searchApiService';
import AdvancedSearchDialog from './AdvancedSearchDialog';

const SearchComponent: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const [search, setSearch] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  
  const { terminals } = useSelector((state: RootState) => state.terminals);
  const {
    currentResults,
    isSearching,
    error,
    uiState,
  } = useSelector((state: RootState) => state.search);

  // Use debounced search value to avoid excessive API calls
  const debouncedSearch = useDebounce(search, 500);

  useEffect(() => {
    if (debouncedSearch.length >= 2) {
      // Perform quick search
      const searchRequest = searchApiService.buildSearchRequest(debouncedSearch, {
        page: 1,
        pageSize: 10, // Limit for quick search
      });
      
      dispatch(performSearch(searchRequest));
    } else if (debouncedSearch.length === 0) {
      dispatch(clearSearchResults());
    }
  }, [debouncedSearch, dispatch]);

  const handleClear = () => {
    setSearch('');
    dispatch(clearSearchResults());
    dispatch(hideSuggestions());
  };

  const handleAdvancedSearch = () => {
    dispatch(openSearch(search));
    setShowAdvanced(true);
  };

  const handleQuickSearch = () => {
    if (search.trim()) {
      const searchRequest = searchApiService.buildSearchRequest(search, {
        page: 1,
        pageSize: 50,
      });
      dispatch(performSearch(searchRequest));
    }
  };

  const formatTimestamp = (timestamp: Date) => {
    return searchApiService.formatTimestamp(timestamp);
  };

  const getContentTypeIcon = (type: string) => {
    return searchApiService.getContentTypeIcon(type);
  };

  return (
    <Box sx={{ width: '100%', maxWidth: 800, mx: 'auto' }}>
      {/* Search Input */}
      <Card variant="outlined">
        <CardContent sx={{ pb: 2 }}>
          <Box display="flex" gap={2} alignItems="flex-start">
            <TextField
              fullWidth
              variant="outlined"
              placeholder="Search terminal output... (min 2 characters for live search)"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleQuickSearch()}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon color="action" />
                  </InputAdornment>
                ),
                endAdornment: search && (
                  <InputAdornment position="end">
                    {isSearching ? (
                      <CircularProgress size={20} />
                    ) : (
                      <IconButton onClick={handleClear} size="small">
                        <ClearIcon />
                      </IconButton>
                    )}
                  </InputAdornment>
                ),
              }}
              error={!!error}
              helperText={error}
            />
            <Button
              variant="outlined"
              startIcon={<SettingsIcon />}
              onClick={handleAdvancedSearch}
              sx={{ minWidth: 'auto', px: 2 }}
            >
              Advanced
            </Button>
          </Box>

          {/* Quick Stats */}
          {currentResults && (
            <Box mt={2} display="flex" alignItems="center" gap={2}>
              <Typography variant="body2" color="text.secondary">
                {currentResults.total} results in {searchApiService.formatExecutionTime(currentResults.executionTime)}
              </Typography>
              {currentResults.total > currentResults.results.length && (
                <Chip 
                  label={`Showing ${currentResults.results.length} of ${currentResults.total}`}
                  size="small"
                  color="info"
                />
              )}
              <Button
                size="small"
                onClick={handleAdvancedSearch}
                startIcon={<FilterIcon />}
              >
                See All Results
              </Button>
            </Box>
          )}
        </CardContent>
      </Card>

      {/* Quick Results */}
      <Fade in={!!currentResults && currentResults.results.length > 0}>
        <Paper sx={{ mt: 2, maxHeight: 400, overflow: 'auto' }} elevation={1}>
          <List dense>
            {currentResults?.results.map((result, index) => {
              const terminal = terminals.find(t => t.id === result.terminalId);
              return (
                <ListItem key={result.id} divider={index < currentResults.results.length - 1}>
                  <ListItemText
                    primary={
                      <Box display="flex" alignItems="center" gap={1} mb={1}>
                        <Chip
                          label={terminal?.name || result.terminalId}
                          size="small"
                          icon={<span>{getContentTypeIcon(result.metadata.type)}</span>}
                          color="primary"
                          variant="outlined"
                        />
                        <Chip
                          label={result.metadata.type}
                          size="small"
                          color="secondary"
                        />
                        <Typography variant="caption" color="text.secondary">
                          Score: {result.score.toFixed(2)}
                        </Typography>
                      </Box>
                    }
                    secondary={
                      <Box>
                        <Typography
                          variant="body2"
                          sx={{
                            fontFamily: 'monospace',
                            whiteSpace: 'pre-wrap',
                            backgroundColor: 'grey.50',
                            p: 1,
                            borderRadius: 1,
                            mb: 1,
                            maxHeight: 100,
                            overflow: 'hidden',
                            position: 'relative',
                          }}
                          dangerouslySetInnerHTML={{
                            __html: uiState.query.highlight
                              ? searchApiService.highlightMatches(
                                  result.content.slice(0, 200) + (result.content.length > 200 ? '...' : ''),
                                  search,
                                  uiState.query.caseSensitive
                                )
                              : result.content.slice(0, 200) + (result.content.length > 200 ? '...' : ''),
                          }}
                        />
                        <Typography variant="caption" color="text.secondary">
                          {formatTimestamp(result.timestamp)}
                        </Typography>
                      </Box>
                    }
                  />
                </ListItem>
              );
            })}
          </List>
        </Paper>
      </Fade>

      {/* No Results */}
      {debouncedSearch.length >= 2 && currentResults?.results.length === 0 && !isSearching && (
        <Card sx={{ mt: 2 }}>
          <CardContent sx={{ textAlign: 'center', py: 4 }}>
            <Typography color="text.secondary" gutterBottom>
              No results found for "{debouncedSearch}"
            </Typography>
            <Typography variant="body2" color="text.secondary" mb={2}>
              Try adjusting your search terms or use advanced search for more options.
            </Typography>
            <Button
              variant="outlined"
              onClick={handleAdvancedSearch}
              startIcon={<SettingsIcon />}
            >
              Open Advanced Search
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Loading State */}
      {isSearching && (
        <Card sx={{ mt: 2 }}>
          <CardContent sx={{ textAlign: 'center', py: 4 }}>
            <CircularProgress size={32} />
            <Typography color="text.secondary" sx={{ mt: 2 }}>
              Searching...
            </Typography>
          </CardContent>
        </Card>
      )}

      {/* Help Text */}
      {!search && !currentResults && (
        <Card sx={{ mt: 2 }}>
          <CardContent>
            <Typography variant="h6" gutterBottom>
              Search Terminal Output
            </Typography>
            <Typography variant="body2" color="text.secondary" paragraph>
              Search through all terminal output, commands, and error messages. Start typing to see live results,
              or use advanced search for more filtering options.
            </Typography>
            <Box display="flex" gap={1} flexWrap="wrap">
              <Chip label="Live search" size="small" />
              <Chip label="Regular expressions" size="small" />
              <Chip label="Time range filters" size="small" />
              <Chip label="Terminal filtering" size="small" />
              <Chip label="Export results" size="small" />
            </Box>
          </CardContent>
        </Card>
      )}

      {/* Advanced Search Dialog */}
      <AdvancedSearchDialog
        open={showAdvanced}
        onClose={() => setShowAdvanced(false)}
        initialQuery={search}
      />
    </Box>
  );
};

export default SearchComponent;