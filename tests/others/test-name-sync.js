const http = require('http');
const fs = require('fs');
const path = require('path');

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
  console.log('Terminal Name Synchronization Test\n');
  console.log('This test verifies that terminal names are properly synchronized between UI and API.\n');
  
  try {
    // 1. Check initial terminals
    console.log('1. Getting current terminals...');
    const result = await makeRequest('/api/terminals');
    
    if (result.data && result.data.length > 0) {
      console.log('\nCurrent terminals:');
      result.data.forEach((t, i) => {
        console.log(`   ${i + 1}. "${t.name}" (ID: ${t.id.substring(0, 8)}..., PID: ${t.pid})`);
      });
      
      // 2. Check terminal registry
      const registryPath = path.join(process.env.APPDATA, 'auto-terminal', 'terminal-registry.json');
      if (fs.existsSync(registryPath)) {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        console.log('\n2. Terminal Registry contains:');
        registry.terminals.forEach((t, i) => {
          console.log(`   ${i + 1}. "${t.name}" (ID: ${t.id.substring(0, 8)}...)`);
        });
      }
      
      // 3. Instructions for testing
      console.log('\n3. To test name synchronization:');
      console.log('   a) Rename a terminal in the UI (right-click on tab or pane header)');
      console.log('   b) Run this script again to see if the name is updated');
      console.log('   c) Check the console for any error messages');
      
      // 4. Get detailed info for first terminal
      if (result.data.length > 0) {
        const firstId = result.data[0].id;
        console.log(`\n4. Getting details for terminal ${firstId.substring(0, 8)}...`);
        const details = await makeRequest(`/api/terminals/${firstId}`);
        if (details.status === 200) {
          console.log('   Terminal details:');
          console.log(`   - Name: "${details.data.name}"`);
          console.log(`   - Process ID: ${details.data.processId}`);
          console.log(`   - Shell: ${details.data.profile}`);
          console.log(`   - Created: ${details.data.createdAt}`);
        } else {
          console.log('   Error getting terminal details:', details.data);
        }
      }
    } else {
      console.log('\nNo terminals found. Please create some terminals in the UI first.');
      console.log('Then rename them to test the synchronization.');
    }
  } catch (error) {
    console.error('\nError:', error.message);
    console.log('\nMake sure the Auto-Terminal app is running (npm run dev)');
  }
}

test();