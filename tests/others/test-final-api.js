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
  console.log('Testing Embedded API (Final Test)...\n');
  
  try {
    // 1. Get terminals
    const terminals = await makeRequest('/api/terminals');
    
    if (terminals.data && terminals.data.length > 0) {
      const terminalId = terminals.data[0].id;
      
      // 2. Get specific terminal details
      await makeRequest(`/api/terminals/${terminalId}`);
      
      // 3. Send input to terminal
      await makeRequest(`/api/terminals/${terminalId}/input`, 'POST', {
        data: 'echo "Hello from API!"\r\n'
      });
      
      // 4. Resize terminal
      await makeRequest(`/api/terminals/${terminalId}/resize`, 'POST', {
        cols: 100,
        rows: 30
      });
      
      // 5. Get terminal output
      await makeRequest(`/api/terminals/${terminalId}/output`);
    } else {
      console.log('\nNo terminals found. Please create a terminal in the UI first.');
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

test();