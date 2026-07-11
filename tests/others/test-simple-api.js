const http = require('http');

// Test DirectAPI on port 3002 with simple auth
const options = {
  hostname: 'localhost',
  port: 3002,
  path: '/terminals',
  method: 'GET',
  headers: {
    'Authorization': 'Bearer test'
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    console.log(`Status: ${res.statusCode}`);
    console.log('Response:', body);
    
    try {
      const data = JSON.parse(body);
      if (data.terminals && data.terminals.length > 0) {
        const terminalId = data.terminals[0].id;
        console.log(`\nTesting GET /terminals/${terminalId}...`);
        
        // Test getting specific terminal
        const options2 = {
          hostname: 'localhost',
          port: 3002,
          path: `/terminals/${terminalId}`,
          method: 'GET',
          headers: {
            'Authorization': 'Bearer test'
          }
        };
        
        const req2 = http.request(options2, (res2) => {
          let body2 = '';
          res2.on('data', chunk => body2 += chunk);
          res2.on('end', () => {
            console.log(`Status: ${res2.statusCode}`);
            console.log('Response:', body2);
          });
        });
        
        req2.on('error', (err) => {
          console.error('Error:', err.message);
        });
        
        req2.end();
      }
    } catch (e) {
      // Not JSON
    }
  });
});

req.on('error', (err) => {
  console.error('DirectAPI not available:', err.message);
  console.log('\nTrying embedded API on port 3001...');
  
  // Try embedded API
  const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwicGVybWlzc2lvbnMiOlsiKiJdLCJpYXQiOjE3NTI5ODg1MjQsImV4cCI6MTc1Mjk5MjEyNH0.BioEmvKhHmw-e7CRGM7w6GOOpldixyU3zGhbRw56IJU';
  
  const embeddedOptions = {
    hostname: 'localhost',
    port: 3001,
    path: '/api/terminals',
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  };
  
  const embeddedReq = http.request(embeddedOptions, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
      console.log(`Status: ${res.statusCode}`);
      console.log('Response:', body);
    });
  });
  
  embeddedReq.on('error', console.error);
  embeddedReq.end();
});

req.end();