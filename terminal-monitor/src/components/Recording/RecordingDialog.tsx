import React, { useState, useEffect } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  Chip,
  IconButton,
  Tooltip,
  List,
  ListItem,
  ListItemText,
  ListItemSecondaryAction,
  Card,
  CardContent,
  CardActions,
  Grid,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Switch,
  FormControlLabel,
  Alert,
  CircularProgress,
  LinearProgress,
  Divider,
  TextField,
  Autocomplete,
} from '@mui/material';
import {
  PlayArrow as PlayIcon,
  Stop as StopIcon,
  Delete as DeleteIcon,
  Download as DownloadIcon,
  Refresh as RefreshIcon,
  VideoCall as RecordIcon,
  Schedule as ScheduleIcon,
  Storage as StorageIcon,
  Terminal as TerminalIcon,
  Close as CloseIcon,
  Pause as PauseIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../store/store';
import {
  startRecording,
  stopRecording,
  fetchRecordings,
  fetchRecording,
  deleteRecording,
  exportRecording,
  fetchRecordingStatus,
  fetchActiveRecordings,
  openPlayback,
  closePlayback,
  openRecordingDialog,
  closeRecordingDialog,
  setTerminalFilter,
  setSortBy,
  setSortOrder,
  setCurrentPage,
  setPageSize,
} from '../../store/slices/recordingSlice';
import recordingApiService from '../../services/recordingApiService';

interface RecordingDialogProps {
  open: boolean;
  onClose: () => void;
}

const RecordingDialog: React.FC<RecordingDialogProps> = ({ open, onClose }) => {
  const dispatch = useDispatch<AppDispatch>();
  const {
    recordings,
    recordingStatuses,
    activeRecordings,
    currentRecording,
    isLoading,
    error,
    totalRecordings,
    currentPage,
    pageSize,
    selectedTerminalFilter,
    sortBy,
    sortOrder,
    isRecordingDialogOpen,
    recordingTarget,
    isExporting,
    exportProgress,
    playbackState,
    isPlaybackOpen,
  } = useSelector((state: RootState) => state.recording);

  const { terminals } = useSelector((state: RootState) => state.terminals);

  const [selectedTerminal, setSelectedTerminal] = useState<string>('');
  const [recordingMetadata, setRecordingMetadata] = useState({
    title: '',
    description: '',
    tags: [] as string[],
  });

  useEffect(() => {
    if (open) {
      dispatch(fetchRecordings());
      dispatch(fetchActiveRecordings());
      // Fetch recording status for all terminals
      terminals.forEach(terminal => {
        dispatch(fetchRecordingStatus(terminal.id));
      });
    }
  }, [open, dispatch, terminals]);

  const handleStartRecording = async () => {
    if (!selectedTerminal) return;

    const request = {
      terminalId: selectedTerminal,
      metadata: {
        title: recordingMetadata.title || `Recording ${new Date().toLocaleString()}`,
        description: recordingMetadata.description,
        tags: recordingMetadata.tags,
      },
      compress: true,
    };

    await dispatch(startRecording(request));
    
    // Reset form
    setSelectedTerminal('');
    setRecordingMetadata({ title: '', description: '', tags: [] });
    
    // Refresh recordings list
    dispatch(fetchRecordings());
  };

  const handleStopRecording = async (recordingId: string) => {
    await dispatch(stopRecording(recordingId));
    dispatch(fetchRecordings());
  };

  const handleDeleteRecording = async (recordingId: string) => {
    if (window.confirm('Are you sure you want to delete this recording?')) {
      await dispatch(deleteRecording(recordingId));
    }
  };

  const handleExportRecording = async (recordingId: string, format: 'json' | 'text' | 'html' | 'asciinema') => {
    await dispatch(exportRecording({ recordingId, format, includeMetadata: true }));
  };

  const handlePlayRecording = async (recordingId: string) => {
    await dispatch(fetchRecording({ recordingId, includeEvents: true }));
    dispatch(openPlayback(recordingId));
  };

  const getRecordingStatus = (terminalId: string) => {
    return recordingStatuses[terminalId];
  };

  const isTerminalRecording = (terminalId: string) => {
    const status = getRecordingStatus(terminalId);
    return status?.isRecording || false;
  };

  const getActiveRecordingForTerminal = (terminalId: string) => {
    const status = getRecordingStatus(terminalId);
    if (status?.isRecording) {
      return activeRecordings.find(id => {
        const recording = recordings.find(r => r.id === id && r.terminalId === terminalId);
        return recording !== undefined;
      });
    }
    return null;
  };

  const formatDuration = (ms: number | null) => {
    return recordingApiService.formatDuration(ms);
  };

  const formatFileSize = (bytes: number) => {
    return recordingApiService.formatFileSize(bytes);
  };

  const formatTimestamp = (timestamp: string) => {
    return recordingApiService.formatTimestamp(timestamp);
  };

  const availableTerminals = terminals.filter(terminal => !isTerminalRecording(terminal.id));

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
            Terminal Recording Manager
          </Typography>
          <Box display="flex" alignItems="center" gap={1}>
            <Chip
              label={`${activeRecordings.length} Active`}
              color={activeRecordings.length > 0 ? 'error' : 'default'}
              icon={<RecordIcon />}
              size="small"
            />
            <Chip
              label={`${totalRecordings} Total`}
              icon={<StorageIcon />}
              size="small"
            />
            <IconButton onClick={() => dispatch(fetchRecordings())}>
              <RefreshIcon />
            </IconButton>
          </Box>
        </Box>
      </DialogTitle>

      <DialogContent dividers>
        <Box display="flex" flexDirection="column" gap={3}>
          {/* New Recording Section */}
          <Card variant="outlined">
            <CardContent>
              <Typography variant="h6" gutterBottom>
                Start New Recording
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} md={6}>
                  <Autocomplete
                    options={availableTerminals}
                    getOptionLabel={(terminal) => `${terminal.name} (${terminal.id})`}
                    value={availableTerminals.find(t => t.id === selectedTerminal) || null}
                    onChange={(_, terminal) => setSelectedTerminal(terminal?.id || '')}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        label="Select Terminal"
                        placeholder="Choose terminal to record"
                        disabled={availableTerminals.length === 0}
                      />
                    )}
                    renderOption={(props, terminal) => (
                      <Box {...props} component="li">
                        <TerminalIcon sx={{ mr: 1 }} />
                        <Box>
                          <Typography variant="body2">{terminal.name}</Typography>
                          <Typography variant="caption" color="text.secondary">
                            {terminal.profile} - {terminal.status}
                          </Typography>
                        </Box>
                      </Box>
                    )}
                  />
                </Grid>
                <Grid item xs={12} md={6}>
                  <TextField
                    fullWidth
                    label="Recording Title"
                    value={recordingMetadata.title}
                    onChange={(e) => setRecordingMetadata(prev => ({ ...prev, title: e.target.value }))}
                    placeholder="Optional recording title"
                  />
                </Grid>
                <Grid item xs={12}>
                  <TextField
                    fullWidth
                    multiline
                    rows={2}
                    label="Description"
                    value={recordingMetadata.description}
                    onChange={(e) => setRecordingMetadata(prev => ({ ...prev, description: e.target.value }))}
                    placeholder="Optional description for this recording"
                  />
                </Grid>
              </Grid>
            </CardContent>
            <CardActions>
              <Button
                variant="contained"
                startIcon={<RecordIcon />}
                onClick={handleStartRecording}
                disabled={!selectedTerminal || isLoading}
              >
                Start Recording
              </Button>
              {availableTerminals.length === 0 && (
                <Alert severity="info" sx={{ ml: 2 }}>
                  All terminals are currently being recorded
                </Alert>
              )}
            </CardActions>
          </Card>

          {/* Active Recordings Section */}
          {activeRecordings.length > 0 && (
            <Card variant="outlined">
              <CardContent>
                <Typography variant="h6" gutterBottom color="error">
                  Active Recordings
                </Typography>
                <List>
                  {terminals
                    .filter(terminal => isTerminalRecording(terminal.id))
                    .map(terminal => {
                      const activeRecordingId = getActiveRecordingForTerminal(terminal.id);
                      const recording = recordings.find(r => r.id === activeRecordingId);
                      return (
                        <ListItem key={terminal.id} divider>
                          <ListItemText
                            primary={
                              <Box display="flex" alignItems="center" gap={1}>
                                <Chip
                                  label="RECORDING"
                                  color="error"
                                  size="small"
                                  icon={<RecordIcon />}
                                />
                                <Typography variant="subtitle1">
                                  {terminal.name}
                                </Typography>
                              </Box>
                            }
                            secondary={
                              <Box>
                                <Typography variant="body2" color="text.secondary">
                                  Terminal ID: {terminal.id}
                                </Typography>
                                {recording && (
                                  <Typography variant="caption" color="text.secondary">
                                    Started: {formatTimestamp(recording.startTime.toString())}
                                  </Typography>
                                )}
                              </Box>
                            }
                          />
                          <ListItemSecondaryAction>
                            <Tooltip title="Stop Recording">
                              <IconButton
                                edge="end"
                                color="error"
                                onClick={() => activeRecordingId && handleStopRecording(activeRecordingId)}
                                disabled={isLoading}
                              >
                                <StopIcon />
                              </IconButton>
                            </Tooltip>
                          </ListItemSecondaryAction>
                        </ListItem>
                      );
                    })}
                </List>
              </CardContent>
            </Card>
          )}

          {/* Export Progress */}
          {isExporting && (
            <Card variant="outlined">
              <CardContent>
                <Box display="flex" alignItems="center" gap={2}>
                  <CircularProgress size={24} />
                  <Box flexGrow={1}>
                    <Typography variant="subtitle2">Exporting Recording...</Typography>
                    <LinearProgress variant="determinate" value={exportProgress} />
                  </Box>
                  <Typography variant="caption">{exportProgress}%</Typography>
                </Box>
              </CardContent>
            </Card>
          )}

          {/* Recordings List */}
          <Card variant="outlined">
            <CardContent>
              <Box display="flex" justifyContent="space-between" alignItems="center" mb={2}>
                <Typography variant="h6">
                  Recorded Sessions ({totalRecordings})
                </Typography>
                <Box display="flex" gap={1}>
                  <FormControl size="small" sx={{ minWidth: 120 }}>
                    <InputLabel>Sort By</InputLabel>
                    <Select
                      value={sortBy}
                      onChange={(e) => dispatch(setSortBy(e.target.value as any))}
                      label="Sort By"
                    >
                      <MenuItem value="date">Date</MenuItem>
                      <MenuItem value="duration">Duration</MenuItem>
                      <MenuItem value="size">Size</MenuItem>
                    </Select>
                  </FormControl>
                  <FormControl size="small" sx={{ minWidth: 100 }}>
                    <InputLabel>Order</InputLabel>
                    <Select
                      value={sortOrder}
                      onChange={(e) => dispatch(setSortOrder(e.target.value as any))}
                      label="Order"
                    >
                      <MenuItem value="desc">Newest</MenuItem>
                      <MenuItem value="asc">Oldest</MenuItem>
                    </Select>
                  </FormControl>
                </Box>
              </Box>

              {error && (
                <Alert severity="error" sx={{ mb: 2 }}>
                  {error}
                </Alert>
              )}

              {isLoading ? (
                <Box display="flex" justifyContent="center" p={3}>
                  <CircularProgress />
                </Box>
              ) : (
                <List sx={{ maxHeight: 400, overflow: 'auto' }}>
                  {recordings.map((recording, index) => {
                    const terminal = terminals.find(t => t.id === recording.terminalId);
                    return (
                      <React.Fragment key={recording.id}>
                        <ListItem>
                          <ListItemText
                            primary={
                              <Box display="flex" alignItems="center" gap={1} mb={1}>
                                <Typography variant="subtitle1">
                                  {recording.metadata?.title || `Recording ${index + 1}`}
                                </Typography>
                                <Chip
                                  label={terminal?.name || recording.terminalId}
                                  size="small"
                                  icon={<TerminalIcon />}
                                />
                                {recording.compressed && (
                                  <Chip
                                    label="Compressed"
                                    size="small"
                                    color="secondary"
                                  />
                                )}
                              </Box>
                            }
                            secondary={
                              <Box>
                                <Grid container spacing={2}>
                                  <Grid item xs={6} md={3}>
                                    <Typography variant="caption" color="text.secondary">
                                      Duration: {formatDuration(recording.duration)}
                                    </Typography>
                                  </Grid>
                                  <Grid item xs={6} md={3}>
                                    <Typography variant="caption" color="text.secondary">
                                      Size: {formatFileSize(recording.size)}
                                    </Typography>
                                  </Grid>
                                  <Grid item xs={6} md={3}>
                                    <Typography variant="caption" color="text.secondary">
                                      Events: {recording.eventCount}
                                    </Typography>
                                  </Grid>
                                  <Grid item xs={6} md={3}>
                                    <Typography variant="caption" color="text.secondary">
                                      {formatTimestamp(recording.startTime.toString())}
                                    </Typography>
                                  </Grid>
                                </Grid>
                                {recording.metadata?.description && (
                                  <Typography variant="body2" sx={{ mt: 1 }}>
                                    {recording.metadata.description}
                                  </Typography>
                                )}
                              </Box>
                            }
                          />
                          <ListItemSecondaryAction>
                            <Box display="flex" gap={1}>
                              <Tooltip title="Play Recording">
                                <IconButton
                                  onClick={() => handlePlayRecording(recording.id)}
                                  color="primary"
                                >
                                  <PlayIcon />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="Export as JSON">
                                <IconButton
                                  onClick={() => handleExportRecording(recording.id, 'json')}
                                  disabled={isExporting}
                                >
                                  <DownloadIcon />
                                </IconButton>
                              </Tooltip>
                              <Tooltip title="Delete Recording">
                                <IconButton
                                  onClick={() => handleDeleteRecording(recording.id)}
                                  color="error"
                                  disabled={isLoading}
                                >
                                  <DeleteIcon />
                                </IconButton>
                              </Tooltip>
                            </Box>
                          </ListItemSecondaryAction>
                        </ListItem>
                        {index < recordings.length - 1 && <Divider />}
                      </React.Fragment>
                    );
                  })}
                  {recordings.length === 0 && !isLoading && (
                    <Box textAlign="center" py={4}>
                      <Typography color="text.secondary">
                        No recordings found. Start recording a terminal session to see it here.
                      </Typography>
                    </Box>
                  )}
                </List>
              )}
            </CardContent>
          </Card>
        </Box>
      </DialogContent>

      <DialogActions>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
};

export default RecordingDialog;