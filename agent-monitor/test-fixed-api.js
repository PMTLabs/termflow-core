#!/usr/bin/env node

// Test script to verify the fixed Auto-Terminal API
// This confirms multiple terminals in same tab have unique process IDs

require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function testFixedAPI() {
  console.log('🧪 TESTING FIXED AUTO-TERMINAL API - SAME TAB MULTIPLE TERMINALS');
  console.log('='.repeat(70));
  console.log('Expected: Each terminal in same tab should have unique process ID\n');
  
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

    // Test configuration matching agent-monitor
    const testAgents = [
      { name: 'Alex Coordinator', role: 'Project Coordinator', profile: 'cmd' },
      { name: 'Jordan Backend', role: 'Backend Developer', profile: 'cmd' },
      { name: 'Test Agent 3', role: 'Test Role', profile: 'cmd' },
      { name: 'Test Agent 4', role: 'Test Role', profile: 'cmd' }
    ];

    const envTabId = process.env.DEFAULT_TERMINAL_TABID;
    let sharedTabId = envTabId;
    const terminals = [];
    
    console.log(`📋 Tab Configuration: ${envTabId ? `Using ENV tab ${envTabId}` : 'Creating new tab'}\n`);
    
    for (let i = 0; i < testAgents.length; i++) {
      const agent = testAgents[i];
      
      console.log(`🤖 Creating terminal ${i + 1}: ${agent.name} (${agent.role})`);
      console.log(`   Profile: ${agent.profile}`);
      
      let terminal;
      
      if (envTabId) {
        // Use environment tab ID (like agent-monitor does)
        terminal = await client.createTerminal({
          name: `${agent.name} - ${agent.role}`,
          profile: agent.profile,
          tabId: envTabId
        });
      } else if (i === 0) {
        // First terminal creates the tab
        terminal = await client.createTerminal({
          name: `${agent.name} - ${agent.role}`,
          profile: agent.profile
        });
        sharedTabId = terminal.tabId;
        console.log(`   📂 Created new shared tab: ${sharedTabId}`);
      } else {
        // Subsequent terminals use the shared tab
        terminal = await client.createTerminal({
          name: `${agent.name} - ${agent.role}`,
          profile: agent.profile,
          tabId: sharedTabId
        });
      }
      
      console.log(`   ✅ Terminal created successfully`);
      console.log(`      Terminal ID: ${terminal.id}`);
      console.log(`      Process ID: ${terminal.processId}`);
      console.log(`      Tab ID: ${terminal.tabId}`);
      console.log(`      Shell: ${terminal.profile}`);
      
      terminals.push(terminal);
      await sleep(1000);
      console.log('');
    }

    // Analyze results
    console.log('📊 ANALYSIS OF RESULTS:');
    console.log('='.repeat(70));
    
    // Check if all terminals are in the same tab
    const tabIds = [...new Set(terminals.map(t => t.tabId))];
    console.log(`\n✅ Tab Sharing: ${tabIds.length === 1 ? 'SUCCESS' : 'FAILED'}`);
    console.log(`   All terminals in tab: ${tabIds[0]}`);
    
    // Check if all terminals have unique process IDs
    const processIds = terminals.map(t => t.processId);
    const uniqueProcessIds = [...new Set(processIds)];
    const allUnique = processIds.length === uniqueProcessIds.length;
    
    console.log(`\n${allUnique ? '✅' : '❌'} Process ID Uniqueness: ${allUnique ? 'SUCCESS' : 'FAILED'}`);
    console.log(`   Total terminals: ${terminals.length}`);
    console.log(`   Unique process IDs: ${uniqueProcessIds.length}`);
    
    if (!allUnique) {
      console.log('\n❌ DUPLICATE PROCESS IDS FOUND:');
      const duplicates = processIds.filter((id, index) => processIds.indexOf(id) !== index);
      console.log(`   Duplicated IDs: ${[...new Set(duplicates)].join(', ')}`);
    }
    
    // List all process IDs
    console.log('\n📋 Terminal Process Mapping:');
    terminals.forEach((t, i) => {
      console.log(`   ${i + 1}. ${t.name} → Process: ${t.processId}`);
    });
    
    // Test input routing
    console.log('\n🧪 TESTING INPUT ROUTING:');
    console.log('='.repeat(70));
    console.log('Sending unique commands to each terminal...\n');
    
    for (let i = 0; i < terminals.length; i++) {
      const terminal = terminals[i];
      const testCommand = `echo "Terminal ${i + 1}: ${terminal.name} - Process ID: ${terminal.processId}"`;
      
      console.log(`📤 Terminal ${i + 1}: Sending test command`);
      await client.sendInput(terminal.id, testCommand + '\r\n');
      await sleep(500);
    }
    
    console.log('\n✅ TEST COMPLETE!');
    console.log('\n💡 VERIFICATION STEPS:');
    console.log('1. Check Auto-Terminal UI - all terminals should be in one tab');
    console.log('2. Each terminal should show its unique echo output');
    console.log('3. Commands should not cross between terminals');
    console.log('4. Shell types should match requested profiles (cmd/powershell)');

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    if (error.response) {
      console.error('   Response:', error.response.data);
    }
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testFixedAPI().catch(console.error);