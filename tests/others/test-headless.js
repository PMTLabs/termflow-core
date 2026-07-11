/**
 * Test script for headless mode
 * This script tests the Auto-Terminal headless mode functionality
 */

const axios = require('axios');

const API_BASE_URL = 'http://localhost:3001/api';

// Helper function to wait
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function testHeadlessMode() {
  console.log('Testing Auto-Terminal Headless Mode...\n');

  try {
    // Step 1: Check API health
    console.log('1. Checking API health...');
    const healthResponse = await axios.get(`${API_BASE_URL}/health`);
    console.log('   ✓ API is healthy:', healthResponse.data);
    console.log();

    // Step 2: List terminals (should be empty initially)
    console.log('2. Listing terminals...');
    const listResponse1 = await axios.get(`${API_BASE_URL}/terminals`);
    console.log('   ✓ Current terminals:', listResponse1.data.terminals.length);
    console.log();

    // Step 3: Create a headless terminal
    console.log('3. Creating headless terminal...');
    const createResponse = await axios.post(`${API_BASE_URL}/terminals`, {
      profile: 'cmd',
      name: 'Test Terminal 1',
      cwd: process.cwd()
    });
    console.log('   ✓ Terminal created:', {
      id: createResponse.data.id,
      name: createResponse.data.name,
      processId: createResponse.data.processId,
      mode: createResponse.data.mode
    });
    const terminalId = createResponse.data.id;
    console.log();

    // Step 4: List terminals again (should show the new terminal)
    console.log('4. Listing terminals after creation...');
    const listResponse2 = await axios.get(`${API_BASE_URL}/terminals`);
    console.log('   ✓ Current terminals:', listResponse2.data.terminals.length);
    console.log('   ✓ Terminal details:', listResponse2.data.terminals.map(t => ({
      id: t.id,
      name: t.name,
      status: t.status,
      mode: t.mode
    })));
    console.log();

    // Step 5: Send input to terminal
    console.log('5. Sending input to terminal...');
    await axios.post(`${API_BASE_URL}/terminals/${terminalId}/input`, {
      data: 'echo "Hello from headless mode!"\r\n'
    });
    console.log('   ✓ Input sent successfully');
    console.log();

    // Wait a bit for the command to execute
    await wait(1000);

    // Step 6: Create another terminal
    console.log('6. Creating second terminal...');
    const createResponse2 = await axios.post(`${API_BASE_URL}/terminals`, {
      profile: 'cmd',
      name: 'Test Terminal 2'
    });
    console.log('   ✓ Second terminal created:', createResponse2.data.id);
    console.log();

    // Step 7: List all terminals
    console.log('7. Listing all terminals...');
    const listResponse3 = await axios.get(`${API_BASE_URL}/terminals`);
    console.log('   ✓ Total terminals:', listResponse3.data.terminals.length);
    listResponse3.data.terminals.forEach((t, i) => {
      console.log(`   Terminal ${i + 1}:`, {
        id: t.id,
        name: t.name,
        status: t.status
      });
    });
    console.log();

    // Step 8: Delete first terminal
    console.log('8. Deleting first terminal...');
    await axios.delete(`${API_BASE_URL}/terminals/${terminalId}`);
    console.log('   ✓ Terminal deleted');
    console.log();

    // Step 9: Final terminal list
    console.log('9. Final terminal list...');
    const listResponse4 = await axios.get(`${API_BASE_URL}/terminals`);
    console.log('   ✓ Remaining terminals:', listResponse4.data.terminals.length);
    console.log();

    console.log('✅ All headless mode tests passed!');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Response data:', error.response.data);
      console.error('   Status code:', error.response.status);
    }
    process.exit(1);
  }
}

// Run the tests
console.log('Make sure Auto-Terminal is running with: npm start -- --headless\n');
console.log('Press Ctrl+C to exit after tests complete.\n');

// Wait a bit before running tests to ensure API is ready
setTimeout(() => {
  testHeadlessMode();
}, 2000);