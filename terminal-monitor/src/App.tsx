import React, { useEffect, lazy, Suspense } from 'react';
import { Provider } from 'react-redux';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, createTheme, CssBaseline } from '@mui/material';
import { Box, CircularProgress } from '@mui/material';
import { store } from './store/store';
import { fetchTerminals } from './store/slices/terminalsSlice';
import { initializeAuth } from './store/slices/authSlice';
import Header from './components/Header/Header';
import Login from './components/Login';
import ProtectedRoute from './components/ProtectedRoute';
import TouchKeysBar from './components/Terminal/TouchKeysBar';
import WebSocketService from './services/WebSocketService';
import authService from './services/authService';
import ErrorBoundary from './components/ErrorBoundary';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useSelector, useDispatch } from 'react-redux';
import { RootState, AppDispatch } from './store/store';
import {
  TerminalSkeleton,
  TerminalListSkeleton,
} from './components/LoadingStates';
import { setGridViewActive } from './store/slices/gridSlice';
import { toggleSidebar } from './store/slices/uiSlice';

// Lazy load heavy components
const TerminalList = lazy(
  () => import('./components/TerminalList/TerminalList')
);
const TerminalViewer = lazy(
  () => import('./components/TerminalViewer/TerminalViewer')
);
const GridLayout = lazy(() => import('./components/GridLayout/GridLayout'));

const darkTheme = createTheme({
  palette: {
    mode: 'dark',
    primary: {
      main: '#90caf9',
      light: '#e3f2fd',
      dark: '#42a5f5',
    },
    secondary: {
      main: '#f48fb1',
      light: '#fce4ec',
      dark: '#f06292',
    },
    background: {
      default: '#121212',
      paper: '#1e1e1e',
    },
    text: {
      primary: '#ffffff',
      secondary: 'rgba(255, 255, 255, 0.7)',
    },
    divider: 'rgba(255, 255, 255, 0.12)',
    action: {
      active: '#fff',
      hover: 'rgba(255, 255, 255, 0.08)',
      selected: 'rgba(255, 255, 255, 0.16)',
      disabled: 'rgba(255, 255, 255, 0.3)',
      disabledBackground: 'rgba(255, 255, 255, 0.12)',
    },
  },
  typography: {
    fontFamily: [
      '-apple-system',
      'BlinkMacSystemFont',
      '"Segoe UI"',
      'Roboto',
      '"Helvetica Neue"',
      'Arial',
      'sans-serif',
    ].join(','),
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: 'none',
        },
      },
    },
    MuiTextField: {
      styleOverrides: {
        root: {
          '& .MuiOutlinedInput-root': {
            '& fieldset': {
              borderColor: 'rgba(255, 255, 255, 0.23)',
            },
            '&:hover fieldset': {
              borderColor: 'rgba(255, 255, 255, 0.4)',
            },
          },
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          textTransform: 'none',
        },
      },
    },
  },
});

