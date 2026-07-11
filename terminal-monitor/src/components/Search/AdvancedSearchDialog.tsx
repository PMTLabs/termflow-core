import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  Button,
  Box,
  Typography,
  Chip,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Switch,
  FormControlLabel,
  Autocomplete,
  Paper,
  List,
  ListItem,
  ListItemText,
  ListItemButton,
  Divider,
  Alert,
  CircularProgress,
  IconButton,
  Tooltip,
  Grid,
  Card,
  CardContent,
  InputAdornment,
  Collapse,
} from '@mui/material';
import {
  Search as SearchIcon,
  Clear as ClearIcon,
  FilterList as FilterIcon,
  History as HistoryIcon,
  Download as DownloadIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  Schedule as ScheduleIcon,
  Terminal as TerminalIcon,
  TextFields as TextFieldsIcon,
} from '@mui/icons-material';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../store/store';
import {
  performSearch,
  performAdvancedSearch,
  fetchSearchSuggestions,
  exportSearchResults,
  closeSearch,
  setSearchQuery,
  setSelectedTerminals,
  setContentType,
  setTimeRangeType,
  setCustomDateRange,
  clearFilters,
  setSortBy,
  setSortOrder,
  setViewMode,
  setCurrentPage,
  hideSuggestions,
  showSuggestions,
} from '../../store/slices/searchSlice';
import searchApiService from '../../services/searchApiService';

interface AdvancedSearchDialogProps {
  open: boolean;
  onClose: () => void;
  initialQuery?: string;
}

