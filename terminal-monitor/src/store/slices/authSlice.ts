import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import authService from '../../services/authService';

interface AuthState {
  isAuthenticated: boolean;
  token: string | null;
  permissions: string[];
  isLoading: boolean;
  error: string | null;
}

const initialState: AuthState = {
  isAuthenticated: false,
  token: null,
  permissions: [],
  isLoading: false,
  error: null,
};

// Async thunk for login
export const login = createAsyncThunk(
  'auth/login',
  async (credentials?: {
    username?: string;
    password?: string;
    clientId?: string;
  }) => {
    const response = await authService.login(credentials);
    return response;
  }
);

// Async thunk for token refresh
export const refreshToken = createAsyncThunk('auth/refreshToken', async () => {
  const token = await authService.refreshToken();
  if (!token) {
    throw new Error('Failed to refresh token');
  }
  return token;
});

const authSlice = createSlice({
  name: 'auth',
  initialState,
  reducers: {
    logout: (state) => {
      authService.logout();
      state.isAuthenticated = false;
      state.token = null;
      state.permissions = [];
      state.error = null;
    },
    initializeAuth: (state) => {
      const token = authService.getToken();
      const permissions = authService.getPermissions();
      if (token) {
        state.isAuthenticated = true;
        state.token = token;
        state.permissions = permissions;
      }
    },
    clearError: (state) => {
      state.error = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // Login cases
      .addCase(login.pending, (state) => {
        state.isLoading = true;
        state.error = null;
      })
      .addCase(login.fulfilled, (state, action) => {
        state.isLoading = false;
        state.isAuthenticated = true;
        state.token = action.payload.token;
        state.permissions = action.payload.permissions;
        state.error = null;
      })
      .addCase(login.rejected, (state, action) => {
        state.isLoading = false;
        state.isAuthenticated = false;
        state.token = null;
        state.permissions = [];
        state.error = action.error.message || 'Login failed';
      })
      // Refresh token cases
      .addCase(refreshToken.fulfilled, (state, action) => {
        state.token = action.payload;
      })
      .addCase(refreshToken.rejected, (state) => {
        state.isAuthenticated = false;
        state.token = null;
        state.permissions = [];
        state.error = 'Session expired';
      });
  },
});

export const { logout, initializeAuth, clearError } = authSlice.actions;
export default authSlice.reducer;
