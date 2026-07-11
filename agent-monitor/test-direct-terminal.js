#!/usr/bin/env node

// Test creating terminals directly via REST API without UI
require('dotenv').config();

const axios = require('axios');

async function testDirectTerminal() {
  console.log('🧪 Testing Direct Terminal Creation via REST API');
  console.log('='.repeat(50));
  
  const apiUrl = process.env.API_URL || 'http://localhost:3001';
  const token = process.env.API_TOKEN || '';
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  try {
    // Test different shell profiles
    const tests = [
      { name: 'CMD Terminal', profile: 'cmd' },
      { name: 'PowerShell Terminal', profile: 'powershell' },
      { name: 'Default Terminal', profile: 'default' }
    ];

    for (const test of tests) {
      console.log(`\n📦 Creating ${test.name} with profile: ${test.profile}`);
      
      try {
        const response = await axios.post(
          `${apiUrl}/api/terminals`,
          {
            name: test.name,
            profile: test.profile
          },
          { headers }
        );
        
        const terminal = response.data;
        console.log('✅ Success!');
        console.log(`   ID: ${terminal.id}`);
        console.log(`   Process ID: ${terminal.processId}`);
        console.log(`   Profile: ${terminal.profile}`);
        console.log(`   Status: ${terminal.status}`);
        
        // Try to send input
        console.log('📤 Sending test command...');
        const command = test.profile === 'powershell' 
          ? 'Write-Host "Test from PowerShell"'
          : 'echo Test from CMD';
          
        await axios.post(
          `${apiUrl}/api/terminals/${terminal.id}/input`,
          { data: command + '\r\n' },
          { headers }
        );
        console.log('✅ Command sent successfully');
        
      } catch (error) {
        console.error('❌ Failed:', error.response?.data || error.message);
      }
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  }
}

testDirectTerminal().catch(console.error);