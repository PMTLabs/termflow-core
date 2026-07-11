import React from 'react';
import { Box, CircularProgress, Skeleton, Paper } from '@mui/material';

export const TerminalSkeleton: React.FC = () => (
  <Skeleton
    variant="rectangular"
    animation="wave"
    sx={{
      bgcolor: 'grey.900',
      width: '100%',
      height: '100%',
      flex: 1,
      minHeight: 200,
    }}
  />
);

interface LoadingOverlayProps {
  loading: boolean;
  children: React.ReactNode;
}

export const LoadingOverlay: React.FC<LoadingOverlayProps> = ({
  loading,
  children,
}) => (
  <Box
    sx={{
      position: 'relative',
      height: '100%',
      width: '100%',
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      minHeight: 0,
      minWidth: 0,
      overflow: 'hidden',
    }}
  >
    {children}
    {loading && (
      <Box
        sx={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          bgcolor: 'rgba(0, 0, 0, 0.5)',
          zIndex: 1000,
        }}
      >
        <CircularProgress />
      </Box>
    )}
  </Box>
);

export const TerminalListSkeleton: React.FC = () => (
  <Paper elevation={1} sx={{ height: '100%', overflow: 'auto' }}>
    <Box p={2}>
      <Skeleton
        variant="text"
        width={150}
        height={32}
        animation="wave"
        sx={{ mb: 2 }}
      />
      {[1, 2, 3].map((item) => (
        <Box key={item} mb={1}>
          <Skeleton
            variant="rectangular"
            height={60}
            animation="wave"
            sx={{ bgcolor: 'grey.800', borderRadius: 1 }}
          />
        </Box>
      ))}
    </Box>
  </Paper>
);
