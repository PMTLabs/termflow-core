import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import Header from './Header';
import authReducer from '../../store/slices/authSlice';
import connectionReducer from '../../store/slices/connectionSlice';
import gridReducer from '../../store/slices/gridSlice';

describe('Header', () => {
  const createMockStore = (preloadedState?: any) => {
    return configureStore({
      reducer: {
        auth: authReducer,
        connection: connectionReducer,
        grid: gridReducer,
      },
      preloadedState,
    });
  };

  const defaultAuthState = {
    isAuthenticated: true,
    token: 'test-token',
    permissions: ['read', 'write'],
    isLoading: false,
    error: null,
  };

  const defaultConnectionState = {
    wsConnected: true,
    apiConnected: true,
    reconnectAttempts: 0,
    lastError: null,
  };

  const defaultGridState = {
    layouts: [],
    activeLayoutId: null,
    isGridViewActive: false,
    savedLayouts: [],
  };

  it('should render header with title', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: defaultConnectionState,
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    expect(screen.getByText('Terminal Monitor')).toBeInTheDocument();
  });

  it('should show connection status indicators', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: defaultConnectionState,
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    expect(screen.getByText('WebSocket: Connected')).toBeInTheDocument();
    expect(screen.getByText('API: Connected')).toBeInTheDocument();
  });

  it('should show disconnected status', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: {
        wsConnected: false,
        apiConnected: false,
        reconnectAttempts: 3,
        lastError: 'Connection failed',
      },
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    expect(screen.getByText('WebSocket: Disconnected')).toBeInTheDocument();
    expect(screen.getByText('API: Disconnected')).toBeInTheDocument();
  });

  it('should show grid view toggle', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: defaultConnectionState,
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    expect(screen.getByLabelText('Grid View')).toBeInTheDocument();
  });

  it('should toggle grid view', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: defaultConnectionState,
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    const gridToggle = screen.getByLabelText('Grid View');
    fireEvent.click(gridToggle);

    const state = store.getState();
    expect(state.grid.isGridViewActive).toBe(true);
  });

  it('should show logout button when authenticated', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: defaultConnectionState,
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    expect(screen.getByText('Logout')).toBeInTheDocument();
  });

  it('should handle logout', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: defaultConnectionState,
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    fireEvent.click(screen.getByText('Logout'));

    const state = store.getState();
    expect(state.auth.isAuthenticated).toBe(false);
    expect(state.auth.token).toBe(null);
  });

  it('should show login button when not authenticated', () => {
    const store = createMockStore({
      auth: {
        isAuthenticated: false,
        token: null,
        permissions: [],
        isLoading: false,
        error: null,
      },
      connection: defaultConnectionState,
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    expect(screen.getByText('Login')).toBeInTheDocument();
  });

  it('should show theme toggle', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: defaultConnectionState,
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    expect(screen.getByLabelText('toggle theme')).toBeInTheDocument();
  });

  it('should show settings button', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: defaultConnectionState,
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    expect(screen.getByLabelText('settings')).toBeInTheDocument();
  });

  it('should show reconnection attempts', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: {
        wsConnected: false,
        apiConnected: true,
        reconnectAttempts: 3,
        lastError: null,
      },
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    expect(
      screen.getByText('WebSocket: Disconnected (3 attempts)')
    ).toBeInTheDocument();
  });

  it('should show connection error tooltip', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: {
        wsConnected: false,
        apiConnected: false,
        reconnectAttempts: 0,
        lastError: 'Network timeout',
      },
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    // Error should be present in the DOM (tooltip content)
    expect(screen.getByTitle('Network timeout')).toBeInTheDocument();
  });

  it('should disable grid view toggle when not authenticated', () => {
    const store = createMockStore({
      auth: {
        isAuthenticated: false,
        token: null,
        permissions: [],
        isLoading: false,
        error: null,
      },
      connection: defaultConnectionState,
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    const gridToggle = screen.getByLabelText('Grid View');
    expect(gridToggle).toBeDisabled();
  });

  it('should show user permissions', () => {
    const store = createMockStore({
      auth: {
        ...defaultAuthState,
        permissions: ['read', 'write', 'admin'],
      },
      connection: defaultConnectionState,
      grid: defaultGridState,
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    // Permissions might be shown in a tooltip or menu
    expect(
      screen.getByTitle(/Permissions: read, write, admin/i)
    ).toBeInTheDocument();
  });

  it('should indicate grid view active state', () => {
    const store = createMockStore({
      auth: defaultAuthState,
      connection: defaultConnectionState,
      grid: {
        ...defaultGridState,
        isGridViewActive: true,
      },
    });

    render(
      <Provider store={store}>
        <Header />
      </Provider>
    );

    const gridToggle = screen.getByLabelText('Grid View');
    expect(gridToggle).toBeChecked();
  });
});
