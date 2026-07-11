const http = require('http');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwicGVybWlzc2lvbnMiOlsiKiJdLCJpYXQiOjE3NTI5ODg1MjQsImV4cCI6MTc1Mjk5MjEyNH0.BioEmvKhHmw-e7CRGM7w6GOOpldixyU3zGhbRw56IJU';

function makeRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3001,
      path: path,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        console.log(`\n${path}:`);
        console.log(`Status: ${res.statusCode}`);
        try {
          const data = JSON.parse(body);
          console.log('Response:', JSON.stringify(data, null, 2));
          resolve(data);
        } catch (e) {
          console.log('Response:', body);
          resolve(body);
        }
      });
    });

    req.on('error', reject);
    req.end();
  });
}

async function test() {
  console.log('Testing Embedded API...\n');
  
  // Get terminals
  const terminals = await makeRequest('/api/terminals');
  
  if (Array.isArray(terminals) && terminals.length > 0) {
    const terminalId = terminals[0].id;
    console.log(`\nFound terminal: ${terminalId}`);
    
    // Try to get specific terminal
    await makeRequest(`/api/terminals/${terminalId}`);
    
    // Try to send input
    const inputReq = http.request({
      hostname: 'localhost',
      port: 3001,
      path: `/api/terminals/${terminalId}/input`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }, (res) => {
      console.log(`\n/api/terminals/${terminalId}/input:`);
      console.log(`Status: ${res.statusCode}`);
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (body) console.log('Response:', body);
      });
    });
    
    inputReq.write(JSON.stringify({ data: 'echo "Test from API"\r\n' }));
    inputReq.end();
  }
}

test().catch(console.error);