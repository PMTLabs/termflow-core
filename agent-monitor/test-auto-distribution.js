#!/usr/bin/env node

// Test auto terminal distribution
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function testAutoDistribution() {
  console.log('🧪 TESTING AUTO TERMINAL DISTRIBUTION');
  console.log('='.repeat(70));
  
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

    console.log('📋 Test: Auto-distribution without specifying direction');
    console.log('─'.repeat(50));
    console.log('The system will automatically choose the best split direction\n');
    
    let tabId = null;
    const terminals = [];
    const agentNames = [
      'Coordinator',
      'Backend Developer', 
      'Frontend Developer',
      'QA Engineer',
      'DevOps Engineer'
    ];
    
    for (let i = 0; i < agentNames.length; i++) {
      const agentName = agentNames[i];
      
      try {
        let terminal;
        
        if (i === 0) {
          // First agent creates new tab
          console.log(`📦 Creating ${agentName} (new tab)...`);
          terminal = await client.createTerminal({
            name: agentName,
            profile: 'cmd'
          });
          tabId = terminal.tabId;
        } else {
          // Subsequent agents use auto-distribution
          console.log(`📦 Creating ${agentName} (auto-distribution)...`);
          terminal = await client.createTerminal({
            name: agentName,
            profile: 'cmd',
            tabId: tabId
            // No direction specified - let the system decide
          });
        }
        
        console.log(`   ✅ Created: ${terminal.id}`);
        console.log(`   Process ID: ${terminal.processId}`);
        console.log(`   Tab ID: ${terminal.tabId}\n`);
        
        terminals.push(terminal);
        await sleep(1000);
        
      } catch (error) {
        console.log(`   ❌ Failed: ${error.message}\n`);
      }
    }
    
    // Send test commands to verify routing
    console.log('🧪 Testing input routing...');
    for (let i = 0; i < terminals.length; i++) {
      const terminal = terminals[i];
      const agent = agentNames[i];
      const timestamp = new Date().toLocaleTimeString();
      const command = `echo [${timestamp}] ${agent} - Terminal ${i + 1}`;
      
      console.log(`📤 Sending to ${agent}: ${command}`);
      await client.sendInput(terminal.id, command + '\r\n');
      await sleep(500);
    }
    
    console.log('\n✅ Auto-distribution test completed!');
    console.log('\n📊 Expected layout:');
    console.log('   - 2 terminals: Side by side (vertical split)');
    console.log('   - 3 terminals: Balanced layout (vertical + horizontal)');
    console.log('   - 4 terminals: 2x2 grid');
    console.log('   - 5 terminals: Optimally balanced distribution');
    console.log('\n🔍 Check Auto-Terminal UI to verify the auto-distributed layout');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testAutoDistribution().catch(console.error);