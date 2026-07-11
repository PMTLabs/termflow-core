import { AuthManager } from '../auth';

describe('AuthManager', () => {
  let authManager: AuthManager;

  beforeEach(() => {
    authManager = new AuthManager({ jwtSecret: 'test-secret' });
  });

  describe('Token Generation', () => {
    it('should generate valid JWT tokens', () => {
      const token = authManager.generateToken('testuser', ['terminal.read']);
      expect(token).toBeDefined();
      expect(typeof token).toBe('string');
      expect(token.split('.')).toHaveLength(3); // JWT has 3 parts
    });

    it('should generate unique tokens', () => {
      const token1 = authManager.generateToken('user1', ['*']);
      const token2 = authManager.generateToken('user2', ['*']);
      expect(token1).not.toBe(token2);
    });
  });

  describe('Token Verification', () => {
    it('should verify valid tokens', () => {
      const token = authManager.generateToken('testuser', ['terminal.read', 'terminal.write']);
      const payload = authManager.verifyToken(token);
      
      expect(payload).toBeDefined();
      expect(payload?.sub).toBe('testuser');
      expect(payload?.permissions).toEqual(['terminal.read', 'terminal.write']);
    });

    it('should reject invalid tokens', () => {
      const invalidToken = 'invalid.token.here';
      const payload = authManager.verifyToken(invalidToken);
      expect(payload).toBeNull();
    });

    it('should reject expired tokens', async () => {
      // Create auth manager with very short token expiration
      const shortAuthManager = new AuthManager({ 
        jwtSecret: 'test-secret',
        tokenExpiration: '1ms' // Very short expiration
      });
      
      const expiredToken = shortAuthManager.generateToken('testuser', ['*']);
      
      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const payload = shortAuthManager.verifyToken(expiredToken);
      expect(payload).toBeNull();
    });
  });

  describe('Permission System', () => {
    it('should grant wildcard permissions', () => {
      const token = authManager.generateToken('admin', ['*']);
      
      expect(authManager.hasPermission(token, 'terminal.read')).toBe(true);
      expect(authManager.hasPermission(token, 'terminal.write')).toBe(true);
      expect(authManager.hasPermission(token, 'system.admin')).toBe(true);
      expect(authManager.hasPermission(token, 'any.custom.permission')).toBe(true);
    });

    it('should enforce specific permissions', () => {
      const token = authManager.generateToken('user', ['terminal.read']);
      
      expect(authManager.hasPermission(token, 'terminal.read')).toBe(true);
      expect(authManager.hasPermission(token, 'terminal.write')).toBe(false);
      expect(authManager.hasPermission(token, 'system.admin')).toBe(false);
    });

    it('should handle empty permissions', () => {
      const token = authManager.generateToken('user', []);
      
      expect(authManager.hasPermission(token, 'terminal.read')).toBe(false);
      expect(authManager.hasPermission(token, 'terminal.write')).toBe(false);
    });
  });

  describe('Scoped Tokens', () => {
    it('should generate scoped tokens', () => {
      const scopedToken = authManager.generateScopedToken('user', ['terminal.read'], '1h');
      
      expect(scopedToken).toBeDefined();
      expect(typeof scopedToken).toBe('string');
      
      const payload = authManager.verifyToken(scopedToken);
      expect(payload?.sub).toBe('user');
      expect(payload?.permissions).toEqual(['terminal.read']);
    });
  });

  describe('API Keys', () => {
    it('should generate API keys', () => {
      const apiKey = authManager.generateApiKey('test-client');
      expect(apiKey).toBeDefined();
      expect(typeof apiKey).toBe('string');
      expect(apiKey.length).toBeGreaterThan(30);
      expect(apiKey.startsWith('atk_')).toBe(true);
    });

    it('should generate unique API keys', () => {
      const key1 = authManager.generateApiKey('client1');
      const key2 = authManager.generateApiKey('client2');
      expect(key1).not.toBe(key2);
    });
  });

  describe('Password Hashing', () => {
    it('should hash passwords with salt', () => {
      const password = 'testpassword123';
      const hash1 = authManager.hashPassword(password);
      const hash2 = authManager.hashPassword(password);
      
      // Different hashes = salt is being used
      expect(hash1).not.toBe(hash2);
      expect(hash1.length).toBeGreaterThan(50);
      expect(hash2.length).toBeGreaterThan(50);
      expect(hash1.includes(':')).toBe(true); // salt:hash format
      expect(hash2.includes(':')).toBe(true);
    });

    it('should verify passwords correctly', () => {
      const password = 'testpassword123';
      const hash = authManager.hashPassword(password);
      
      const isValid = authManager.verifyPassword(password, hash);
      expect(isValid).toBe(true);
      
      const isInvalid = authManager.verifyPassword('wrongpassword', hash);
      expect(isInvalid).toBe(false);
    });
  });
});