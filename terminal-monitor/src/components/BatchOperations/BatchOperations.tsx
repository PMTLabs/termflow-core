import React, { useState, useRef, useEffect } from 'react';
import {
  Box,
  Button,
  TextField,
  IconButton,
  Typography,
  Chip,
  Tooltip,
  Paper,
} from '@mui/material';
import {
  Send as SendIcon,
  Clear as ClearIcon,
  CheckBox as CheckBoxIcon,
} from '@mui/icons-material';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../store/store';
import { clearSelection } from '../../store/slices/terminalsSlice';
import WebSocketService from '../../services/WebSocketService';

const BatchOperations: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const [batchCommand, setBatchCommand] = useState('');
  const batchInputRef = useRef<HTMLInputElement>(null);
  const selectedTerminalIds = useSelector(
    (state: RootState) => state.terminals.selectedTerminalIds
  );
  const terminals = useSelector(
    (state: RootState) => state.terminals.terminals
  );

  // Focus batch input when terminals are selected
  useEffect(() => {
    if (selectedTerminalIds.length > 0 && batchInputRef.current) {
      batchInputRef.current.focus();
    }
  }, [selectedTerminalIds.length]);

  const selectedTerminals = terminals.filter((t) =>
    selectedTerminalIds.includes(t.id)
  );

  const handleSendBatchCommand = () => {
    if (!batchCommand.trim() || selectedTerminalIds.length === 0) return;

    // Send command to all selected terminals
    selectedTerminalIds.forEach((terminalId) => {
      WebSocketService.sendInput(terminalId, batchCommand + '\n');
    });

    // Clear the input
    setBatchCommand('');
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendBatchCommand();
    }
  };

  if (selectedTerminalIds.length === 0) {
    return null;
  }

  return (
    <Paper
      elevation={2}
      sx={{
        p: 2,
        mb: 2,
        backgroundColor: 'background.paper',
        borderRadius: 1,
      }}
    >
      <Box display="flex" flexDirection="column" gap={2}>
        {/* Selected terminals header */}
        <Box display="flex" alignItems="center" justifyContent="space-between">
          <Box display="flex" alignItems="center" gap={1}>
            <CheckBoxIcon color="primary" />
            <Typography variant="subtitle1">
              {selectedTerminalIds.length} Terminal
              {selectedTerminalIds.length !== 1 ? 's' : ''} Selected
            </Typography>
          </Box>
          <Tooltip title="Clear selection">
            <IconButton
              size="small"
              onClick={() => dispatch(clearSelection())}
              sx={{ color: 'text.secondary' }}
            >
              <ClearIcon />
            </IconButton>
          </Tooltip>
        </Box>

        {/* Selected terminal chips */}
        <Box display="flex" flexWrap="wrap" gap={1}>
          {selectedTerminals.map((terminal) => (
            <Chip
              key={terminal.id}
              label={terminal.name}
              size="small"
              color="primary"
              variant="outlined"
            />
          ))}
        </Box>

        {/* Batch command input */}
        <Box display="flex" gap={1}>
          <TextField
            inputRef={batchInputRef}
            fullWidth
            size="small"
            placeholder="Enter command to send to all selected terminals..."
            value={batchCommand}
            onChange={(e) => setBatchCommand(e.target.value)}
            onKeyPress={handleKeyPress}
            autoFocus
            sx={{
              '& .MuiOutlinedInput-root': {
                backgroundColor: 'background.default',
              },
            }}
          />
          <Button
            variant="contained"
            startIcon={<SendIcon />}
            onClick={handleSendBatchCommand}
            disabled={!batchCommand.trim()}
          >
            Send to All
          </Button>
        </Box>

        {/* Quick actions */}
        <Box display="flex" gap={1}>
          <Typography variant="caption" color="text.secondary" sx={{ mr: 1 }}>
            Quick Actions:
          </Typography>
          <Button
            size="small"
            variant="text"
            onClick={() => {
              setBatchCommand('clear');
              handleSendBatchCommand();
            }}
          >
            Clear All
          </Button>
          <Button
            size="small"
            variant="text"
            onClick={() => {
              setBatchCommand('pwd');
              handleSendBatchCommand();
            }}
          >
            Show PWD
          </Button>
          <Button
            size="small"
            variant="text"
            onClick={() => {
              setBatchCommand('ls -la');
              handleSendBatchCommand();
            }}
          >
            List Files
          </Button>
        </Box>
      </Box>
    </Paper>
  );
};

export default BatchOperations;
