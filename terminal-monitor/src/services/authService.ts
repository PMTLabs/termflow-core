import axios from 'axios';

interface LoginCredentials {
  username?: string;
  password?: string;
  clientId?: string;
}

interface AuthResponse {
  token: string;
  expiresIn: string | number; // Can be "1h" or seconds
  permissions: string[];
}

class AuthService {
  private static TOKEN_KEY = 'terminal_monitor_token';
  private static TOKEN_EXPIRY_KEY = 'terminal_monitor_token_expiry';
  private static PERMISSIONS_KEY = 'terminal_monitor_permissions';
  private refreshTimer: NodeJS.Timeout | null = null;

  /**
   * For development, generate a token from the API
   * In production, this would be a proper login flow
   */
  async login(credentials?: LoginCredentials): Promise<AuthResponse> {
    try {
      // Connect to the auto-terminal API server (same server as WebSocket)
      const baseURL = process.env.REACT_APP_API_URL || 'http://localhost:42031';
      const response = await axios.post(`${baseURL}/api/auth/token`, {
        clientId: credentials?.clientId || 'terminal-monitor',
        permissions: [
          'terminal.read',
          'terminal.write',
          'terminal.create',
          'terminal.delete',
          'event.subscribe',
          'system.info',
          'system.profiles',
        ],
      });

      const { token, expiresIn, permissions } = response.data;

      // Store token and expiry
      this.setToken(token, expiresIn);
      this.setPermissions(permissions);

      return { token, expiresIn, permissions };
    } catch (error) {
      console.error('Login failed:', error);
      throw new Error('Authentication failed');
    }
  }

  /**
   * Clear all auth data
   */
  logout(): void {
    // Clear refresh timer
    this.stopTokenRefreshTimer();

    localStorage.removeItem(AuthService.TOKEN_KEY);
    localStorage.removeItem(AuthService.TOKEN_EXPIRY_KEY);
    localStorage.removeItem(AuthService.PERMISSIONS_KEY);

    // Clear axios default header
    delete axios.defaults.headers.common['Authorization'];
  }

  /**
   * Get the current auth token
   */
  getToken(): string | null {
    const token = localStorage.getItem(AuthService.TOKEN_KEY);
    const expiry = localStorage.getItem(AuthService.TOKEN_EXPIRY_KEY);

    if (!token || !expiry) {
      console.debug('No token or expiry found in localStorage');
      return null;
    }

    // Check if token is expired
    const expiryTime = parseInt(expiry);
    const now = Date.now();
    if (now > expiryTime) {
      console.warn(`Token expired: ${new Date(expiryTime)} < ${new Date(now)}`);
      this.logout();
      return null;
    }

    console.debug(`Token retrieved successfully, expires: ${new Date(expiryTime)}`);
    return token;
  }

  /**
   * Parse duration string to seconds
   */
  private parseDuration(duration: string | number): number {
    if (typeof duration === 'number') {
      return duration;
    }

    const match = duration.match(/^(\d+)([hdms])$/);
    if (!match) {
      console.warn(
        `Invalid duration format: ${duration}, defaulting to 1 hour`
      );
      return 3600; // Default to 1 hour
    }

    const value = parseInt(match[1]);
    const unit = match[2];

    switch (unit) {
      case 's':
        return value;
      case 'm':
        return value * 60;
      case 'h':
        return value * 3600;
      case 'd':
        return value * 86400;
      default:
        return 3600; // Default to 1 hour
    }
  }

  /**
   * Set auth token with expiry
   */
  private setToken(token: string, expiresIn: string | number): void {
    const expiresInSeconds = this.parseDuration(expiresIn);
    const expiryTime = Date.now() + expiresInSeconds * 1000;
    localStorage.setItem(AuthService.TOKEN_KEY, token);
    localStorage.setItem(AuthService.TOKEN_EXPIRY_KEY, expiryTime.toString());

    // Schedule automatic refresh
    this.scheduleTokenRefresh(expiresInSeconds);
  }

  /**
   * Get user permissions
   */
  getPermissions(): string[] {
    const permissions = localStorage.getItem(AuthService.PERMISSIONS_KEY);
    return permissions ? JSON.parse(permissions) : [];
  }

  /**
   * Set user permissions
   */
  private setPermissions(permissions: string[]): void {
    localStorage.setItem(
      AuthService.PERMISSIONS_KEY,
      JSON.stringify(permissions)
    );
  }

