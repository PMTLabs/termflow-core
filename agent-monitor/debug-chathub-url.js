#!/usr/bin/env node

// Debug ChatHub URL issue
require('dotenv').config();

console.log('🔍 Debugging ChatHub URL...\n');

console.log('Environment variables:');
console.log('CHATHUB_WS_URL:', process.env.CHATHUB_WS_URL);
console.log('CHATHUB_BASE_URL:', process.env.CHATHUB_BASE_URL);
console.log('CHATHUB_HTTP_URL:', process.env.CHATHUB_HTTP_URL);

console.log('\nDefault fallback would be: ws://localhost:8080');
console.log('Actual value used:', process.env.CHATHUB_WS_URL || 'ws://localhost:8080');

console.log('\n💡 To fix, run with --chathub-url flag:');
console.log('node dist/team-manager.js start team-config.json --chathub-url wss://localhost:5001');