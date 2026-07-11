import React, { useState } from 'react';
import { Box, Button, ButtonGroup, IconButton, Collapse } from '@mui/material';
import KeyboardIcon from '@mui/icons-material/Keyboard';
import { useSelector } from 'react-redux';
import { RootState } from '../../store/store';
import { monitorBridge } from '../TerminalViewer/MonitorBridge';

// Slim collapsible touch-keys bar. Native typing is primary; this is a fallback
// for special keys that are awkward on touch devices. Collapsed by default.
const KEYS: Array<[string, string]> = [
  ['^C', '\x03'],
  ['Esc', '\x1b'],
  ['Tab', '\t'],
  ['←', '\x1b[D'],
  ['↑', '\x1b[A'],
  ['↓', '\x1b[B'],
  ['→', '\x1b[C'],
];

const TouchKeysBar: React.FC = () => {
  const [open, setOpen] = useState(false);
  const id = useSelector((s: RootState) => s.terminals.selectedTerminalId);
  const send = (seq: string) => {
    if (id) monitorBridge.write(id, seq);
  };
  return (
    <Box display="flex" alignItems="center" gap={1} px={1} py={0.5}>
      <IconButton
        size="small"
        onClick={() => setOpen((o) => !o)}
        aria-label="toggle keys"
      >
        <KeyboardIcon fontSize="small" />
      </IconButton>
      <Collapse in={open} orientation="horizontal">
        <ButtonGroup size="small" disabled={!id}>
          {KEYS.map(([label, seq]) => (
            <Button key={label} onClick={() => send(seq)}>
              {label}
            </Button>
          ))}
        </ButtonGroup>
      </Collapse>
    </Box>
  );
};

export default TouchKeysBar;
