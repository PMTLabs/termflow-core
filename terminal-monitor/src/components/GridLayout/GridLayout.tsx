import React, { useState, useCallback, useRef, useEffect } from 'react';
import {
  Box,
  Paper,
  IconButton,
  Menu,
  MenuItem,
  Tooltip,
  Typography,
  Chip,
  Skeleton,
} from '@mui/material';
import {
  GridView as GridViewIcon,
  Fullscreen,
  Close,
  DragIndicator,
  VisibilityOff,
} from '@mui/icons-material';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from '../../store/store';
import { toggleTerminalSelection } from '../../store/slices/terminalsSlice';
import { DndProvider, useDrag, useDrop } from 'react-dnd';
import { HTML5Backend } from 'react-dnd-html5-backend';
import TerminalViewer from '../TerminalViewer/TerminalViewer';

export interface GridTerminal {
  terminalId: string;
  position: { row: number; col: number };
  size?: { rowSpan?: number; colSpan?: number };
}

export interface GridLayoutConfig {
  id: string;
  name: string;
  terminals: GridTerminal[];
  rows: number;
  cols: number;
}

// Predefined layouts
const PRESET_LAYOUTS: GridLayoutConfig[] = [
  {
    id: 'single',
    name: 'Single',
    rows: 1,
    cols: 1,
    terminals: [],
  },
  {
    id: '1x2',
    name: '2 Vertical',
    rows: 1,
    cols: 2,
    terminals: [],
  },
  {
    id: '2x1',
    name: '2 Horizontal',
    rows: 2,
    cols: 1,
    terminals: [],
  },
  {
    id: '2x2',
    name: '2x2 Grid',
    rows: 2,
    cols: 2,
    terminals: [],
  },
  {
    id: '2x3',
    name: '2x3 Grid',
    rows: 2,
    cols: 3,
    terminals: [],
  },
  {
    id: '3x3',
    name: '3x3 Grid',
    rows: 3,
    cols: 3,
    terminals: [],
  },
];

/**
 * Hook to track which grid positions are visible using Intersection Observer
 * This enables terminal virtualization - only render expensive TerminalViewer for visible terminals
 * For small grids (≤9 terminals), all are considered visible immediately to avoid loading delays
 */
const useVisibleGridPositions = (
  gridRef: React.RefObject<HTMLElement>,
  terminals: any[],
  layout: { rows: number; cols: number }
) => {
  // For small grids, skip virtualization - all terminals visible immediately
  const isSmallGrid = layout.rows * layout.cols <= 9;

  // Initialize with all positions visible for small grids
  const [visiblePositions, setVisiblePositions] = useState<Set<string>>(() => {
    if (isSmallGrid) {
      const allPositions = new Set<string>();
      for (let row = 0; row < layout.rows; row++) {
        for (let col = 0; col < layout.cols; col++) {
          allPositions.add(`${row}-${col}`);
        }
      }
      return allPositions;
    }
    return new Set();
  });

  const observerRef = useRef<IntersectionObserver | null>(null);

  useEffect(() => {
    // For small grids, just set all positions visible and skip observer
    if (isSmallGrid) {
      const allPositions = new Set<string>();
      for (let row = 0; row < layout.rows; row++) {
        for (let col = 0; col < layout.cols; col++) {
          allPositions.add(`${row}-${col}`);
        }
      }
      setVisiblePositions(allPositions);
      return;
    }

    if (!gridRef.current) return;

    // Disconnect existing observer
    if (observerRef.current) {
      observerRef.current.disconnect();
    }

    // Create intersection observer with 10% threshold for better UX
    observerRef.current = new IntersectionObserver(
      (entries) => {
        setVisiblePositions((prev) => {
          const newSet = new Set(prev);
          entries.forEach((entry) => {
            const key = entry.target.getAttribute('data-grid-key');
            if (key) {
              if (entry.isIntersecting) {
                newSet.add(key);
              } else {
                newSet.delete(key);
              }
            }
          });
          return newSet;
        });
      },
      {
        root: gridRef.current,
        threshold: 0.1, // Trigger when 10% visible
        rootMargin: '50px', // Pre-load terminals 50px before they become visible
      }
    );

    // Use a timeout to ensure DOM is rendered before observing
    const timeoutId = setTimeout(() => {
      if (gridRef.current && observerRef.current) {
        const gridChildren = gridRef.current.querySelectorAll('[data-grid-key]');
        gridChildren.forEach((child) => {
          if (observerRef.current) {
            observerRef.current.observe(child);
          }
        });
      }
    }, 50);

    return () => {
      if (observerRef.current) {
        observerRef.current.disconnect();
      }
      clearTimeout(timeoutId);
    };
  }, [gridRef, terminals, isSmallGrid, layout.rows, layout.cols]);

  return visiblePositions;
};

interface GridLayoutProps {
  onClose?: () => void;
}

interface DraggableTerminalProps {
  terminal: any;
  gridTerminal: GridTerminal;
  isMultiSelected: boolean;
  isVisible: boolean;
  onDrop: (
    draggedTerminalId: string,
    targetPosition: { row: number; col: number }
  ) => void;
  onFullscreen: (terminalId: string) => void;
  onToggleSelection: (terminalId: string) => void;
}