const AdvancedSearchDialog: React.FC<AdvancedSearchDialogProps> = ({
  open,
  onClose,
  initialQuery = '',
}) => {
  const dispatch = useDispatch<AppDispatch>();
  const {
    uiState,
    filtersState,
    resultsState,
    isSearching,
    error,
    suggestions,
    showSuggestions: showSuggestionsFlag,
    recentSearches,
  } = useSelector((state: RootState) => state.search);

  const { terminals } = useSelector((state: RootState) => state.terminals);

  const [showFilters, setShowFilters] = useState(false);
  const [showRecentSearches, setShowRecentSearches] = useState(false);
  const [localQuery, setLocalQuery] = useState(initialQuery);

  useEffect(() => {
    if (open && initialQuery) {
      setLocalQuery(initialQuery);
      dispatch(setSearchQuery({ text: initialQuery }));
    }
  }, [open, initialQuery, dispatch]);

  const handleQueryChange = (value: string) => {
    setLocalQuery(value);
    dispatch(setSearchQuery({ text: value }));
    
    // Fetch suggestions if query is long enough
    if (value.length >= 2) {
      dispatch(fetchSearchSuggestions({ query: value, limit: 10 }));
      dispatch(showSuggestions());
    } else {
      dispatch(hideSuggestions());
    }
  };

  const handleSearch = () => {
    if (!localQuery.trim()) return;

    const searchRequest = searchApiService.buildSearchRequest(localQuery, {
      terminals: filtersState.selectedTerminals,
      contentType: filtersState.contentType,
      timeRangeType: filtersState.timeRangeType,
      customStartDate: filtersState.customStartDate,
      customEndDate: filtersState.customEndDate,
      caseSensitive: uiState.query.caseSensitive,
      regex: uiState.query.regex,
      wholeWord: uiState.query.wholeWord,
      page: 1,
      pageSize: uiState.pageSize,
    });

    dispatch(performSearch(searchRequest));
    dispatch(hideSuggestions());
  };

  const handleAdvancedSearch = () => {
    if (!localQuery.trim()) return;

    const advancedRequest = searchApiService.buildAdvancedSearchRequest(
      uiState.query,
      1,
      uiState.pageSize
    );

    dispatch(performAdvancedSearch(advancedRequest));
    dispatch(hideSuggestions());
  };

  const handleExport = (format: 'json' | 'csv' | 'txt') => {
    if (uiState.results) {
      dispatch(exportSearchResults({
        searchResponse: uiState.results,
        format,
      }));
    }
  };

  const handleSuggestionClick = (suggestion: string) => {
    setLocalQuery(suggestion);
    dispatch(setSearchQuery({ text: suggestion }));
    dispatch(hideSuggestions());
    handleSearch();
  };

  const handleRecentSearchClick = (query: string) => {
    setLocalQuery(query);
    dispatch(setSearchQuery({ text: query }));
    setShowRecentSearches(false);
    handleSearch();
  };

  const formatExecutionTime = (ms: number) => {
    return searchApiService.formatExecutionTime(ms);
  };

  return (
    <Dialog 
      open={open} 
      onClose={onClose} 
      maxWidth="lg" 
      fullWidth
      PaperProps={{ sx: { height: '90vh' } }}
    >
      <DialogTitle>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Typography variant="h6" component="div">
            Advanced Search
          </Typography>
          <Box display="flex" gap={1}>
            <Tooltip title="Toggle filters">
              <IconButton onClick={() => setShowFilters(!showFilters)}>
                <FilterIcon color={showFilters ? 'primary' : 'inherit'} />
              </IconButton>
            </Tooltip>
            <Tooltip title="Recent searches">
              <IconButton onClick={() => setShowRecentSearches(!showRecentSearches)}>
                <HistoryIcon color={showRecentSearches ? 'primary' : 'inherit'} />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </DialogTitle>

      <DialogContent dividers>
        <Box display="flex" flexDirection="column" gap={2}>
          {/* Search Input */}
          <Box position="relative">
            <TextField
              fullWidth
              label="Search Query"
              placeholder="Enter search terms, regex patterns, or use advanced syntax..."
              value={localQuery}
              onChange={(e) => handleQueryChange(e.target.value)}
              onKeyPress={(e) => e.key === 'Enter' && handleSearch()}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon />
                  </InputAdornment>
                ),
                endAdornment: localQuery && (
                  <InputAdornment position="end">
                    <IconButton onClick={() => handleQueryChange('')} size="small">
                      <ClearIcon />
                    </IconButton>
                  </InputAdornment>
                ),
              }}
              error={!!error}
              helperText={error}
            />

            {/* Search Suggestions */}
            {showSuggestionsFlag && suggestions.length > 0 && (
              <Paper
                sx={{
                  position: 'absolute',
                  top: '100%',
                  left: 0,
                  right: 0,
                  zIndex: 1000,
                  maxHeight: 200,
                  overflow: 'auto',
                }}
              >
                <List dense>
                  {suggestions.map((suggestion, index) => (
                    <ListItemButton
                      key={index}
                      onClick={() => handleSuggestionClick(suggestion)}
                    >
                      <ListItemText primary={suggestion} />
                    </ListItemButton>
                  ))}
                </List>
              </Paper>
            )}
          </Box>

          {/* Recent Searches */}
          <Collapse in={showRecentSearches}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="subtitle2" gutterBottom>
                  Recent Searches
                </Typography>
                <Box display="flex" flexWrap="wrap" gap={1}>
                  {recentSearches.map((query, index) => (
                    <Chip
                      key={index}
                      label={query}
                      size="small"
                      onClick={() => handleRecentSearchClick(query)}
                      clickable
                    />
                  ))}
                  {recentSearches.length === 0 && (
                    <Typography variant="body2" color="text.secondary">
                      No recent searches
                    </Typography>
                  )}
                </Box>
              </CardContent>
            </Card>
          </Collapse>

          {/* Search Options */}
          <Box display="flex" flexWrap="wrap" gap={2}>
            <FormControlLabel
              control={
                <Switch
                  checked={uiState.query.caseSensitive}
                  onChange={(e) =>
                    dispatch(setSearchQuery({ caseSensitive: e.target.checked }))
                  }
                />
              }
              label="Case Sensitive"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={uiState.query.regex}
                  onChange={(e) =>
                    dispatch(setSearchQuery({ regex: e.target.checked }))
                  }
                />
              }
              label="Regular Expression"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={uiState.query.wholeWord}
                  onChange={(e) =>
                    dispatch(setSearchQuery({ wholeWord: e.target.checked }))
                  }
                />
              }
              label="Whole Word"
            />
            <FormControlLabel
              control={
                <Switch
                  checked={uiState.query.highlight}
                  onChange={(e) =>
                    dispatch(setSearchQuery({ highlight: e.target.checked }))
                  }
                />
              }
              label="Highlight Matches"
            />
          </Box>

          {/* Advanced Filters */}
          <Collapse in={showFilters}>
            <Card variant="outlined">
              <CardContent>
                <Typography variant="subtitle2" gutterBottom>
                  Search Filters
                </Typography>
                <Grid container spacing={2}>
                  <Grid item xs={12} md={6}>
                    <Autocomplete
                      multiple
                      options={terminals.map(t => t.id)}
                      getOptionLabel={(terminalId) => {
                        const terminal = terminals.find(t => t.id === terminalId);
                        return terminal ? `${terminal.name} (${terminal.id})` : terminalId;
                      }}
                      value={filtersState.selectedTerminals}
                      onChange={(_, value) => dispatch(setSelectedTerminals(value))}
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          label="Select Terminals"
                          placeholder="All terminals"
                        />
                      )}
                      renderTags={(value, getTagProps) =>
                        value.map((option, index) => {
                          const terminal = terminals.find(t => t.id === option);
                          return (
                            <Chip
                              {...getTagProps({ index })}
                              key={option}
                              label={terminal?.name || option}
                              size="small"
                              icon={<TerminalIcon />}
                            />
                          );
                        })
                      }
                    />
                  </Grid>

                  <Grid item xs={12} md={6}>
                    <FormControl fullWidth>
                      <InputLabel>Content Type</InputLabel>
                      <Select
                        value={filtersState.contentType}
                        onChange={(e) => dispatch(setContentType(e.target.value))}
                        label="Content Type"
                      >
                        <MenuItem value="all">All Content</MenuItem>
                        <MenuItem value="output">Output Only</MenuItem>
                        <MenuItem value="input">Input Only</MenuItem>
                        <MenuItem value="command">Commands Only</MenuItem>
                        <MenuItem value="error">Errors Only</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>

                  <Grid item xs={12} md={6}>
                    <FormControl fullWidth>
                      <InputLabel>Time Range</InputLabel>
                      <Select
                        value={filtersState.timeRangeType}
                        onChange={(e) => dispatch(setTimeRangeType(e.target.value as any))}
                        label="Time Range"
                      >
                        <MenuItem value="all">All Time</MenuItem>
                        <MenuItem value="last_hour">Last Hour</MenuItem>
                        <MenuItem value="last_day">Last Day</MenuItem>
                        <MenuItem value="last_week">Last Week</MenuItem>
                        <MenuItem value="custom">Custom Range</MenuItem>
                      </Select>
                    </FormControl>
                  </Grid>

                  {filtersState.timeRangeType === 'custom' && (
                    <>
                      <Grid item xs={6} md={3}>
                        <TextField
                          fullWidth
                          type="datetime-local"
                          label="Start Date"
                          value={filtersState.customStartDate}
                          onChange={(e) =>
                            dispatch(setCustomDateRange({
                              start: e.target.value,
                              end: filtersState.customEndDate,
                            }))
                          }
                          InputLabelProps={{ shrink: true }}
                        />
                      </Grid>
                      <Grid item xs={6} md={3}>
                        <TextField
                          fullWidth
                          type="datetime-local"
                          label="End Date"
                          value={filtersState.customEndDate}
                          onChange={(e) =>
                            dispatch(setCustomDateRange({
                              start: filtersState.customStartDate,
                              end: e.target.value,
                            }))
                          }
                          InputLabelProps={{ shrink: true }}
                        />
                      </Grid>
                    </>
                  )}
                </Grid>

                <Box mt={2} display="flex" justifyContent="space-between">
                  <Button
                    onClick={() => dispatch(clearFilters())}
                    color="secondary"
                  >
                    Clear Filters
                  </Button>
                </Box>
              </CardContent>
            </Card>
          </Collapse>

          {/* Search Results */}
          {uiState.results && (
            <Card variant="outlined">
              <CardContent>
                <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                  <Typography variant="subtitle1">
                    {uiState.results.total} results found in {formatExecutionTime(uiState.results.executionTime)}
                  </Typography>
                  <Box display="flex" gap={1}>
                    <Button
                      size="small"
                      onClick={() => handleExport('json')}
                      startIcon={<DownloadIcon />}
                    >
                      JSON
                    </Button>
                    <Button
                      size="small"
                      onClick={() => handleExport('csv')}
                      startIcon={<DownloadIcon />}
                    >
                      CSV
                    </Button>
                    <Button
                      size="small"
                      onClick={() => handleExport('txt')}
                      startIcon={<DownloadIcon />}
                    >
                      TXT
                    </Button>
                  </Box>
                </Box>

                <List dense sx={{ maxHeight: 400, overflow: 'auto' }}>
                  {uiState.results.results.map((result, index) => {
                    const terminal = terminals.find(t => t.id === result.terminalId);
                    return (
                      <React.Fragment key={result.id}>
                        <ListItem>
                          <ListItemText
                            primary={
                              <Box display="flex" alignItems="center" gap={1}>
                                <Chip
                                  label={terminal?.name || result.terminalId}
                                  size="small"
                                  icon={<TerminalIcon />}
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
                              <Box mt={1}>
                                <Typography
                                  variant="body2"
                                  sx={{
                                    fontFamily: 'monospace',
                                    whiteSpace: 'pre-wrap',
                                    backgroundColor: 'grey.50',
                                    p: 1,
                                    borderRadius: 1,
                                  }}
                                  dangerouslySetInnerHTML={{
                                    __html: uiState.query.highlight
                                      ? searchApiService.highlightMatches(
                                          result.content,
                                          localQuery,
                                          uiState.query.caseSensitive
                                        )
                                      : result.content,
                                  }}
                                />
                                <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
                                  {searchApiService.formatTimestamp(result.timestamp)}
                                </Typography>
                              </Box>
                            }
                          />
                        </ListItem>
                        {index < (uiState.results?.results.length || 0) - 1 && <Divider />}
                      </React.Fragment>
                    );
                  })}
                </List>
              </CardContent>
            </Card>
          )}

          {isSearching && (
            <Box display="flex" justifyContent="center" p={2}>
              <CircularProgress />
            </Box>
          )}
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button
          onClick={handleSearch}
          variant="contained"
          disabled={!localQuery.trim() || isSearching}
          startIcon={isSearching ? <CircularProgress size={20} /> : <SearchIcon />}
        >
          {isSearching ? 'Searching...' : 'Search'}
        </Button>
        <Button
          onClick={handleAdvancedSearch}
          variant="outlined"
          disabled={!localQuery.trim() || isSearching}
        >
          Advanced Search
        </Button>
      </DialogActions>
    </Dialog>
  );
};

export default AdvancedSearchDialog;