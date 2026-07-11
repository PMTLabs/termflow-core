import * as jwt from 'jsonwebtoken';
import { createHash } from 'crypto';

export interface TokenPayload {
  sub: string; // Subject (user/client ID)
  permissions: string[];
  exp?: number; // Expiration time
  iat?: number; // Issued at
}

export interface AuthConfig {
  jwtSecret: string;
  tokenExpiration?: string; // e.g., '1h', '7d'
  refreshTokenExpiration?: string;
}

export class AuthManager {
  private config: AuthConfig;

  constructor(config: AuthConfig) {
    this.config = {
      tokenExpiration: '1h',
      refreshTokenExpiration: '7d',
      ...config,
    };
  }

  /**
   * Generate an access token
   */
  generateToken(clientId: string, permissions: string[] = []): string {
    const payload: TokenPayload = {
      sub: clientId,
      permissions,
    };

    return jwt.sign(payload, this.config.jwtSecret, {
      expiresIn: this.config.tokenExpiration,
    } as jwt.SignOptions);
  }

  /**
   * Generate a refresh token
   */
  generateRefreshToken(clientId: string): string {
    return jwt.sign(
      { sub: clientId, type: 'refresh' },
      this.config.jwtSecret,
      { expiresIn: this.config.refreshTokenExpiration } as jwt.SignOptions
    );
  }

  /**
   * Verify and decode a token
   */
  verifyToken(token: string): TokenPayload | null {
    try {    
      
      // jwt.verify automatically checks expiration if exp claim exists
      const decoded = jwt.verify(token, this.config.jwtSecret, {
        clockTolerance: 0 // No tolerance for expiration
      }) as any;      
      
      return {
        sub: decoded.sub,
        permissions: decoded.permissions || [],
        exp: decoded.exp,
        iat: decoded.iat,
      };
    } catch (error: any) {
      console.log(`❌ AuthManager: Token verification failed`);
      console.log(`❌ AuthManager: Error type: ${error.name}`);
      console.log(`❌ AuthManager: Error message: ${error.message}`);
      console.log(`❌ AuthManager: JWT Secret used: ${this.config.jwtSecret?.substring(0, 10)}...`);
      
      if (error.name === 'TokenExpiredError') {
        console.error('Token expired:', error.message);
      } else if (error.name === 'JsonWebTokenError') {
        console.error('Invalid token:', error.message);
      } else if (error.name === 'NotBeforeError') {
        console.error('Token not active yet:', error.message);
      } else {
        console.error('Token verification error:', error);
      }
      return null;
    }
  }

  /**
   * Generate an API key (for long-lived access)
   */
  generateAPIKey(clientId: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    const hash = createHash('sha256')
      .update(`${clientId}-${timestamp}-${random}`)
      .digest('hex');
    
    return `atk_${hash}`; // atk = auto-terminal key
  }

  /**
   * Hash a password (for user authentication if needed)
   */
  hashPassword(password: string, salt?: string): string {
    // Generate salt if not provided
    const passwordSalt = salt || createHash('sha256')
      .update(Date.now().toString() + Math.random().toString())
      .digest('hex')
      .substring(0, 16);
    
    // Hash password with salt
    const hash = createHash('sha256')
      .update(password + passwordSalt)
      .digest('hex');
    
    // Return salt:hash format if no salt was provided
    return salt ? hash : `${passwordSalt}:${hash}`;
  }

  /**
   * Verify a password
   */
  verifyPassword(password: string, storedHash: string): boolean {
    // Check if stored hash includes salt
    if (storedHash.includes(':')) {
      const [salt, hash] = storedHash.split(':');
      return this.hashPassword(password, salt) === hash;
    }
    // Legacy format without salt (for backward compatibility)
    return createHash('sha256').update(password).digest('hex') === storedHash;
  }

  /**
   * Check if a token has specific permission
   */
  hasPermission(token: string, requiredPermission: string): boolean {
    const payload = this.verifyToken(token);
    if (!payload) return false;

    return payload.permissions.includes(requiredPermission) ||
           payload.permissions.includes('*');
  }

  /**
   * Create a limited token for specific operations
   */
  createScopedToken(
    clientId: string, 
    scopes: string[], 
    duration: string = '15m'
  ): string {
    return jwt.sign(
      {
        sub: clientId,
        permissions: scopes,
        type: 'scoped',
      },
      this.config.jwtSecret,
      { expiresIn: duration } as jwt.SignOptions
    );
  }

  /**
   * Generate scoped token (alias for createScopedToken)
   */
  generateScopedToken(
    clientId: string,
    scopes: string[],
    duration: string = '15m'
  ): string {
    return this.createScopedToken(clientId, scopes, duration);
  }

  /**
   * Generate API key (alias for generateAPIKey)
   */
  generateApiKey(clientId: string): string {
    return this.generateAPIKey(clientId);
  }
}

// Default permissions
export const Permissions = {
  // Terminal operations
  TERMINAL_CREATE: 'terminal.create',
  TERMINAL_READ: 'terminal.read',
  TERMINAL_WRITE: 'terminal.write',
  TERMINAL_DELETE: 'terminal.delete',
  
  // Process operations
  PROCESS_KILL: 'process.kill',
  PROCESS_MONITOR: 'process.monitor',
  
  // System operations
  SYSTEM_INFO: 'system.info',
  SYSTEM_PROFILES: 'system.profiles',
  
  // Event operations
  EVENT_SUBSCRIBE: 'event.subscribe',
  EVENT_HISTORY: 'event.history',
  
  // Admin operations
  ADMIN_ALL: '*',
};

// Example permission sets
export const PermissionSets = {
  readonly: [
    Permissions.TERMINAL_READ,
    Permissions.SYSTEM_INFO,
    Permissions.EVENT_SUBSCRIBE,
  ],
  
  standard: [
    Permissions.TERMINAL_CREATE,
    Permissions.TERMINAL_READ,
    Permissions.TERMINAL_WRITE,
    Permissions.TERMINAL_DELETE,
    Permissions.PROCESS_MONITOR,
    Permissions.SYSTEM_INFO,
    Permissions.SYSTEM_PROFILES,
    Permissions.EVENT_SUBSCRIBE,
    Permissions.EVENT_HISTORY,
  ],
  
  admin: [Permissions.ADMIN_ALL],
};

// Middleware for Express routes
export function authMiddleware(authManager: AuthManager, requiredPermission?: string) {
  return (req: any, res: any, next: any) => {
    const token = req.headers.authorization?.split(' ')[1] || req.query.token;

    if (!token) {
      return res.status(401).json({ error: 'Missing authentication token' });
    }

    const payload = authManager.verifyToken(token);
    if (!payload) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    if (requiredPermission && !authManager.hasPermission(token, requiredPermission)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }

    req.user = payload;
    next();
  };
}