function Dashboard() {
  const dispatch = useDispatch<AppDispatch>();
  const selectedTerminalId = useSelector(
    (state: RootState) => state.terminals.selectedTerminalId
  );
  const terminals = useSelector(
    (state: RootState) => state.terminals.terminals
  );
  const isAuthenticated = useSelector(
    (state: RootState) => state.auth.isAuthenticated
  );
  const isGridViewActive = useSelector(
    (state: RootState) => state.grid.isGridViewActive
  );
  const sidebarCollapsed = useSelector(
    (state: RootState) => state.ui.sidebarCollapsed
  );

  // Enable keyboard shortcuts
  useKeyboardShortcuts();

  useEffect(() => {
    console.log('Dashboard useEffect - isAuthenticated:', isAuthenticated);
    if (isAuthenticated) {
      // Fetch initial terminals
      console.log('Fetching terminals...');
      dispatch(fetchTerminals());

      // Connect to WebSocket
      WebSocketService.connect();

      // Set up periodic refresh with reduced frequency
      // Only refresh when document is visible and user is active
      let refreshInterval: NodeJS.Timeout | null = null;
      let lastFetchTime = Date.now();

      const startPolling = () => {
        // Clear any existing interval first
        if (refreshInterval) {
          clearInterval(refreshInterval);
        }

        refreshInterval = setInterval(() => {
          // Only fetch if document is visible and enough time has passed
          const now = Date.now();
          if (!document.hidden && now - lastFetchTime >= 10000) {
            lastFetchTime = now;
            dispatch(fetchTerminals());
          }
        }, 10000); // Check every 10 seconds
      };

      const stopPolling = () => {
        if (refreshInterval) {
          clearInterval(refreshInterval);
          refreshInterval = null;
        }
      };

      // Start polling initially
      startPolling();

      // Pause polling when document is hidden
      const handleVisibilityChange = () => {
        if (document.hidden) {
          stopPolling();
        } else {
          // Resume polling when becoming visible
          // Only fetch if enough time has passed since last fetch
          const now = Date.now();
          if (now - lastFetchTime >= 10000) {
            lastFetchTime = now;
            dispatch(fetchTerminals());
          }
          startPolling();
        }
      };

      document.addEventListener('visibilitychange', handleVisibilityChange);

      return () => {
        stopPolling();
        document.removeEventListener(
          'visibilitychange',
          handleVisibilityChange
        );
        WebSocketService.disconnect();
      };
    }
  }, [dispatch, isAuthenticated]);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      <Header />
      <Box
        sx={{
          flex: '1 1 auto',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          minHeight: 0,
          minWidth: 0,
          width: '100%',
          px: 2, // Horizontal padding
          pt: 2, // Top padding to separate from header
          pb: 1, // Small bottom padding
        }}
      >
        {isGridViewActive && terminals.length > 1 ? (
          <Suspense
            fallback={
              <Box
                display="flex"
                alignItems="center"
                justifyContent="center"
                height="100%"
              >
                <CircularProgress />
              </Box>
            }
          >
            <GridLayout onClose={() => dispatch(setGridViewActive(false))} />
          </Suspense>
        ) : (
          <Box
            sx={{
              flex: '1 1 auto',
              display: 'flex',
              flexDirection: 'row',
              gap: 1,
              minHeight: 0,
              minWidth: 0,
              height: '100%',
              overflow: 'hidden',
            }}
          >
            {/* Terminal List Panel */}
            <Box
              sx={{
                width: sidebarCollapsed
                  ? { xs: '100%', md: '60px' }
                  : { xs: '100%', md: '280px' },
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                transition: 'width 0.3s ease-in-out',
              }}
            >
              <Suspense fallback={<TerminalListSkeleton />}>
                <TerminalList
                  collapsed={sidebarCollapsed}
                  onToggle={() => dispatch(toggleSidebar())}
                />
              </Suspense>
            </Box>
            {/* Terminal Viewer Panel */}
            <Box
              sx={{
                flex: '1 1 auto',
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
                minWidth: 0,
                overflow: 'hidden',
              }}
            >
              {/* Terminal Display Area - fills remaining space */}
              <Box
                sx={{
                  flex: '1 1 auto',
                  minHeight: 0,
                  minWidth: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                }}
              >
                {selectedTerminalId ? (
                  <Suspense fallback={<TerminalSkeleton />}>
                    <TerminalViewer terminalId={selectedTerminalId} />
                  </Suspense>
                ) : (
                  <Box
                    display="flex"
                    alignItems="center"
                    justifyContent="center"
                    height="100%"
                    sx={{
                      backgroundColor: 'background.paper',
                      borderRadius: 1,
                    }}
                  >
                    Select a terminal to view
                  </Box>
                )}
              </Box>
              {/* Slim collapsible touch-keys bar - natural height, no flex grow.
                  Native typing is primary; this only sends special keys. */}
              {terminals.length > 0 && (
                <Box sx={{
                  flexShrink: 0, // Don't shrink
                  flexGrow: 0,   // Don't grow
                  display: 'flex',
                  alignItems: 'center',
                }}>
                  <TouchKeysBar />
                </Box>
              )}
            </Box>
          </Box>
        )}
      </Box>
    </Box>
  );
}

function AppRouter() {
  const dispatch = useDispatch<AppDispatch>();

  // Initialize auth on app start
  useEffect(() => {
    authService.initialize();
    dispatch(initializeAuth());
  }, [dispatch]);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }
        />
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

function App() {
  return (
    <Provider store={store}>
      <ThemeProvider theme={darkTheme}>
        <CssBaseline />
        <ErrorBoundary>
          <AppRouter />
        </ErrorBoundary>
      </ThemeProvider>
    </Provider>
  );
}

export default App;
