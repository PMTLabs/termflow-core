"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.PermissionSets = exports.Permissions = exports.AuthManager = void 0;
exports.authMiddleware = authMiddleware;
const jwt = __importStar(require("jsonwebtoken"));
const crypto_1 = require("crypto");
class AuthManager {
    constructor(config) {
        this.config = {
            tokenExpiration: '1h',
            refreshTokenExpiration: '7d',
            ...config,
        };
    }
    /**
     * Generate an access token
     */
    generateToken(clientId, permissions = []) {
        const payload = {
            sub: clientId,
            permissions,
        };
        return jwt.sign(payload, this.config.jwtSecret, {
            expiresIn: this.config.tokenExpiration,
        });
    }
    /**
     * Generate a refresh token
     */
    generateRefreshToken(clientId) {
        return jwt.sign({ sub: clientId, type: 'refresh' }, this.config.jwtSecret, { expiresIn: this.config.refreshTokenExpiration });
    }
    /**
     * Verify and decode a token
     */
    verifyToken(token) {
        try {
            // jwt.verify automatically checks expiration if exp claim exists
            const decoded = jwt.verify(token, this.config.jwtSecret, {
                clockTolerance: 0 // No tolerance for expiration
            });
            return {
                sub: decoded.sub,
                permissions: decoded.permissions || [],
                exp: decoded.exp,
                iat: decoded.iat,
            };
        }
        catch (error) {
            if (error.name === 'TokenExpiredError') {
                console.error('Token expired:', error.message);
            }
            else if (error.name === 'JsonWebTokenError') {
                console.error('Invalid token:', error.message);
            }
            else if (error.name === 'NotBeforeError') {
                console.error('Token not active yet:', error.message);
            }
            else {
                console.error('Token verification error:', error);
            }
            return null;
        }
    }
    /**
     * Generate an API key (for long-lived access)
     */
    generateAPIKey(clientId) {
        const timestamp = Date.now();
        const random = Math.random().toString(36).substring(2, 15);
        const hash = (0, crypto_1.createHash)('sha256')
            .update(`${clientId}-${timestamp}-${random}`)
            .digest('hex');
        return `atk_${hash}`; // atk = auto-terminal key
    }
    /**
     * Hash a password (for user authentication if needed)
     */
    hashPassword(password, salt) {
        // Generate salt if not provided
        const passwordSalt = salt || (0, crypto_1.createHash)('sha256')
            .update(Date.now().toString() + Math.random().toString())
            .digest('hex')
            .substring(0, 16);
        // Hash password with salt
        const hash = (0, crypto_1.createHash)('sha256')
            .update(password + passwordSalt)
            .digest('hex');
        // Return salt:hash format if no salt was provided
        return salt ? hash : `${passwordSalt}:${hash}`;
    }
    /**
     * Verify a password
     */
    verifyPassword(password, storedHash) {
        // Check if stored hash includes salt
        if (storedHash.includes(':')) {
            const [salt, hash] = storedHash.split(':');
            return this.hashPassword(password, salt) === hash;
        }
        // Legacy format without salt (for backward compatibility)
        return (0, crypto_1.createHash)('sha256').update(password).digest('hex') === storedHash;
    }
    /**
     * Check if a token has specific permission
     */
    hasPermission(token, requiredPermission) {
        const payload = this.verifyToken(token);
        if (!payload)
            return false;
        return payload.permissions.includes(requiredPermission) ||
            payload.permissions.includes('*');
    }
    /**
     * Create a limited token for specific operations
     */
    createScopedToken(clientId, scopes, duration = '15m') {
        return jwt.sign({
            sub: clientId,
            permissions: scopes,
            type: 'scoped',
        }, this.config.jwtSecret, { expiresIn: duration });
    }
    /**
     * Generate scoped token (alias for createScopedToken)
     */
    generateScopedToken(clientId, scopes, duration = '15m') {
        return this.createScopedToken(clientId, scopes, duration);
    }
    /**
     * Generate API key (alias for generateAPIKey)
     */
    generateApiKey(clientId) {
        return this.generateAPIKey(clientId);
    }
}
exports.AuthManager = AuthManager;
// Default permissions
exports.Permissions = {
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
exports.PermissionSets = {
    readonly: [
        exports.Permissions.TERMINAL_READ,
        exports.Permissions.SYSTEM_INFO,
        exports.Permissions.EVENT_SUBSCRIBE,
    ],
    standard: [
        exports.Permissions.TERMINAL_CREATE,
        exports.Permissions.TERMINAL_READ,
        exports.Permissions.TERMINAL_WRITE,
        exports.Permissions.TERMINAL_DELETE,
        exports.Permissions.PROCESS_MONITOR,
        exports.Permissions.SYSTEM_INFO,
        exports.Permissions.SYSTEM_PROFILES,
        exports.Permissions.EVENT_SUBSCRIBE,
        exports.Permissions.EVENT_HISTORY,
    ],
    admin: [exports.Permissions.ADMIN_ALL],
};
// Middleware for Express routes
function authMiddleware(authManager, requiredPermission) {
    return (req, res, next) => {
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
