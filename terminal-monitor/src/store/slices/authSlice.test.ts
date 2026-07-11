import authReducer, {
  login,
  logout,
  refreshToken,
  initializeAuth,
  clearError,
} from './authSlice';
import authService from '../../services/authService';

// Mock authService
jest.mock('../../services/authService', () => ({
  isAuthenticated: jest.fn(),
  getToken: jest.fn(),
  getPermissions: jest.fn(),
  setToken: jest.fn(),
  logout: jest.fn(),
  login: jest.fn(),
  refreshToken: jest.fn(),
}));

interface AuthState {
  isAuthenticated: boolean;
  token: string | null;
  permissions: string[];
  isLoading: boolean;
  error: string | null;
}

describe('authSlice', () => {
  const initialState: AuthState = {
    isAuthenticated: false,
    token: null,
    permissions: [],
    isLoading: false,
    error: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('reducer', () => {
    it('should return the initial state', () => {
      expect(authReducer(undefined, { type: 'unknown' })).toEqual(initialState);
    });
  });

  describe('synchronous actions', () => {
    describe('logout', () => {
      it('should reset state on logout', () => {
        const authenticatedState: AuthState = {
          isAuthenticated: true,
          token: 'test-token',
          permissions: ['read', 'write'],
          isLoading: false,
          error: null,
        };

        const state = authReducer(authenticatedState, logout());

        expect(authService.logout).toHaveBeenCalled();
        expect(state.isAuthenticated).toBe(false);
        expect(state.token).toBe(null);
        expect(state.permissions).toEqual([]);
        expect(state.error).toBe(null);
      });
    });

    describe('initializeAuth', () => {
      it('should set authenticated state when token exists', () => {
        const mockToken = 'test-token';
        const mockPermissions = ['read', 'write'];
        (authService.getToken as jest.Mock).mockReturnValue(mockToken);
        (authService.getPermissions as jest.Mock).mockReturnValue(
          mockPermissions
        );

        const state = authReducer(initialState, initializeAuth());

        expect(state.isAuthenticated).toBe(true);
        expect(state.token).toBe(mockToken);
        expect(state.permissions).toEqual(mockPermissions);
      });

      it('should not change state when no token exists', () => {
        (authService.getToken as jest.Mock).mockReturnValue(null);
        (authService.getPermissions as jest.Mock).mockReturnValue([]);

        const state = authReducer(initialState, initializeAuth());

        expect(state).toEqual(initialState);
      });
    });

    describe('clearError', () => {
      it('should clear error message', () => {
        const stateWithError: AuthState = {
          ...initialState,
          error: 'Login failed',
        };

        const state = authReducer(stateWithError, clearError());
        expect(state.error).toBe(null);
      });
    });
  });

  describe('async actions', () => {
    describe('login', () => {
      it('should handle successful login', async () => {
        const mockCredentials = { username: 'test', password: 'password' };
        const mockResponse = {
          token: 'test-token',
          permissions: ['read', 'write'],
        };
        (authService.login as jest.Mock).mockResolvedValue(mockResponse);

        const dispatch = jest.fn();
        const getState = jest.fn();

        await login(mockCredentials)(dispatch, getState, undefined);

        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: login.fulfilled.type,
            payload: mockResponse,
          })
        );
      });

      it('should handle login failure', async () => {
        const mockCredentials = { username: 'test', password: 'wrong' };
        const mockError = new Error('Invalid credentials');
        (authService.login as jest.Mock).mockRejectedValue(mockError);

        const dispatch = jest.fn();
        const getState = jest.fn();

        await login(mockCredentials)(dispatch, getState, undefined);

        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: login.rejected.type,
            error: expect.objectContaining({
              message: 'Invalid credentials',
            }),
          })
        );
      });
    });

    describe('refreshToken', () => {
      it('should handle successful token refresh', async () => {
        const mockNewToken = 'new-token';
        (authService.refreshToken as jest.Mock).mockResolvedValue(mockNewToken);

        const dispatch = jest.fn();
        const getState = jest.fn();

        await refreshToken()(dispatch, getState, undefined);

        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: refreshToken.fulfilled.type,
            payload: mockNewToken,
          })
        );
      });

      it('should handle token refresh failure', async () => {
        (authService.refreshToken as jest.Mock).mockResolvedValue(null);

        const dispatch = jest.fn();
        const getState = jest.fn();

        await refreshToken()(dispatch, getState, undefined);

        expect(dispatch).toHaveBeenCalledWith(
          expect.objectContaining({
            type: refreshToken.rejected.type,
            error: expect.objectContaining({
              message: 'Failed to refresh token',
            }),
          })
        );
      });
    });
  });

  describe('slice reducers', () => {
    it('should handle login.pending', () => {
      const action = { type: login.pending.type };
      const state = authReducer(initialState, action);
      expect(state.isLoading).toBe(true);
      expect(state.error).toBe(null);
    });

    it('should handle login.fulfilled', () => {
      const mockPayload = {
        token: 'test-token',
        permissions: ['read', 'write'],
      };
      const action = { type: login.fulfilled.type, payload: mockPayload };
      const state = authReducer(initialState, action);
      expect(state.isAuthenticated).toBe(true);
      expect(state.token).toBe(mockPayload.token);
      expect(state.permissions).toEqual(mockPayload.permissions);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBe(null);
    });

    it('should handle login.rejected', () => {
      const mockError = 'Login failed';
      const action = {
        type: login.rejected.type,
        error: { message: mockError },
      };
      const state = authReducer(initialState, action);
      expect(state.isAuthenticated).toBe(false);
      expect(state.token).toBe(null);
      expect(state.permissions).toEqual([]);
      expect(state.isLoading).toBe(false);
      expect(state.error).toBe(mockError);
    });

    it('should handle refreshToken.fulfilled', () => {
      const authenticatedState: AuthState = {
        isAuthenticated: true,
        token: 'old-token',
        permissions: ['read'],
        isLoading: false,
        error: null,
      };
      const newToken = 'new-token';
      const action = { type: refreshToken.fulfilled.type, payload: newToken };
      const state = authReducer(authenticatedState, action);
      expect(state.token).toBe(newToken);
      expect(state.isAuthenticated).toBe(true); // Should remain authenticated
    });

    it('should handle refreshToken.rejected', () => {
      const authenticatedState: AuthState = {
        isAuthenticated: true,
        token: 'old-token',
        permissions: ['read'],
        isLoading: false,
        error: null,
      };
      const action = { type: refreshToken.rejected.type };
      const state = authReducer(authenticatedState, action);
      expect(state.isAuthenticated).toBe(false);
      expect(state.token).toBe(null);
      expect(state.permissions).toEqual([]);
      expect(state.error).toBe('Session expired');
    });
  });
});
