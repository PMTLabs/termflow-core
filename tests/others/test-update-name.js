const http = require('http');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwicGVybWlzc2lvbnMiOlsiKiJdLCJpYXQiOjE3NTI5ODg1MjQsImV4cCI6MTc1Mjk5MjEyNH0.BioEmvKhHmw-e7CRGM7w6GOOpldixyU3zGhbRw56IJU';

async function makeRequest(path, method = 'GET', data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3001,
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        try {
          const data = JSON.parse(body);
          resolve({ status: res.statusCode, data });
        } catch (e) {
          resolve({ status: res.statusCode, data: body });
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

async function test() {
  console.log('Testing name update flow...\n');
  
  // 1. Get terminals
  const result = await makeRequest('/api/terminals');
  console.log('Current terminals:');
  result.data.forEach(t => {
    console.log(`- ${t.name} (${t.id})`);
  });
  
  // 2. Wait and check again
  console.log('\nPlease rename a terminal in the UI now...');
  console.log('Waiting 10 seconds...');
  
  await new Promise(resolve => setTimeout(resolve, 10000));
  
  // 3. Check again
  const result2 = await makeRequest('/api/terminals');
  console.log('\nTerminals after rename:');
  result2.data.forEach(t => {
    console.log(`- ${t.name} (${t.id})`);
  });
  
  // 4. Check registry file
  const fs = require('fs');
  const path = require('path');
  const registryPath = path.join(process.env.APPDATA, 'auto-terminal', 'terminal-registry.json');
  
  if (fs.existsSync(registryPath)) {
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    console.log('\nTerminal Registry:');
    registry.terminals.forEach(t => {
      console.log(`- ${t.name} (${t.id})`);
    });
  }
}

test().catch(console.error);