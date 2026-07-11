import React, { useState, useEffect, useCallback } from 'react';
import {
  AppBar,
  Toolbar,
  Typography,
  Button,
  IconButton,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogActions,
  TextField,
  FormControl,
  InputLabel,
  Select,
  MenuItem,
  Box,
  Chip,
  Tooltip,
  CircularProgress,
} from '@mui/material';
import axiosInstance from '../../services/axiosConfig';
import {
  Add as AddIcon,
  Refresh as RefreshIcon,
  Circle as CircleIcon,
  Logout as LogoutIcon,
  Security as SecurityIcon,
  WifiOff as WifiOffIcon,
  Sync as SyncIcon,
  GridView as GridViewIcon,
  Search as SearchIcon,
  VideoCall as RecordIcon,
  PlayArrow as PlayIcon,
} from '@mui/icons-material';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { AppDispatch, RootState } from '../../store/store';
import {
  createTerminal,
  fetchTerminals,
} from '../../store/slices/terminalsSlice';
import { logout } from '../../store/slices/authSlice';
import { setGridViewActive } from '../../store/slices/gridSlice';
import { openSearch } from '../../store/slices/searchSlice';
import { closePlayback } from '../../store/slices/recordingSlice';
import authService from '../../services/authService';
import WebSocketService from '../../services/WebSocketService';
import AdvancedSearchDialog from '../Search/AdvancedSearchDialog';
import RecordingDialog from '../Recording/RecordingDialog';
import RecordingPlayback from '../Recording/RecordingPlayback';

interface ShellProfile {
  id: string;
  name: string;
  path: string;
  args: string[];
  is_default: boolean;
  is_custom: boolean;
}

