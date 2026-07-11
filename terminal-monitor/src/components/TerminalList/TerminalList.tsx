import React, { memo, useCallback, useState } from 'react';
import {
  List,
  ListItem,
  ListItemText,
  ListItemIcon,
  ListItemSecondaryAction,
  IconButton,
  Paper,
  Typography,
  Box,
  Fade,
  Menu,
  MenuItem,
  ListItemIcon as MenuItemIcon,
  Divider,
  Tooltip,
  Avatar,
} from '@mui/material';
import {
  Terminal as TerminalIcon,
  Delete as DeleteIcon,
  Circle as CircleIcon,
  CheckBox as CheckBoxIcon,
  CheckBoxOutlineBlank as CheckBoxOutlineBlankIcon,
  MoreVert as MoreVertIcon,
  Refresh as RefreshIcon,
  ChevronLeft as ChevronLeftIcon,
  ChevronRight as ChevronRightIcon,
} from '@mui/icons-material';
import { useSelector, useDispatch, shallowEqual } from 'react-redux';
import { RootState, AppDispatch } from '../../store/store';
import {
  selectTerminal,
  deleteTerminal,
  resetTerminal,
  toggleTerminalSelection,
} from '../../store/slices/terminalsSlice';
import { Terminal } from '../../types/terminal';
import { TerminalListSkeleton } from '../LoadingStates';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';

