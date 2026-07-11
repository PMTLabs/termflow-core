// Test script for direct API access to Auto-Terminal
// This connects directly to the Electron app's embedded API

const http = require('http');

// The embedded API runs on port 3001 inside the Electron app
const API_PORT = 3001;

// Simple bearer token (in production, use proper JWT)
const TOKEN = 'Bearer test-token';

function makeRequest(path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: API_PORT,
      path: path,
      method: method,
      headers: {
        'Authorization': TOKEN,
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const result = {
            status: res.statusCode,
            data: JSON.parse(body)
          };
          resolve(result);
        } catch (e) {
          resolve({
            status: res.statusCode,
            data: body
          });
        }
      });
    });

    req.on('error', reject);

    if (data) {
      req.write(JSON.stringify(data));
    }

    req.end();
  });
}

async function testDirectAPI() {
  console.log('Testing Direct API Access to Auto-Terminal\n');
  console.log('This connects directly to the Electron app without intermediate files.');
  console.log(`API endpoint: http://localhost:${API_PORT}\n`);

  try {
    // Test 1: Get terminals
    console.log('1. Getting terminals from Electron app...');
    const terminals = await makeRequest('/api/terminals');
    console.log(`   Status: ${terminals.status}`);
    console.log(`   Terminals found: ${terminals.data.length || 0}`);
    
    if (terminals.data && terminals.data.length > 0) {
      console.log('\n   Terminal details:');
      terminals.data.forEach((t, i) => {
        console.log(`   [${i + 1}] ID: ${t.id}`);
        console.log(`       PID: ${t.pid}`);
        console.log(`       Shell: ${t.profile}`);
        console.log(`       Created: ${t.createdAt}`);
        console.log('');
      });

      // Test 2: Send command to first terminal
      const firstTerminal = terminals.data[0];
      console.log(`2. Sending command to terminal ${firstTerminal.id.substring(0, 8)}...`);
      
      const input = await makeRequest(
        `/api/terminals/${firstTerminal.id}/input`,
        'POST',
        { data: 'echo "Hello from Direct API!"\r\n' }
      );
      
      console.log(`   Status: ${input.status}`);
      console.log(`   Response:`, input.data);
    }

  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Alternative: Direct connection to port 3002 (if directAPI is working)
async function testPort3002() {
  console.log('\n\nTesting simplified Direct API on port 3002...');
  
  const options = {
    hostname: 'localhost',
    port: 3002,
    path: '/terminals',
    method: 'GET',
    headers: {
      'Authorization': 'Bearer any-token'
    }
  };

  const req = http.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log(`Status: ${res.statusCode}`);
      console.log('Response:', body);
    });
  });

  req.on('error', (err) => {
    console.log('Port 3002 not available:', err.message);
  });

  req.end();
}

// Run tests
testDirectAPI();
setTimeout(() => testPort3002(), 2000);