const DraggableTerminal: React.FC<DraggableTerminalProps> = ({
  terminal,
  gridTerminal,
  isMultiSelected,
  isVisible,
  onDrop,
  onFullscreen,
  onToggleSelection,
}) => {
  const [{ isDragging }, drag, preview] = useDrag({
    type: 'terminal',
    item: { terminalId: terminal.id },
    collect: (monitor) => ({
      isDragging: monitor.isDragging(),
    }),
  });

  const [{ isOver }, drop] = useDrop({
    accept: 'terminal',
    drop: (item: { terminalId: string }) => {
      if (item.terminalId !== terminal.id) {
        onDrop(item.terminalId, gridTerminal.position);
      }
    },
    collect: (monitor) => ({
      isOver: monitor.isOver(),
    }),
  });

  // Create unique key for intersection observer
  const gridKey = `${gridTerminal.position.row}-${gridTerminal.position.col}`;

  return (
    <Paper
      ref={(node) => {
        preview(drop(node));
      }}
      data-grid-key={gridKey}
      elevation={1}
      sx={{
        gridRow: gridTerminal.position.row + 1,
        gridColumn: gridTerminal.position.col + 1,
        gridRowEnd: gridTerminal.size?.rowSpan
          ? `span ${gridTerminal.size.rowSpan}`
          : 'auto',
        gridColumnEnd: gridTerminal.size?.colSpan
          ? `span ${gridTerminal.size.colSpan}`
          : 'auto',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        position: 'relative',
        minHeight: 0,
        minWidth: 0,
        opacity: isDragging ? 0.5 : 1,
        backgroundColor: isOver ? 'action.hover' : 'background.paper',
        transition: 'all 0.2s ease',
      }}
    >
      {/* Terminal Header */}
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          px: 1,
          py: 0.5,
          borderBottom: 1,
          borderColor: 'divider',
          backgroundColor: isMultiSelected
            ? 'primary.dark'
            : 'background.paper',
          cursor: 'pointer',
        }}
        onClick={() => onToggleSelection(terminal.id)}
      >
        <Box display="flex" alignItems="center" gap={1}>
          <IconButton
            ref={drag}
            size="small"
            sx={{ cursor: 'move' }}
            onClick={(e) => e.stopPropagation()}
          >
            <DragIndicator fontSize="small" />
          </IconButton>
          <Typography variant="caption" noWrap>
            {terminal.name}
          </Typography>
          {isMultiSelected && (
            <Chip
              label="Selected"
              size="small"
              color="primary"
              sx={{ height: 16, fontSize: '0.7rem' }}
            />
          )}
        </Box>
        <Tooltip title="Fullscreen">
          <IconButton
            size="small"
            onClick={(e) => {
              e.stopPropagation();
              onFullscreen(terminal.id);
            }}
          >
            <Fullscreen fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {/* Terminal Content - Virtualized */}
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
        {isVisible ? (
          <TerminalViewer terminalId={terminal.id} />
        ) : (
          <Box
            sx={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: '#1e1e1e',
              color: 'text.secondary',
              flexDirection: 'column',
              gap: 1,
            }}
          >
            <VisibilityOff sx={{ fontSize: 32, opacity: 0.5 }} />
            <Typography variant="caption" sx={{ opacity: 0.7 }}>
              Terminal not visible
            </Typography>
            <Typography variant="caption" sx={{ opacity: 0.5, fontSize: '0.7rem' }}>
              Scroll to view content
            </Typography>
          </Box>
        )}
      </Box>
    </Paper>
  );
};

