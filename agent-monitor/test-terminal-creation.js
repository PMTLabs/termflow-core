#!/usr/bin/env node

// Simple test for terminal creation without ChatHub
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function testTerminalCreation() {
  console.log('🧪 Testing Terminal Creation');
  console.log('='.repeat(50));
  
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

    // Test terminals with different profiles
    const terminals = [
      { name: 'Test CMD Terminal', profile: 'cmd' },
      { name: 'Test PowerShell Terminal', profile: 'powershell' },
      { name: 'Test Default Terminal', profile: 'default' }
    ];

    const createdTerminals = [];
    
    for (const terminalConfig of terminals) {
      console.log(`📦 Creating: ${terminalConfig.name} (${terminalConfig.profile})`);
      
      try {
        const terminal = await client.createTerminal({
          name: terminalConfig.name,
          profile: terminalConfig.profile
        });
        
        console.log(`   ✅ Created Successfully`);
        console.log(`   Terminal ID: ${terminal.id}`);
        console.log(`   Process ID: ${terminal.processId}`);
        console.log(`   Profile: ${terminal.profile}`);
        console.log(`   Tab ID: ${terminal.tabId || 'N/A'}`);
        
        createdTerminals.push(terminal);
        
        // Send a test command
        const command = terminalConfig.profile === 'powershell' 
          ? 'Write-Host "Hello from PowerShell"' 
          : 'echo Hello from %COMSPEC%';
          
        await client.sendInput(terminal.id, command + '\r\n');
        console.log(`   → Sent test command: ${command}\n`);
        
      } catch (error) {
        console.error(`   ❌ Failed: ${error.message}\n`);
      }
      
      // Wait between terminals
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    console.log('📊 Summary:');
    console.log(`Created ${createdTerminals.length} of ${terminals.length} terminals`);
    
    // Check process uniqueness
    const processIds = createdTerminals.map(t => t.processId);
    const uniqueProcessIds = new Set(processIds);
    
    if (uniqueProcessIds.size === createdTerminals.length) {
      console.log('✅ All terminals have unique process IDs');
    } else {
      console.log('❌ Some terminals share process IDs!');
      console.log('   Process IDs:', processIds);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

testTerminalCreation().catch(console.error);