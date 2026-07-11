// Simple test script to verify dimension error fix via API
const axios = require('axios');

const API_BASE = 'http://localhost:3001/api';
const CLIENT_ID = 'terminal-monitor';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testDimensionFix() {
  console.log('Testing Terminal Selection Dimension Fix...\n');
  
  try {
    // 1. Authenticate
    console.log('1. Authenticating...');
    const authResponse = await axios.post(`${API_BASE}/auth`, { clientId: CLIENT_ID });
    const token = authResponse.data.token;
    
    // Set auth header for subsequent requests
    const api = axios.create({
      baseURL: API_BASE,
      headers: { Authorization: `Bearer ${token}` }
    });
    
    console.log('✓ Authentication successful\n');
    
    // 2. Create terminals
    console.log('2. Creating test terminals...');
    const terminals = [];
    
    for (let i = 1; i <= 3; i++) {
      const response = await api.post('/terminals', {
        name: `Test Terminal ${i}`,
        profile: 'cmd'
      });
      terminals.push(response.data);
      console.log(`✓ Created terminal ${i}: ${response.data.id}`);
    }
    
    console.log('\n3. Testing terminal selection (this is where dimension errors occurred)...');
    console.log('Note: Open the dashboard in your browser and watch the console for errors\n');
    
    // 3. Simulate terminal selection by fetching details
    for (let i = 0; i < 5; i++) {
      const terminal = terminals[i % terminals.length];
      console.log(`Selecting terminal ${terminal.name}...`);
      
      // Fetch terminal details (simulates selection)
      const details = await api.get(`/terminals/${terminal.id}`);
      console.log(`✓ Terminal ${terminal.name} - Status: ${details.data.status}`);
      
      await sleep(500);
    }
    
    console.log('\n4. Testing rapid terminal switching...');
    // Rapid switching test
    for (let i = 0; i < 10; i++) {
      const terminal = terminals[i % terminals.length];
      await api.get(`/terminals/${terminal.id}`);
      console.log(`✓ Quick switch to ${terminal.name}`);
      await sleep(100);
    }
    
    console.log('\n5. Cleaning up test terminals...');
    // Cleanup
    for (const terminal of terminals) {
      await api.delete(`/terminals/${terminal.id}`);
      console.log(`✓ Deleted terminal ${terminal.name}`);
    }
    
    console.log('\n✅ Test completed successfully!');
    console.log('\nIMPORTANT: Check the browser console for any dimension errors.');
    console.log('If no errors appeared during terminal selection, the fix is working properly.');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response:', error.response.data);
    }
  }
}

// Run the test
testDimensionFix();