const GridLayout: React.FC<GridLayoutProps> = ({ onClose }) => {
  const dispatch = useDispatch<AppDispatch>();
  const terminals = useSelector(
    (state: RootState) => state.terminals.terminals
  );
  const selectedTerminalIds = useSelector(
    (state: RootState) => state.terminals.selectedTerminalIds
  );
  const [currentLayout, setCurrentLayout] = useState<GridLayoutConfig>(
    PRESET_LAYOUTS[0]
  );
  const [anchorEl, setAnchorEl] = useState<null | HTMLElement>(null);
  const [fullscreenTerminal, setFullscreenTerminal] = useState<string | null>(
    null
  );

  // Virtualization: Track visible terminals (disabled for small grids ≤9 cells)
  const gridRef = useRef<HTMLDivElement>(null);
  const visiblePositions = useVisibleGridPositions(gridRef, terminals, currentLayout);

  const handleLayoutMenuOpen = (event: React.MouseEvent<HTMLElement>) => {
    setAnchorEl(event.currentTarget);
  };

  const handleLayoutMenuClose = () => {
    setAnchorEl(null);
  };

  const handleLayoutSelect = useCallback(
    (layout: GridLayoutConfig) => {
      // Auto-assign terminals to grid positions
      const assignedTerminals: GridTerminal[] = [];
      let position = 0;

      for (let row = 0; row < layout.rows; row++) {
        for (let col = 0; col < layout.cols; col++) {
          if (position < terminals.length) {
            assignedTerminals.push({
              terminalId: terminals[position].id,
              position: { row, col },
            });
            position++;
          }
        }
      }

      setCurrentLayout({
        ...layout,
        terminals: assignedTerminals,
      });
      handleLayoutMenuClose();
    },
    [terminals]
  );

  // Initialize layout with terminals on mount - MUST come after handleLayoutSelect
  useEffect(() => {
    if (currentLayout.terminals.length === 0 && terminals.length > 0) {
      handleLayoutSelect(PRESET_LAYOUTS[0]);
    }
  }, [terminals, currentLayout.terminals.length, handleLayoutSelect]);

  const handleTerminalDrop = useCallback(
    (
      draggedTerminalId: string,
      targetPosition: { row: number; col: number }
    ) => {
      setCurrentLayout((prevLayout) => {
        const newTerminals = [...prevLayout.terminals];
        const draggedIndex = newTerminals.findIndex(
          (t) => t.terminalId === draggedTerminalId
        );
        const targetIndex = newTerminals.findIndex(
          (t) =>
            t.position.row === targetPosition.row &&
            t.position.col === targetPosition.col
        );

        if (draggedIndex !== -1 && targetIndex !== -1) {
          // Swap positions
          const draggedTerminal = newTerminals[draggedIndex];
          const targetTerminal = newTerminals[targetIndex];

          newTerminals[draggedIndex] = {
            ...draggedTerminal,
            position: targetTerminal.position,
          };
          newTerminals[targetIndex] = {
            ...targetTerminal,
            position: draggedTerminal.position,
          };
        }

        return {
          ...prevLayout,
          terminals: newTerminals,
        };
      });
    },
    []
  );

  const handleFullscreen = (terminalId: string) => {
    setFullscreenTerminal(terminalId);
  };

  const handleExitFullscreen = () => {
    setFullscreenTerminal(null);
  };

  // Render fullscreen terminal
  if (fullscreenTerminal) {
    return (
      <Box
        sx={{
          position: 'fixed',
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 9999,
          backgroundColor: 'background.default',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <Box
          sx={{
            display: 'flex',
            justifyContent: 'flex-end',
            p: 1,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <IconButton onClick={handleExitFullscreen}>
            <Close />
          </IconButton>
        </Box>
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
          <TerminalViewer terminalId={fullscreenTerminal} />
        </Box>
      </Box>
    );
  }

  return (
    <DndProvider backend={HTML5Backend}>
      <Box
        sx={{
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0,
          minWidth: 0,
          overflow: 'hidden',
        }}
      >
        {/* Controls */}
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            p: 1,
            borderBottom: 1,
            borderColor: 'divider',
          }}
        >
          <Box display="flex" alignItems="center" gap={1}>
            <IconButton onClick={handleLayoutMenuOpen}>
              <GridViewIcon />
            </IconButton>
            <Typography variant="body2">
              {currentLayout.name} ({currentLayout.rows}x{currentLayout.cols})
            </Typography>
          </Box>
          {onClose && (
            <IconButton onClick={onClose} size="small">
              <Close />
            </IconButton>
          )}
        </Box>

        {/* Layout Menu */}
        <Menu
          anchorEl={anchorEl}
          open={Boolean(anchorEl)}
          onClose={handleLayoutMenuClose}
        >
          {PRESET_LAYOUTS.map((layout) => (
            <MenuItem
              key={layout.id}
              onClick={() => handleLayoutSelect(layout)}
              selected={layout.id === currentLayout.id}
            >
              {layout.name}
            </MenuItem>
          ))}
        </Menu>

        {/* Grid Container - Virtualized */}
        <Box
          ref={gridRef}
          sx={{
            flex: '1 1 auto',
            height: '100%',
            minHeight: 0,
            minWidth: 0,
            display: 'grid',
            gridTemplateRows: `repeat(${currentLayout.rows}, 1fr)`,
            gridTemplateColumns: `repeat(${currentLayout.cols}, 1fr)`,
            gap: 1,
            p: 1,
            overflow: 'hidden',
          }}
        >
          {currentLayout.terminals.map((gridTerminal) => {
            const terminal = terminals.find(
              (t) => t.id === gridTerminal.terminalId
            );
            if (!terminal) return null;

            // Check if this terminal position is visible
            const gridKey = `${gridTerminal.position.row}-${gridTerminal.position.col}`;
            const isVisible = visiblePositions.has(gridKey);

            return (
              <DraggableTerminal
                key={gridTerminal.terminalId}
                terminal={terminal}
                gridTerminal={gridTerminal}
                isMultiSelected={selectedTerminalIds.includes(terminal.id)}
                isVisible={isVisible}
                onDrop={handleTerminalDrop}
                onFullscreen={handleFullscreen}
                onToggleSelection={(id) =>
                  dispatch(toggleTerminalSelection(id))
                }
              />
            );
          })}
        </Box>
      </Box>
    </DndProvider>
  );
};

export default GridLayout;