const Header: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const navigate = useNavigate();
  const [openDialog, setOpenDialog] = useState(false);
  const [terminalName, setTerminalName] = useState('');
  const [shellProfile, setShellProfile] = useState('');
  const [profiles, setProfiles] = useState<ShellProfile[]>([]);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [tokenExpiry, setTokenExpiry] = useState<string | null>(null);
  const [searchDialogOpen, setSearchDialogOpen] = useState(false);
  const [recordingDialogOpen, setRecordingDialogOpen] = useState(false);

  const { wsConnected, apiConnected, reconnectAttempts, lastError } =
    useSelector((state: RootState) => state.connection);
  const terminalsCount = useSelector(
    (state: RootState) => state.terminals.terminals.length
  );
  const { isAuthenticated } = useSelector((state: RootState) => state.auth);
  const isGridViewActive = useSelector(
    (state: RootState) => state.grid.isGridViewActive
  );
  const { activeRecordings, isPlaybackOpen } = useSelector(
    (state: RootState) => state.recording
  );

  // Fetch available shell profiles from API
  const fetchProfiles = useCallback(async () => {
    setProfilesLoading(true);
    try {
      const response = await axiosInstance.get<{ profiles: ShellProfile[] }>('/api/profiles');
      const fetchedProfiles = response.data.profiles;
      setProfiles(fetchedProfiles);

      // Pre-select the default profile
      const defaultProfile = fetchedProfiles.find(p => p.is_default);
      if (defaultProfile) {
        setShellProfile(defaultProfile.id);
      } else if (fetchedProfiles.length > 0) {
        // Fallback to first profile if no default
        setShellProfile(fetchedProfiles[0].id);
      }
    } catch (error) {
      console.error('Failed to fetch profiles:', error);
      // Fallback to hardcoded profiles on error
      setProfiles([
        { id: 'cmd', name: 'Command Prompt', path: 'cmd.exe', args: [], is_default: false, is_custom: false },
        { id: 'powershell', name: 'PowerShell', path: 'powershell.exe', args: [], is_default: false, is_custom: false },
        { id: 'git-bash', name: 'Git Bash', path: 'bash.exe', args: [], is_default: false, is_custom: false },
      ]);
      setShellProfile('cmd');
    } finally {
      setProfilesLoading(false);
    }
  }, []);

  // Fetch profiles when dialog opens
  useEffect(() => {
    if (openDialog) {
      fetchProfiles();
    }
  }, [openDialog, fetchProfiles]);

  const handleCreateTerminal = async () => {
    await dispatch(
      createTerminal({
        name: terminalName || `Terminal ${Date.now()}`,
        profile: shellProfile,
      })
    );
    setOpenDialog(false);
    setTerminalName('');
    // Don't reset shellProfile - keep the last selected for convenience
  };

  const handleRefresh = () => {
    dispatch(fetchTerminals());
  };

  const handleLogout = () => {
    dispatch(logout());
    navigate('/login');
  };

  // Update token expiry display
  useEffect(() => {
    if (!isAuthenticated) {
      setTokenExpiry(null);
      return;
    }

    const updateTokenExpiry = () => {
      const timeUntilExpiry = authService.getTimeUntilExpiration();
      if (timeUntilExpiry === null) {
        setTokenExpiry(null);
        return;
      }

      const minutes = Math.floor(timeUntilExpiry / 60000);
      const seconds = Math.floor((timeUntilExpiry % 60000) / 1000);

      if (minutes > 60) {
        const hours = Math.floor(minutes / 60);
        setTokenExpiry(`${hours}h ${minutes % 60}m`);
      } else if (minutes > 0) {
        setTokenExpiry(`${minutes}m ${seconds}s`);
      } else {
        setTokenExpiry(`${seconds}s`);
      }
    };

    // Update immediately
    updateTokenExpiry();

    // Update every second
    const interval = setInterval(updateTokenExpiry, 1000);

    return () => clearInterval(interval);
  }, [isAuthenticated]);

  return (
    <>
      <AppBar position="static">
        <Toolbar>
          <Typography variant="h6" component="div" sx={{ flexGrow: 1 }}>
            Terminal Monitor
          </Typography>

          <Box display="flex" alignItems="center" gap={2} mr={2}>
            {isAuthenticated && (
              <>
                <Tooltip title="Authenticated">
                  <Chip
                    icon={<SecurityIcon sx={{ fontSize: 16 }} />}
                    label="Authenticated"
                    size="small"
                    color="success"
                    variant="outlined"
                  />
                </Tooltip>
                {tokenExpiry && (
                  <Tooltip title="Token expires in">
                    <Chip
                      label={`Expires: ${tokenExpiry}`}
                      size="small"
                      color={
                        tokenExpiry.includes('s') && !tokenExpiry.includes('m')
                          ? 'warning'
                          : 'default'
                      }
                      variant="outlined"
                    />
                  </Tooltip>
                )}
              </>
            )}
            <Tooltip
              title={`API: ${apiConnected ? 'Connected' : 'Disconnected'}`}
            >
              <Chip
                icon={<CircleIcon sx={{ fontSize: 12 }} />}
                label="API"
                size="small"
                color={apiConnected ? 'success' : 'error'}
                variant={apiConnected ? 'filled' : 'outlined'}
              />
            </Tooltip>
            <Tooltip
              title={
                <Box>
                  <Typography variant="body2">
                    WebSocket:{' '}
                    {wsConnected ? 'Connected' : lastError || 'Disconnected'}
                  </Typography>
                  {reconnectAttempts > 0 && !wsConnected && (
                    <Typography variant="caption">
                      Reconnect attempt: {reconnectAttempts}/10
                    </Typography>
                  )}
                  {!wsConnected && (
                    <Typography
                      variant="caption"
                      sx={{ display: 'block', mt: 1 }}
                    >
                      Click to retry connection
                    </Typography>
                  )}
                </Box>
              }
            >
              <Chip
                icon={
                  wsConnected ? (
                    <CircleIcon sx={{ fontSize: 12 }} />
                  ) : reconnectAttempts > 0 ? (
                    <SyncIcon
                      sx={{
                        fontSize: 12,
                        animation: 'spin 2s linear infinite',
                      }}
                    />
                  ) : (
                    <WifiOffIcon sx={{ fontSize: 12 }} />
                  )
                }
                label={wsConnected ? 'WS' : `WS (${reconnectAttempts})`}
                size="small"
                color={wsConnected ? 'success' : 'error'}
                variant={wsConnected ? 'filled' : 'outlined'}
                onClick={
                  !wsConnected
                    ? () => WebSocketService.forceReconnect()
                    : undefined
                }
                sx={{
                  cursor: !wsConnected ? 'pointer' : 'default',
                  '& .MuiChip-icon': {
                    '@keyframes spin': {
                      '0%': { transform: 'rotate(0deg)' },
                      '100%': { transform: 'rotate(360deg)' },
                    },
                  },
                }}
              />
            </Tooltip>
            <Chip
              label={`${terminalsCount} Terminal${terminalsCount !== 1 ? 's' : ''}`}
              size="small"
              variant="outlined"
            />
          </Box>

          <Tooltip title="Refresh terminals">
            <IconButton color="inherit" onClick={handleRefresh}>
              <RefreshIcon />
            </IconButton>
          </Tooltip>

          {terminalsCount > 1 && (
            <Tooltip title="Toggle grid view">
              <IconButton
                color="inherit"
                onClick={() => dispatch(setGridViewActive(!isGridViewActive))}
                sx={{
                  backgroundColor: isGridViewActive
                    ? 'action.selected'
                    : 'transparent',
                }}
              >
                <GridViewIcon />
              </IconButton>
            </Tooltip>
          )}

          <Tooltip title="Search Terminal Output">
            <IconButton 
              color="inherit" 
              onClick={() => setSearchDialogOpen(true)}
            >
              <SearchIcon />
            </IconButton>
          </Tooltip>

          <Tooltip title="Recording Manager">
            <IconButton 
              color="inherit" 
              onClick={() => setRecordingDialogOpen(true)}
              sx={{
                position: 'relative',
              }}
            >
              <RecordIcon />
              {activeRecordings.length > 0 && (
                <Box
                  sx={{
                    position: 'absolute',
                    top: -4,
                    right: -4,
                    width: 16,
                    height: 16,
                    borderRadius: '50%',
                    bgcolor: 'error.main',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 10,
                    fontWeight: 'bold',
                    color: 'white',
                  }}
                >
                  {activeRecordings.length}
                </Box>
              )}
            </IconButton>
          </Tooltip>

          <Button
            color="inherit"
            startIcon={<AddIcon />}
            onClick={() => setOpenDialog(true)}
          >
            New Terminal
          </Button>

          {isAuthenticated && (
            <Tooltip title="Logout">
              <IconButton color="inherit" onClick={handleLogout}>
                <LogoutIcon />
              </IconButton>
            </Tooltip>
          )}
        </Toolbar>
      </AppBar>

      <Dialog
        open={openDialog}
        onClose={() => setOpenDialog(false)}
        maxWidth="sm"
        fullWidth
      >
        <DialogTitle>Create New Terminal</DialogTitle>
        <DialogContent>
          <Box display="flex" flexDirection="column" gap={2} pt={1}>
            <TextField
              label="Terminal Name"
              value={terminalName}
              onChange={(e) => setTerminalName(e.target.value)}
              placeholder="Terminal 1"
              fullWidth
              autoFocus
            />
            <FormControl fullWidth>
              <InputLabel>Shell Profile</InputLabel>
              <Select
                value={shellProfile}
                onChange={(e) => setShellProfile(e.target.value)}
                label="Shell Profile"
                disabled={profilesLoading}
              >
                {profilesLoading ? (
                  <MenuItem value="" disabled>
                    <Box display="flex" alignItems="center" gap={1}>
                      <CircularProgress size={16} />
                      Loading profiles...
                    </Box>
                  </MenuItem>
                ) : profiles.length === 0 ? (
                  <MenuItem value="" disabled>No profiles available</MenuItem>
                ) : (
                  profiles.map((profile) => (
                    <MenuItem key={profile.id} value={profile.id}>
                      {profile.name}
                      {profile.is_default && (
                        <Chip
                          label="Default"
                          size="small"
                          color="primary"
                          sx={{ ml: 1, height: 20 }}
                        />
                      )}
                    </MenuItem>
                  ))
                )}
              </Select>
            </FormControl>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpenDialog(false)}>Cancel</Button>
          <Button onClick={handleCreateTerminal} variant="contained">
            Create
          </Button>
        </DialogActions>
      </Dialog>

      {/* Search Dialog */}
      <AdvancedSearchDialog
        open={searchDialogOpen}
        onClose={() => setSearchDialogOpen(false)}
      />

      {/* Recording Dialog */}
      <RecordingDialog
        open={recordingDialogOpen}
        onClose={() => setRecordingDialogOpen(false)}
      />

      {/* Recording Playback Dialog */}
      <RecordingPlayback
        open={isPlaybackOpen}
        onClose={() => dispatch(closePlayback())}
      />
    </>
  );
};

export default Header;
