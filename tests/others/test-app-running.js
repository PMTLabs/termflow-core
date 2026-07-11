// Quick test to see if app is running
const http = require('http');

const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/api/health',
  method: 'GET'
};

const req = http.request(options, (res) => {
  console.log(`API Server Status: ${res.statusCode}`);
  if (res.statusCode === 200) {
    console.log('App is running!');
  } else {
    console.log('App is not accessible');
  }
  process.exit(0);
});

req.on('error', (err) => {
  console.log('App is not running:', err.message);
  process.exit(1);
});

req.end();