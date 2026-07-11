#!/usr/bin/env node

// Test terminal creation in empty tab
require('dotenv').config();

const axios = require('axios');

async function testEmptyTab() {
  console.log('🧪 Testing Terminal Creation in Empty Tab');
  console.log('='.repeat(50));
  
  const apiUrl = process.env.API_URL || 'http://localhost:3001';
  const token = process.env.API_TOKEN || '';
  const tabId = process.env.DEFAULT_TERMINAL_TABID;
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  if (!tabId) {
    console.error('❌ DEFAULT_TERMINAL_TABID not set in .env file');
    return;
  }

  console.log(`📋 Using tab ID: ${tabId}`);
  console.log('\n⚠️  IMPORTANT: Close all terminals in this tab before running this test!');
  console.log('⏳ Waiting 5 seconds for you to close terminals...\n');
  
  await new Promise(resolve => setTimeout(resolve, 5000));

  try {
    console.log('📦 Creating terminal in empty tab...');
    
    const response = await axios.post(
      `${apiUrl}/api/terminals`,
      {
        name: 'Empty Tab Test Terminal',
        profile: 'cmd',
        tabId: tabId
      },
      { headers }
    );
    
    const terminal = response.data;
    console.log('✅ Terminal created successfully!');
    console.log('   ID:', terminal.id);
    console.log('   Process ID:', terminal.processId);
    console.log('   Tab ID:', terminal.tabId);
    console.log('   Pane ID:', terminal.paneId);
    console.log('   Profile:', terminal.profile);
    
    // Send a test command
    console.log('\n📤 Sending test command...');
    await axios.post(
      `${apiUrl}/api/terminals/${terminal.id}/input`,
      {
        data: 'echo Empty tab terminal is working!\r\n'
      },
      { headers }
    );
    
    console.log('\n✅ Test completed successfully!');
    console.log('🔍 Check Auto-Terminal UI to verify the terminal was created in the empty tab');
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
    if (error.response?.data?.error?.includes('No pane tree found')) {
      console.error('\n⚠️  This error indicates the fix is not working properly');
    }
  }
}

testEmptyTab().catch(console.error);