  /**
   * Check if user has a specific permission
   */
  hasPermission(permission: string): boolean {
    const permissions = this.getPermissions();
    return permissions.includes(permission) || permissions.includes('*');
  }

  /**
   * Check if token is valid and not expired
   */
  isAuthenticated(): boolean {
    return this.getToken() !== null;
  }

  /**
   * Refresh the token before it expires
   */
  async refreshToken(): Promise<string | null> {
    try {
      const currentToken = this.getToken();
      if (!currentToken) {
        return null;
      }

      const baseURL = process.env.REACT_APP_API_URL || 'http://localhost:42031';
      const response = await axios.post(
        `${baseURL}/api/auth/refresh`,
        {},
        {
          headers: {
            Authorization: `Bearer ${currentToken}`,
          },
        }
      );

      const { token, expiresIn, permissions } = response.data;

      // Update stored token and permissions
      this.setToken(token, expiresIn);
      this.setPermissions(permissions);

      // Update default axios header
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;

      return token;
    } catch (error) {
      console.error('Token refresh failed:', error);
      return null;
    }
  }

  /**
   * Initialize auth from stored token
   */
  initialize(): boolean {
    const token = this.getToken();
    if (token) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;

      // Check if we need to schedule a refresh
      const expiry = localStorage.getItem(AuthService.TOKEN_EXPIRY_KEY);
      if (expiry) {
        const expiryTime = parseInt(expiry);
        const now = Date.now();
        const timeUntilExpiry = expiryTime - now;

        if (timeUntilExpiry > 0) {
          // Convert back to seconds for scheduling
          this.scheduleTokenRefresh(timeUntilExpiry / 1000);
        }
      }

      return true;
    }
    return false;
  }

  /**
   * Schedule automatic token refresh before expiration
   */
  private scheduleTokenRefresh(expiresInSeconds: number): void {
    // Clear any existing timer
    this.stopTokenRefreshTimer();

    // Calculate when to refresh (5 minutes before expiration, or 10% of token lifetime, whichever is smaller)
    const fiveMinutesInSeconds = 5 * 60;
    const tenPercentOfLifetime = expiresInSeconds * 0.1;
    const bufferTime = Math.min(fiveMinutesInSeconds, tenPercentOfLifetime);
    const refreshTime = Math.max((expiresInSeconds - bufferTime) * 1000, 0);

    console.log(
      `Token expires in ${expiresInSeconds} seconds, scheduling refresh in ${refreshTime / 1000} seconds`
    );

    if (refreshTime > 0) {
      this.refreshTimer = setTimeout(async () => {
        console.log('Proactively refreshing token...');
        const newToken = await this.refreshToken();
        if (!newToken) {
          console.error('Proactive token refresh failed');
          // Token refresh failed, user will need to re-authenticate
          // The axios interceptor will handle this when the next API call fails
        } else {
          console.log('Token refreshed successfully');
        }
      }, refreshTime);
    }
  }

  /**
   * Stop the token refresh timer
   */
  private stopTokenRefreshTimer(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * Get time until token expiration in milliseconds
   */
  getTimeUntilExpiration(): number | null {
    const expiry = localStorage.getItem(AuthService.TOKEN_EXPIRY_KEY);
    if (!expiry) {
      return null;
    }

    const expiryTime = parseInt(expiry);
    const now = Date.now();
    return Math.max(expiryTime - now, 0);
  }

  /**
   * Debug token information
   */
  debugToken(): void {
    const token = this.getToken();
    if (!token) {
      console.log('No valid token available');
      return;
    }

    try {
      // Decode JWT token payload (without verification - just for debugging)
      const parts = token.split('.');
      if (parts.length !== 3) {
        console.error('Invalid JWT format');
        return;
      }

      const payload = JSON.parse(atob(parts[1]));
      console.log('Token Debug Info:');
      console.log('- Client ID (sub):', payload.sub);
      console.log('- Permissions:', payload.permissions);
      console.log('- Issued at:', payload.iat ? new Date(payload.iat * 1000) : 'Not set');
      console.log('- Expires at:', payload.exp ? new Date(payload.exp * 1000) : 'Not set');
      console.log('- Time until expiry:', this.getTimeUntilExpiration(), 'ms');
    } catch (error) {
      console.error('Failed to decode token:', error);
    }
  }
}

const authService = new AuthService();
export default authService;
