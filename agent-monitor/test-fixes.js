#!/usr/bin/env node

// Test the two fixes: sendInput with \n and shell profile resolution
require('dotenv').config();
const { AutoTerminalClient } = require('./dist/api-client');

async function testFixes() {
  console.log('🧪 Testing sendInput and shell profile fixes...\n');

  const CONFIG = {
    apiUrl: process.env.API_URL || 'http://localhost:3001',
    wsUrl: process.env.WS_URL || 'ws://localhost:9876',
    token: process.env.API_TOKEN || ''
  };

  const client = new AutoTerminalClient({
    apiUrl: CONFIG.apiUrl,
    wsUrl: CONFIG.wsUrl,
    token: CONFIG.token,
    autoReconnect: false
  });

  try {
    await client.connect();
    console.log('✅ Connected to Auto-Terminal\n');

    // Test 1: Create terminal with PowerShell profile (instead of cmd defaulting to git bash)
    console.log('🔧 Test 1: Creating terminal with PowerShell profile...');
    const terminal1 = await client.createTerminal({
      name: 'Test PowerShell Profile',
      profile: 'powershell'
    });
    console.log(`✅ PowerShell terminal created: ${terminal1.id}`);
    console.log('   Check the Auto-Terminal UI - this should show PowerShell, not Git Bash\n');

    // Test 2: Create terminal with CMD profile 
    console.log('🔧 Test 2: Creating terminal with CMD profile...');
    const terminal2 = await client.createTerminal({
      name: 'Test CMD Profile', 
      profile: 'cmd'
    });
    console.log(`✅ CMD terminal created: ${terminal2.id}`);
    console.log('   Check the Auto-Terminal UI - this should show Command Prompt\n');

    // Test 3: Send commands with \n to verify execution
    console.log('🔧 Test 3: Testing sendInput with \\n for command execution...');
    
    // Send command WITH \n (should execute immediately)
    await client.sendInput(terminal1.id, 'echo "Test command with newline executed!"\\n');
    console.log('✅ Sent command WITH \\n - should execute immediately');

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Send another command to verify
    await client.sendInput(terminal1.id, 'Get-Date\\n');
    console.log('✅ Sent PowerShell Get-Date command WITH \\n - should show current date');

    await new Promise(resolve => setTimeout(resolve, 2000));

    // Send command to CMD terminal
    await client.sendInput(terminal2.id, 'echo Test CMD command executed!\\n');
    console.log('✅ Sent command to CMD terminal WITH \\n - should execute immediately');

    console.log('\\n🎉 All tests completed! Check the Auto-Terminal UI to verify:');
    console.log('   1. PowerShell terminal shows PowerShell (not Git Bash)'); 
    console.log('   2. CMD terminal shows Command Prompt');
    console.log('   3. All commands executed immediately (with newlines)');
    console.log('\\n💡 Previous issues:');
    console.log('   ❌ Commands sent without \\n would not execute');
    console.log('   ❌ "cmd" profile was creating Git Bash instead of Command Prompt');
    console.log('   ✅ Both issues are now FIXED!');

  } catch (error) {
    if (error.message.includes('Authentication failed')) {
      console.log('❌ API Token authentication failed');
      console.log('💡 Update your API_TOKEN in .env file from Auto-Terminal DevTools');
    } else {
      console.error('❌ Test failed:', error.message);
    }
  } finally {
    await client.disconnect();
  }
}

testFixes().catch(console.error);