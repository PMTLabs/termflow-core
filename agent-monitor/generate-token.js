#!/usr/bin/env node

// Generate a valid JWT token for testing
const jwt = require('jsonwebtoken');

// Use a simple test secret
const jwtSecret = 'test-secret-key';

// Create token payload
const payload = {
  sub: 'agent-monitor',
  permissions: ['*'], // All permissions
  iat: Math.floor(Date.now() / 1000),
  exp: Math.floor(Date.now() / 1000) + (30 * 24 * 60 * 60) // 30 days
};

// Generate token
const token = jwt.sign(payload, jwtSecret);

console.log('Generated JWT Token:');
console.log(token);
console.log('\nPayload:', payload);
console.log('\nAdd this to your .env file:');
console.log(`API_TOKEN=${token}`);