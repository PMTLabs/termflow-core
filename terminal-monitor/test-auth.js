const axios = require('axios');

const API_URL = 'http://localhost:3001';

async function testAuth() {
  console.log('Testing Auto-Terminal Authentication...\n');

  try {
    // Step 1: Request a JWT token
    console.log('1. Requesting JWT token...');
    const tokenResponse = await axios.post(`${API_URL}/api/auth/token`, {
      clientId: 'terminal-monitor-test',
      permissions: ['terminals.read', 'terminals.write', 'terminals.delete']
    });

    const { token, expiresIn, permissions } = tokenResponse.data;
    console.log('✅ Token received successfully');
    console.log(`   - Token: ${token.substring(0, 50)}...`);
    console.log(`   - Expires in: ${expiresIn}`);
    console.log(`   - Permissions: ${permissions.join(', ')}\n`);

    // Step 2: Test authenticated API call
    console.log('2. Testing authenticated API call...');
    const terminalsResponse = await axios.get(`${API_URL}/api/terminals`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    console.log('✅ Authenticated API call successful');
    console.log(`   - Found ${terminalsResponse.data.terminals.length} terminals\n`);

    // Step 3: Test WebSocket connection
    console.log('3. Testing WebSocket connection...');
    const io = require('socket.io-client');
    const socket = io('ws://localhost:9876', {
      auth: {
        token: token
      }
    });

    socket.on('connect', () => {
      console.log('✅ WebSocket connected successfully\n');
      
      console.log('All authentication tests passed! ✨');
      process.exit(0);
    });

    socket.on('connect_error', (error) => {
      console.error('❌ WebSocket connection failed:', error.message);
      process.exit(1);
    });

    setTimeout(() => {
      console.error('❌ WebSocket connection timeout');
      process.exit(1);
    }, 5000);

  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    process.exit(1);
  }
}

// Check if Auto-Terminal is running
axios.get(`${API_URL}/api/health`)
  .then(() => {
    console.log('Auto-Terminal API is running at', API_URL);
    testAuth();
  })
  .catch(() => {
    console.error(`
❌ Auto-Terminal API is not running at ${API_URL}

Please start Auto-Terminal with:
  npm run start -- --enable-api

Or in development mode:
  npm run dev
`);
    process.exit(1);
  });