// Memoize individual terminal items to prevent re-renders
const TerminalListItem = memo(
  ({
    terminal,
    isSelected,
    isMultiSelected,
    collapsed = false,
    onSelect,
    onMultiSelect,
    onDelete,
    onReset,
  }: {
    terminal: Terminal;
    isSelected: boolean;
    isMultiSelected: boolean;
    collapsed?: boolean;
    onSelect: (id: string) => void;
    onMultiSelect: (id: string, event: React.MouseEvent) => void;
    onDelete: (id: string, event: React.MouseEvent) => void;
    onReset: (id: string, event: React.MouseEvent) => void;
  }) => {
    const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
    const menuOpen = Boolean(anchorEl);

    const handleMenuClick = (event: React.MouseEvent<HTMLElement>) => {
      event.stopPropagation();
      setAnchorEl(event.currentTarget);
    };

    const handleMenuClose = () => {
      setAnchorEl(null);
    };

    const handleDeleteClick = (event: React.MouseEvent) => {
      handleMenuClose();
      onDelete(terminal.id, event);
    };

    const handleResetClick = (event: React.MouseEvent) => {
      handleMenuClose();
      onReset(terminal.id, event);
    };
    const getStatusColor = (status: string) => {
      switch (status) {
        case 'running':
          return 'success';
        case 'resetting':
          return 'warning';
        case 'error':
          return 'error';
        default:
          return 'error';
      }
    };

    const formatDate = (dateString: string) => {
      return new Date(dateString).toLocaleTimeString();
    };

    // Collapsed view - show only icon with tooltip
    if (collapsed) {
      return (
        <Tooltip title={terminal.name} placement="right" arrow>
          <ListItem
            button
            selected={isSelected || isMultiSelected}
            onClick={() => onSelect(terminal.id)}
            sx={{
              mb: 1,
              borderRadius: 1,
              justifyContent: 'center',
              px: 1,
              minHeight: 48,
              '&.Mui-selected': {
                backgroundColor: isMultiSelected
                  ? 'primary.dark'
                  : 'action.selected',
              },
            }}
          >
            <Box sx={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <Avatar
                sx={{
                  width: 32,
                  height: 32,
                  bgcolor: isSelected ? 'primary.main' : 'action.hover',
                  fontSize: '0.875rem',
                }}
              >
                {terminal.name.charAt(0).toUpperCase()}
              </Avatar>
              {/* Status indicator dot */}
              <CircleIcon
                sx={{
                  position: 'absolute',
                  bottom: -2,
                  right: -2,
                  fontSize: 10,
                  color: `${getStatusColor(terminal.status)}.main`,
                }}
              />
            </Box>
          </ListItem>
        </Tooltip>
      );
    }

    // Expanded view - show full details
    return (
      <ListItem
        button
        selected={isSelected || isMultiSelected}
        onClick={() => onSelect(terminal.id)}
        sx={{
          mb: 1,
          borderRadius: 1,
          '&.Mui-selected': {
            backgroundColor: isMultiSelected
              ? 'primary.dark'
              : 'action.selected',
          },
        }}
      >
        <ListItemIcon>
          <IconButton
            size="small"
            onClick={(e) => onMultiSelect(terminal.id, e)}
            sx={{ p: 0.5, mr: 1 }}
          >
            {isMultiSelected ? (
              <CheckBoxIcon color="primary" />
            ) : (
              <CheckBoxOutlineBlankIcon />
            )}
          </IconButton>
          <TerminalIcon />
        </ListItemIcon>
        <ListItemText
          primary={
            <Typography variant="body1" noWrap sx={{ fontWeight: 'medium' }}>
              {terminal.name}
            </Typography>
          }
          secondary={
            <Box
              component="span"
              sx={{ display: 'flex', alignItems: 'center', mt: 0.5 }}
            >
              {/* Status Dot */}
              <CircleIcon
                sx={{
                  fontSize: 10,
                  mr: 0.5,
                  color: `${getStatusColor(terminal.status)}.main`,
                }}
              />
              {/* Metadata Line: Profile • Time */}
              <Typography variant="caption" color="text.secondary" noWrap>
                {terminal.profile} • {formatDate(terminal.createdAt)}
              </Typography>
            </Box>
          }
          secondaryTypographyProps={{
            component: 'div',
          }}
        />

        <ListItemSecondaryAction>
          <IconButton
            edge="end"
            size="small"
            onClick={handleMenuClick}
            aria-controls={menuOpen ? 'terminal-menu' : undefined}
            aria-haspopup="true"
            aria-expanded={menuOpen ? 'true' : undefined}
          >
            <MoreVertIcon />
          </IconButton>
          <Menu
            id="terminal-menu"
            anchorEl={anchorEl}
            open={menuOpen}
            onClose={handleMenuClose}
            MenuListProps={{
              'aria-labelledby': 'terminal-menu-button',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <MenuItem onClick={handleResetClick}>
              <MenuItemIcon>
                <RefreshIcon fontSize="small" />
              </MenuItemIcon>
              <Typography variant="inherit">Reset Terminal</Typography>
            </MenuItem>
            <Divider />
            <MenuItem onClick={handleDeleteClick}>
              <MenuItemIcon>
                <DeleteIcon fontSize="small" />
              </MenuItemIcon>
              <Typography variant="inherit">Delete Terminal</Typography>
            </MenuItem>
          </Menu>
        </ListItemSecondaryAction>
      </ListItem>
    );
  },
  (prevProps, nextProps) => {
    // Custom comparison function - return true if props are equal (skip re-render)
    return (
      prevProps.terminal.id === nextProps.terminal.id &&
      prevProps.terminal.name === nextProps.terminal.name &&
      prevProps.terminal.status === nextProps.terminal.status &&
      prevProps.terminal.profile === nextProps.terminal.profile &&
      prevProps.terminal.mode === nextProps.terminal.mode &&
      prevProps.isSelected === nextProps.isSelected &&
      prevProps.isMultiSelected === nextProps.isMultiSelected &&
      prevProps.collapsed === nextProps.collapsed
    );
  }
);

TerminalListItem.displayName = 'TerminalListItem';

export interface TerminalListProps {
  collapsed?: boolean;
  onToggle?: () => void;
}

const TerminalList: React.FC<TerminalListProps> = ({ collapsed = false, onToggle }) => {
  const dispatch = useDispatch<AppDispatch>();
  const { confirm, ConfirmDialog } = useConfirmDialog();

  // Use shallowEqual to prevent unnecessary re-renders
  const terminals = useSelector(
    (state: RootState) => state.terminals.terminals,
    shallowEqual
  );
  const selectedTerminalId = useSelector(
    (state: RootState) => state.terminals.selectedTerminalId
  );
  const selectedTerminalIds = useSelector(
    (state: RootState) => state.terminals.selectedTerminalIds,
    shallowEqual
  );
  const loading = useSelector((state: RootState) => state.terminals.loading);
  const error = useSelector((state: RootState) => state.terminals.error);

  console.log(
    'TerminalList render - loading:',
    loading,
    'terminals:',
    terminals.length,
    'error:',
    error
  );

  const handleSelectTerminal = useCallback(
    (terminalId: string) => {
      dispatch(selectTerminal(terminalId));
    },
    [dispatch]
  );

  const handleMultiSelectTerminal = useCallback(
    (terminalId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      dispatch(toggleTerminalSelection(terminalId));
    },
    [dispatch]
  );

  const handleDeleteTerminal = useCallback(
    async (terminalId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      const terminal = terminals.find((t) => t.id === terminalId);
      const confirmed = await confirm({
        title: 'Delete Terminal',
        message: `Are you sure you want to delete "${terminal?.name || 'this terminal'}"? This action cannot be undone.`,
        confirmText: 'Delete',
        confirmColor: 'error',
      });

      if (confirmed) {
        dispatch(deleteTerminal(terminalId));
      }
    },
    [dispatch, confirm, terminals]
  );

  const handleResetTerminal = useCallback(
    async (terminalId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      const terminal = terminals.find((t) => t.id === terminalId);
      const confirmed = await confirm({
        title: 'Reset Terminal',
        message: `Are you sure you want to reset "${terminal?.name || 'this terminal'}"? This will restart the shell process.`,
        confirmText: 'Reset',
        confirmColor: 'warning',
      });

      if (confirmed) {
        dispatch(resetTerminal(terminalId));
      }
    },
    [dispatch, confirm, terminals]
  );

  if (loading) {
    return (
      <Paper elevation={1} sx={{ height: '100%', overflow: 'auto' }}>
        <Box p={collapsed ? 1 : 2}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: collapsed ? 'center' : 'space-between',
              mb: collapsed ? 1 : 2,
            }}
          >
            {!collapsed && (
              <Typography variant="h6">
                Active Terminals
              </Typography>
            )}
            {onToggle && (
              <IconButton
                size="small"
                onClick={onToggle}
                sx={{
                  transition: 'transform 0.3s ease',
                }}
              >
                {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
              </IconButton>
            )}
          </Box>
          {!collapsed && <TerminalListSkeleton />}
        </Box>
      </Paper>
    );
  }

  if (error) {
    return (
      <Box p={2}>
        <Typography color="error">Error: {error}</Typography>
      </Box>
    );
  }

  return (
    <>
      <Paper elevation={1} sx={{ height: '100%', overflow: 'auto' }}>
        <Box p={collapsed ? 1 : 2}>
          {/* Header with toggle button */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: collapsed ? 'center' : 'space-between',
              mb: collapsed ? 1 : 2,
            }}
          >
            {!collapsed && (
              <Typography variant="h6">
                Active Terminals
              </Typography>
            )}
            {onToggle && (
              <Tooltip title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} placement="right">
                <IconButton
                  size="small"
                  onClick={onToggle}
                  sx={{
                    transition: 'transform 0.3s ease',
                  }}
                >
                  {collapsed ? <ChevronRightIcon /> : <ChevronLeftIcon />}
                </IconButton>
              </Tooltip>
            )}
          </Box>
          <Fade in={!loading} timeout={300}>
            <Box>
              {terminals.length === 0 ? (
                !collapsed && (
                  <Typography color="textSecondary">
                    No terminals active
                  </Typography>
                )
              ) : (
                <List sx={{ p: 0 }}>
                  {terminals.map((terminal: Terminal) => (
                    <TerminalListItem
                      key={terminal.id}
                      terminal={terminal}
                      isSelected={selectedTerminalId === terminal.id}
                      isMultiSelected={selectedTerminalIds.includes(
                        terminal.id
                      )}
                      collapsed={collapsed}
                      onSelect={handleSelectTerminal}
                      onMultiSelect={handleMultiSelectTerminal}
                      onDelete={handleDeleteTerminal}
                      onReset={handleResetTerminal}
                    />
                  ))}
                </List>
              )}
            </Box>
          </Fade>
        </Box>
      </Paper>
      <ConfirmDialog />
    </>
  );
};

export default memo(TerminalList);
