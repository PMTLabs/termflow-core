import React, { useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  Button,
  Box,
  Typography,
  IconButton,
  Slider,
  Chip,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Paper,
  LinearProgress,
  Tooltip,
  Card,
  CardContent,
} from '@mui/material';
import {
  PlayArrow as PlayIcon,
  Pause as PauseIcon,
  Stop as StopIcon,
  Replay as ReplayIcon,
  SkipNext as SkipNextIcon,
  SkipPrevious as SkipPreviousIcon,
  VolumeUp as VolumeUpIcon,
  Fullscreen as FullscreenIcon,
  Close as CloseIcon,
  Download as DownloadIcon,
  Settings as SettingsIcon,
} from '@mui/icons-material';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useDispatch, useSelector } from 'react-redux';
import { AppDispatch, RootState } from '../../store/store';
import {
  setPlaybackState,
  closePlayback,
  exportRecording,
} from '../../store/slices/recordingSlice';

interface RecordingPlaybackProps {
  open: boolean;
  onClose: () => void;
}

const RecordingPlayback: React.FC<RecordingPlaybackProps> = ({ open, onClose }) => {
  const dispatch = useDispatch<AppDispatch>();
  const { currentRecording, playbackState } = useSelector((state: RootState) => state.recording);
  const { terminals } = useSelector((state: RootState) => state.terminals);
  
  const terminalRef = useRef<HTMLDivElement>(null);
  const terminalInstance = useRef<Terminal | null>(null);
  const playbackTimer = useRef<NodeJS.Timeout | null>(null);
  
  const [currentEventIndex, setCurrentEventIndex] = useState(0);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Initialize terminal
  useEffect(() => {
    if (open && terminalRef.current && currentRecording) {
      terminalInstance.current = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Consolas, "Courier New", monospace',
        theme: {
          background: '#1e1e1e',
          foreground: '#cccccc',
        },
        allowProposedApi: true,
      });

      terminalInstance.current.open(terminalRef.current);
      terminalInstance.current.focus();

      // Initialize playback state
      if (playbackState) {
        dispatch(setPlaybackState({
          ...playbackState,
          currentTime: 0,
          isPlaying: false,
          isPaused: false,
        }));
      }

      return () => {
        if (terminalInstance.current) {
          terminalInstance.current.dispose();
          terminalInstance.current = null;
        }
      };
    }
  }, [open, currentRecording, dispatch, playbackState]);

  // Playback control
  useEffect(() => {
    if (!playbackState || !currentRecording || !terminalInstance.current) return;

    if (playbackState.isPlaying && !playbackState.isPaused) {
      playbackTimer.current = setInterval(() => {
        const events = currentRecording.events;
        if (currentEventIndex >= events.length) {
          // Playback finished
          dispatch(setPlaybackState({
            ...playbackState,
            isPlaying: false,
            isPaused: false,
          }));
          return;
        }

        const currentEvent = events[currentEventIndex];
        const eventTime = new Date(currentEvent.timestamp).getTime() - new Date(currentRecording.startTime).getTime();

        if (playbackState.currentTime >= eventTime) {
          // Play this event
          if (currentEvent.type === 'output' && currentEvent.data) {
            terminalInstance.current?.write(currentEvent.data);
          }
          setCurrentEventIndex(prev => prev + 1);
        }

        // Update current time
        const duration = getRecordingDuration();
        const newTime = Math.min(
          playbackState.currentTime + (100 * playbackState.speed),
          duration
        );

        dispatch(setPlaybackState({
          ...playbackState,
          currentTime: newTime,
        }));

        if (newTime >= duration) {
          // Playback finished
          dispatch(setPlaybackState({
            ...playbackState,
            isPlaying: false,
            isPaused: false,
            currentTime: duration,
          }));
        }
      }, 100);
    } else {
      if (playbackTimer.current) {
        clearInterval(playbackTimer.current);
        playbackTimer.current = null;
      }
    }

    return () => {
      if (playbackTimer.current) {
        clearInterval(playbackTimer.current);
        playbackTimer.current = null;
      }
    };
  }, [playbackState, currentRecording, currentEventIndex, dispatch]);

  const handlePlay = () => {
    if (!playbackState) return;

    dispatch(setPlaybackState({
      ...playbackState,
      isPlaying: !playbackState.isPlaying,
      isPaused: playbackState.isPlaying,
    }));
  };

  const handleStop = () => {
    if (!playbackState) return;

    dispatch(setPlaybackState({
      ...playbackState,
      isPlaying: false,
      isPaused: false,
      currentTime: 0,
    }));
    setCurrentEventIndex(0);
    
    // Reset terminal
    if (terminalInstance.current) {
      terminalInstance.current.reset();
    }
  };

  const handleReplay = () => {
    handleStop();
    setTimeout(() => {
      if (playbackState) {
        dispatch(setPlaybackState({
          ...playbackState,
          isPlaying: true,
          isPaused: false,
        }));
      }
    }, 100);
  };

  const handleTimeSeek = (newTime: number) => {
    if (!playbackState || !currentRecording) return;

    // Reset terminal and replay up to the new time
    if (terminalInstance.current) {
      terminalInstance.current.reset();
    }

    let eventIndex = 0;
    const events = currentRecording.events;
    const startTime = new Date(currentRecording.startTime).getTime();

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      const eventTime = new Date(event.timestamp).getTime() - startTime;
      
      if (eventTime <= newTime) {
        if (event.type === 'output' && event.data && terminalInstance.current) {
          terminalInstance.current.write(event.data);
        }
        eventIndex = i + 1;
      } else {
        break;
      }
    }

    setCurrentEventIndex(eventIndex);
    dispatch(setPlaybackState({
      ...playbackState,
      currentTime: newTime,
    }));
  };

  const handleSpeedChange = (speed: number) => {
    if (!playbackState) return;

    dispatch(setPlaybackState({
      ...playbackState,
      speed,
    }));
  };

  const handleExport = (format: 'json' | 'text' | 'html' | 'asciinema') => {
    if (currentRecording) {
      dispatch(exportRecording({
        recordingId: currentRecording.id,
        format,
        includeMetadata: true,
      }));
    }
  };

  const formatTime = (ms: number) => {
    const minutes = Math.floor(ms / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const getRecordingDuration = () => {
    if (!currentRecording) return 0;
    if (currentRecording.endTime) {
      return new Date(currentRecording.endTime).getTime() - new Date(currentRecording.startTime).getTime();
    }
    // For ongoing recordings, calculate from events
    if (currentRecording.events.length > 0) {
      const lastEvent = currentRecording.events[currentRecording.events.length - 1];
      return lastEvent.timestamp;
    }
    return 0;
  };

  const getTerminalInfo = () => {
    if (!currentRecording) return null;
    return terminals.find(t => t.id === currentRecording.terminalId);
  };

  const terminalInfo = getTerminalInfo();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth={isFullscreen ? false : 'lg'}
      fullWidth
      fullScreen={isFullscreen}
      PaperProps={{
        sx: {
          height: isFullscreen ? '100vh' : '90vh',
          bgcolor: '#1e1e1e',
        },
      }}
    >
      <DialogTitle sx={{ bgcolor: '#2d2d2d', color: 'white' }}>
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Box>
            <Typography variant="h6" component="div">
              Recording Playback
            </Typography>
            {currentRecording && (
              <Box display="flex" alignItems="center" gap={1} mt={1}>
                <Chip
                  label={currentRecording.metadata?.title || 'Untitled Recording'}
                  size="small"
                  sx={{ bgcolor: 'primary.main', color: 'white' }}
                />
                {terminalInfo && (
                  <Chip
                    label={terminalInfo.name}
                    size="small"
                    sx={{ bgcolor: 'secondary.main', color: 'white' }}
                  />
                )}
                <Chip
                  label={formatTime(getRecordingDuration())}
                  size="small"
                  variant="outlined"
                  sx={{ color: 'white', borderColor: 'white' }}
                />
              </Box>
            )}
          </Box>
          <Box display="flex" gap={1}>
            <Tooltip title="Download">
              <IconButton 
                sx={{ color: 'white' }}
                onClick={() => handleExport('json')}
              >
                <DownloadIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}>
              <IconButton 
                sx={{ color: 'white' }}
                onClick={() => setIsFullscreen(!isFullscreen)}
              >
                <FullscreenIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="Close">
              <IconButton sx={{ color: 'white' }} onClick={onClose}>
                <CloseIcon />
              </IconButton>
            </Tooltip>
          </Box>
        </Box>
      </DialogTitle>

      <DialogContent sx={{ p: 0, bgcolor: '#1e1e1e', display: 'flex', flexDirection: 'column' }}>
        {/* Terminal Display */}
        <Box
          ref={terminalRef}
          sx={{
            flexGrow: 1,
            bgcolor: '#1e1e1e',
            p: 1,
            '& .xterm': {
              height: '100% !important',
            },
            '& .xterm-viewport': {
              height: '100% !important',
            },
          }}
        />

        {/* Progress Bar */}
        {playbackState && (
          <Box sx={{ px: 2, py: 1, bgcolor: '#2d2d2d' }}>
            <LinearProgress
              variant="determinate"
              value={(playbackState.currentTime / getRecordingDuration()) * 100}
              sx={{
                height: 6,
                borderRadius: 3,
                bgcolor: 'rgba(255,255,255,0.1)',
                '& .MuiLinearProgress-bar': {
                  bgcolor: 'primary.main',
                },
              }}
            />
          </Box>
        )}

        {/* Playback Controls */}
        <Card sx={{ m: 2, bgcolor: '#2d2d2d' }}>
          <CardContent sx={{ py: 2 }}>
            <Box display="flex" alignItems="center" justifyContent="space-between">
              {/* Left Controls */}
              <Box display="flex" alignItems="center" gap={1}>
                <IconButton onClick={handlePlay} sx={{ color: 'white' }}>
                  {playbackState?.isPlaying && !playbackState?.isPaused ? (
                    <PauseIcon />
                  ) : (
                    <PlayIcon />
                  )}
                </IconButton>
                <IconButton onClick={handleStop} sx={{ color: 'white' }}>
                  <StopIcon />
                </IconButton>
                <IconButton onClick={handleReplay} sx={{ color: 'white' }}>
                  <ReplayIcon />
                </IconButton>
              </Box>

              {/* Time Display and Slider */}
              <Box display="flex" alignItems="center" gap={2} flexGrow={1} mx={3}>
                <Typography variant="caption" sx={{ color: 'white', minWidth: 60 }}>
                  {playbackState ? formatTime(playbackState.currentTime) : '0:00'}
                </Typography>
                <Slider
                  value={playbackState?.currentTime || 0}
                  max={getRecordingDuration() || 100}
                  onChange={(_, value) => handleTimeSeek(value as number)}
                  sx={{
                    color: 'primary.main',
                    flexGrow: 1,
                    '& .MuiSlider-thumb': {
                      bgcolor: 'primary.main',
                    },
                    '& .MuiSlider-track': {
                      bgcolor: 'primary.main',
                    },
                    '& .MuiSlider-rail': {
                      bgcolor: 'rgba(255,255,255,0.2)',
                    },
                  }}
                />
                <Typography variant="caption" sx={{ color: 'white', minWidth: 60 }}>
                  {playbackState ? formatTime(getRecordingDuration()) : '0:00'}
                </Typography>
              </Box>

              {/* Right Controls */}
              <Box display="flex" alignItems="center" gap={2}>
                <FormControl size="small" sx={{ minWidth: 100 }}>
                  <InputLabel sx={{ color: 'white' }}>Speed</InputLabel>
                  <Select
                    value={playbackState?.speed || 1}
                    onChange={(e) => handleSpeedChange(e.target.value as number)}
                    label="Speed"
                    sx={{
                      color: 'white',
                      '& .MuiOutlinedInput-notchedOutline': {
                        borderColor: 'rgba(255,255,255,0.3)',
                      },
                      '&:hover .MuiOutlinedInput-notchedOutline': {
                        borderColor: 'rgba(255,255,255,0.5)',
                      },
                      '& .MuiSvgIcon-root': {
                        color: 'white',
                      },
                    }}
                  >
                    <MenuItem value={0.25}>0.25x</MenuItem>
                    <MenuItem value={0.5}>0.5x</MenuItem>
                    <MenuItem value={1}>1x</MenuItem>
                    <MenuItem value={1.5}>1.5x</MenuItem>
                    <MenuItem value={2}>2x</MenuItem>
                    <MenuItem value={4}>4x</MenuItem>
                  </Select>
                </FormControl>

                <Tooltip title="Export Recording">
                  <IconButton sx={{ color: 'white' }}>
                    <DownloadIcon />
                  </IconButton>
                </Tooltip>
              </Box>
            </Box>

            {/* Recording Info */}
            {currentRecording && (
              <Box mt={2} display="flex" justifyContent="space-between" alignItems="center">
                <Box display="flex" gap={2}>
                  <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                    Events: {currentRecording.events.length}
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                    Size: {(currentRecording.size / 1024).toFixed(1)} KB
                  </Typography>
                  <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                    Started: {new Date(currentRecording.startTime).toLocaleString()}
                  </Typography>
                </Box>
                <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.7)' }}>
                  Progress: {currentEventIndex} / {currentRecording.events.length} events
                </Typography>
              </Box>
            )}
          </CardContent>
        </Card>
      </DialogContent>

      {!isFullscreen && (
        <DialogActions sx={{ bgcolor: '#2d2d2d' }}>
          <Button onClick={onClose} sx={{ color: 'white' }}>
            Close
          </Button>
        </DialogActions>
      )}
    </Dialog>
  );
};

export default RecordingPlayback;