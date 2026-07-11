import React from 'react';
import { Box, Tooltip, Typography, CircularProgress } from '@mui/material';
import { Circle as CircleIcon } from '@mui/icons-material';
import { useSelector } from 'react-redux';
import { RootState } from '../store/store';

const ConnectionStatus: React.FC = () => {
  const { wsConnected, reconnectAttempts } = useSelector(
    (state: RootState) => state.connection
  );

  const getStatusColor = () => {
    if (wsConnected) return 'success.main';
    if (reconnectAttempts > 0) return 'warning.main';
    return 'error.main';
  };

  const getStatusText = () => {
    if (wsConnected) return 'Connected';
    if (reconnectAttempts > 0) return `Reconnecting... (${reconnectAttempts})`;
    return 'Disconnected';
  };

  return (
    <Tooltip
      title={
        <Box>
          <Typography variant="body2">WebSocket: {getStatusText()}</Typography>
          {!wsConnected && (
            <Typography variant="caption" sx={{ mt: 0.5, display: 'block' }}>
              Real-time updates are paused
            </Typography>
          )}
        </Box>
      }
    >
      <Box
        display="flex"
        alignItems="center"
        gap={1}
        sx={{
          px: 1,
          py: 0.5,
          borderRadius: 1,
          bgcolor: 'background.paper',
          cursor: 'pointer',
        }}
      >
        {reconnectAttempts > 0 ? (
          <CircularProgress size={12} sx={{ color: 'warning.main' }} />
        ) : (
          <CircleIcon
            sx={{
              fontSize: 12,
              color: getStatusColor(),
              animation: wsConnected ? undefined : 'pulse 2s infinite',
            }}
          />
        )}
        <Typography variant="caption" color="text.secondary">
          {getStatusText()}
        </Typography>
      </Box>
    </Tooltip>
  );
};

export default ConnectionStatus;
