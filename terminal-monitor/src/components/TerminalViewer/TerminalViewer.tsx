import React from 'react';
import { Paper, Box, Typography } from '@mui/material';
import { useSelector } from 'react-redux';
import { RootState } from '../../store/store';
import TerminalView from './TerminalView';

interface TerminalViewerProps {
  terminalId: string;
}

const TerminalViewer: React.FC<TerminalViewerProps> = ({ terminalId }) => {
  const terminal = useSelector((state: RootState) =>
    state.terminals.terminals.find((t) => t.id === terminalId)
  );

  if (!terminal) {
    return (
      <Paper elevation={1} sx={{ height: '100%', p: 2 }}>
        <Typography color="textSecondary">
          Select a terminal to view output
        </Typography>
      </Paper>
    );
  }

  return (
    <Box
      sx={{
        flex: '1 1 auto',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        backgroundColor: 'background.paper',
        borderRadius: 1,
        boxShadow: 1,
        minHeight: 0,
        minWidth: 0,
        height: '100%',
        width: '100%',
        position: 'relative',
      }}
    >
      {/* Terminal header */}
      <Box
        p={1}
        borderBottom={1}
        borderColor="divider"
        sx={{ flexShrink: 0 }}
      >
        <Typography variant="subtitle1">
          {terminal.name} ({terminal.profile})
        </Typography>
      </Box>
      {/* Terminal content - takes remaining space */}
      <Box
        sx={{
          flex: '1 1 auto',
          overflow: 'hidden',
          minHeight: 0,
          minWidth: 0,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {/* key prop ensures a fresh engine instance per terminal; the engine's
            cacheKey preserves the xterm + scrollback across remounts. */}
        <TerminalView key={terminalId} terminalId={terminalId} />
      </Box>
    </Box>
  );
};

export default React.memo(TerminalViewer, (prevProps, nextProps) => {
  return prevProps.terminalId === nextProps.terminalId;
});
