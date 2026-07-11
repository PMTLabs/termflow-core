const http = require('http');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwicGVybWlzc2lvbnMiOlsiKiJdLCJpYXQiOjE3NTI5ODg1MjQsImV4cCI6MTc1Mjk5MjEyNH0.BioEmvKhHmw-e7CRGM7w6GOOpldixyU3zGhbRw56IJU';

function makeRequest(path, method = 'GET', data = null) {
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
        console.log(`\n${method} ${path}:`);
        console.log(`Status: ${res.statusCode}`);
        try {
          const data = JSON.parse(body);
          console.log('Response:', JSON.stringify(data, null, 2));
          resolve({ status: res.statusCode, data });
        } catch (e) {
          console.log('Response:', body);
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
  console.log('Testing Terminal Names in API...\n');
  console.log('Please ensure you have created some terminals in the UI with custom names.\n');
  
  try {
    // 1. Get all terminals
    const terminals = await makeRequest('/api/terminals');
    
    if (terminals.data && terminals.data.length > 0) {
      console.log('\nFound terminals with names:');
      terminals.data.forEach((t, i) => {
        console.log(`${i + 1}. Name: "${t.name}", ID: ${t.id.substring(0, 8)}...`);
      });
      
      // 2. Get details of first terminal
      const firstTerminal = terminals.data[0];
      await makeRequest(`/api/terminals/${firstTerminal.id}`);
      
      // 3. Create a new terminal with a custom name
      console.log('\nCreating new terminal with name "API Test Terminal"...');
      const newTerminal = await makeRequest('/api/terminals', 'POST', {
        name: 'API Test Terminal',
        profile: 'cmd'
      });
      
      if (newTerminal.status === 201) {
        console.log(`\nCreated terminal: ${newTerminal.data.name} (${newTerminal.data.id})`);
      }
    } else {
      console.log('\nNo terminals found. Please create some terminals in the UI first.');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();