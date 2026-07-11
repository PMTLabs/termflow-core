const axios = require('axios');

// Use the token from the API server console
const TOKEN = process.argv[2] || 'YOUR_TOKEN_HERE';

const api = axios.create({
  baseURL: 'http://localhost:3001',
  headers: {
    'Authorization': `Bearer ${TOKEN}`,
    'Content-Type': 'application/json'
  }
});

async function testAPI() {
  try {
    console.log('Testing Auto-Terminal API...\n');
    
    // 1. Check health
    const health = await api.get('/api/health');
    console.log('1. Health check:', health.data);
    
    // 2. List terminals
    const terminals = await api.get('/api/terminals');
    console.log('\n2. Current terminals:', terminals.data);
    
    // 3. List shell profiles
    const profiles = await api.get('/api/profiles');
    console.log('\n3. Available shell profiles:', profiles.data);
    
    // 4. Create a new terminal via API
    console.log('\n4. Creating new terminal via API...');
    const newTerminal = await api.post('/api/terminals', {
      profile: 'cmd',
      cols: 120,
      rows: 30
    });
    console.log('Created terminal:', newTerminal.data);
    
    // 5. List terminals again
    const terminalsAfter = await api.get('/api/terminals');
    console.log('\n5. Terminals after creation:', terminalsAfter.data);
    
    // 6. Send a command
    if (newTerminal.data.id) {
      console.log('\n6. Sending command to terminal...');
      await api.post(`/api/terminals/${newTerminal.data.id}/input`, {
        data: 'echo Hello from API!\r\n'
      });
      console.log('Command sent');
      
      // 7. Get output
      await new Promise(resolve => setTimeout(resolve, 1000));
      const output = await api.get(`/api/terminals/${newTerminal.data.id}/output`);
      console.log('\n7. Terminal output:', output.data);
      
      // 8. Close terminal
      console.log('\n8. Closing terminal...');
      await api.delete(`/api/terminals/${newTerminal.data.id}`);
      console.log('Terminal closed');
    }
    
  } catch (error) {
    console.error('\nError:', error.response?.data || error.message);
    if (error.response?.status === 401) {
      console.log('\nPlease provide a valid token as argument:');
      console.log('node test-api-terminals.js YOUR_JWT_TOKEN');
    }
  }
}

console.log('Usage: node test-api-terminals.js YOUR_JWT_TOKEN');
console.log('Get the token from the API server console output\n');

if (TOKEN === 'YOUR_TOKEN_HERE') {
  console.log('ERROR: Please provide a JWT token as argument');
  process.exit(1);
}

testAPI();