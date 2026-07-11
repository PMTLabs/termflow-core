const http = require('http');

function makeRequest(path) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'localhost',
      port: 3001,
      path: path,
      method: 'GET'
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
  console.log('Testing Debug API...\n');
  
  // Get debug info
  await makeRequest('/api/debug/processes');
}

test().catch(console.error);