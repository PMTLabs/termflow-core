#!/usr/bin/env node

// Test terminal creation with delay
require('dotenv').config();

const axios = require('axios');

async function testDelayedTerminal() {
  console.log('🧪 Testing Terminal Creation with Delay');
  console.log('='.repeat(50));
  
  const apiUrl = process.env.API_URL || 'http://localhost:3001';
  const token = process.env.API_TOKEN || '';
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  try {
    // Wait for Auto-Terminal to be fully ready
    console.log('⏳ Waiting 5 seconds for Auto-Terminal to be fully ready...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log('📦 Creating a test terminal...');
    
    const response = await axios.post(
      `${apiUrl}/api/terminals`,
      {
        name: 'Test Terminal',
        profile: 'cmd'
      },
      { headers }
    );
    
    const terminal = response.data;
    console.log('✅ Terminal created successfully!');
    console.log('   ID:', terminal.id);
    console.log('   Process ID:', terminal.processId);
    console.log('   Profile:', terminal.profile);
    console.log('   Status:', terminal.status);
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

console.log('Starting test in 3 seconds...');
setTimeout(() => testDelayedTerminal().catch(console.error), 3000);