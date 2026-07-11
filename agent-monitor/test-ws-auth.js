/**
 * Test WebSocket authentication
 */

const WebSocket = require('ws');
require('dotenv').config();

const token = process.env.API_TOKEN;
const wsUrl = process.env.WS_URL || 'ws://localhost:9876';

console.log('Testing WebSocket authentication...');
console.log('Token:', token ? `${token.substring(0, 20)}...` : 'NOT SET');
console.log('URL:', wsUrl);

// Test 1: Try with token in URL
const wsUrlWithToken = new URL(wsUrl);
wsUrlWithToken.searchParams.set('token', token);

console.log('\nTest 1: Token in URL');
const ws1 = new WebSocket(wsUrlWithToken.toString());

ws1.on('open', () => {
  console.log('✅ Connected successfully with token in URL!');
  ws1.close();
});

ws1.on('error', (error) => {
  console.log('❌ Failed with token in URL:', error.message);
});

ws1.on('unexpected-response', (req, res) => {
  console.log('❌ Unexpected response:', res.statusCode, res.statusMessage);
});

// Test 2: Try with Authorization header
setTimeout(() => {
  console.log('\nTest 2: Token in Authorization header');
  const ws2 = new WebSocket(wsUrl, {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  ws2.on('open', () => {
    console.log('✅ Connected successfully with Authorization header!');
    ws2.close();
  });

  ws2.on('error', (error) => {
    console.log('❌ Failed with Authorization header:', error.message);
  });

  ws2.on('unexpected-response', (req, res) => {
    console.log('❌ Unexpected response:', res.statusCode, res.statusMessage);
  });
}, 1000);