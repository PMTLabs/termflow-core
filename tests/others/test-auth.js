"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const auth_1 = require("./auth");
// Test auth functionality
function testAuth() {
    console.log('Testing Auth System...\n');
    const authManager = new auth_1.AuthManager({
        jwtSecret: 'test-secret'
    });
    // Test 1: Generate tokens with different permissions
    console.log('=== Test 1: Token Generation ===');
    const adminToken = authManager.generateToken('admin', ['*']);
    const userToken = authManager.generateToken('user', ['terminal.read', 'terminal.write']);
    const limitedToken = authManager.generateToken('limited', ['terminal.read']);
    console.log('Admin token generated:', adminToken.substring(0, 20) + '...');
    console.log('User token generated:', userToken.substring(0, 20) + '...');
    console.log('Limited token generated:', limitedToken.substring(0, 20) + '...\n');
    // Test 2: Verify tokens
    console.log('=== Test 2: Token Verification ===');
    const adminPayload = authManager.verifyToken(adminToken);
    const userPayload = authManager.verifyToken(userToken);
    console.log('Admin payload:', adminPayload);
    console.log('User payload:', userPayload);
    console.log('Invalid token test:', authManager.verifyToken('invalid-token'));
    console.log();
    // Test 3: Permission checking with wildcards
    console.log('=== Test 3: Permission Checking (Wildcard) ===');
    console.log('Admin has terminal.create?', authManager.hasPermission(adminToken, 'terminal.create'));
    console.log('Admin has terminal.delete?', authManager.hasPermission(adminToken, 'terminal.delete'));
    console.log('Admin has random.permission?', authManager.hasPermission(adminToken, 'random.permission'));
    console.log('Admin permissions:', adminPayload?.permissions);
    console.log();
    // Test 4: Regular permission checking
    console.log('=== Test 4: Regular Permission Checking ===');
    console.log('User has terminal.read?', authManager.hasPermission(userToken, 'terminal.read'));
    console.log('User has terminal.write?', authManager.hasPermission(userToken, 'terminal.write'));
    console.log('User has terminal.delete?', authManager.hasPermission(userToken, 'terminal.delete'));
    console.log();
    // Test 5: Expired token
    console.log('=== Test 5: Expired Token ===');
    // Manually create an expired token for testing
    const jwt = require('jsonwebtoken');
    const expiredTokenManual = jwt.sign({ sub: 'expired', permissions: ['terminal.read'] }, 'test-secret', { expiresIn: '-1h' } // Already expired
    );
    console.log('Verifying expired token:', authManager.verifyToken(expiredTokenManual));
    console.log();
    // Test 6: Password hashing
    console.log('=== Test 6: Password Hashing ===');
    const password = 'mySecurePassword123';
    const hash1 = authManager.hashPassword(password);
    const hash2 = authManager.hashPassword(password);
    console.log('Hash 1:', hash1);
    console.log('Hash 2:', hash2);
    console.log('Hashes are different (salt working)?', hash1 !== hash2);
    console.log('Password verification 1:', authManager.verifyPassword(password, hash1));
    console.log('Password verification 2:', authManager.verifyPassword(password, hash2));
    console.log('Wrong password test:', authManager.verifyPassword('wrongpassword', hash1));
    console.log();
    // Test 7: API methods
    console.log('=== Test 7: API Methods ===');
    const scopedToken = authManager.generateScopedToken('test', ['terminal.read'], '5m');
    const apiKey = authManager.generateApiKey('test-client');
    console.log('Scoped token:', scopedToken.substring(0, 20) + '...');
    console.log('API key:', apiKey);
    console.log('\nAll tests completed!');
}
// Run tests
testAuth();
