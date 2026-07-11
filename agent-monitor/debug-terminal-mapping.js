#!/usr/bin/env node

// Debug terminal ID mapping issue - why sendInput goes to wrong terminal
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function debugTerminalMapping() {
  console.log('🔍 DEBUGGING TERMINAL ID MAPPING ISSUE');
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

    // Test 1: Create terminals with unique commands to identify them
    console.log('🧪 TEST 1: Creating multiple terminals with unique identifiers');
    
    const terminals = [];
    const testCommands = [
      'echo "TERMINAL 1 - Alex Coordinator"',
      'echo "TERMINAL 2 - Jordan Backend"',
      'echo "TERMINAL 3 - Debug Test"'
    ];

    // Create terminals
    for (let i = 0; i < testCommands.length; i++) {
      const terminal = await client.createTerminal({
        name: `Test Terminal ${i + 1}`,
        profile: 'cmd'
      });
      
      terminals.push(terminal);
      console.log(`✅ Terminal ${i + 1} created:`);
      console.log(`   Terminal ID: ${terminal.id}`);
      console.log(`   Process ID: ${terminal.processId}`);
      console.log(`   Name: ${terminal.name || 'N/A'}`);
      console.log('');
    }

    // Wait for terminals to initialize
    console.log('⏳ Waiting 3 seconds for terminals to initialize...\n');
    await sleep(3000);

    // Test 2: Send unique commands to each terminal
    console.log('🧪 TEST 2: Sending unique commands to each terminal');
    
    for (let i = 0; i < terminals.length; i++) {
      const terminal = terminals[i];
      const command = testCommands[i];
      
      console.log(`📤 Sending to ${terminal.id}: ${command}`);
      await client.sendInput(terminal.id, command + '\\n');
      
      // Wait between commands to see results
      await sleep(2000);
    }

    console.log('\\n💡 CHECK AUTO-TERMINAL UI NOW:');
    console.log('   - Are there 3 new terminals created?');
    console.log('   - Did each terminal receive its unique command?');
    console.log('   - Or did all commands go to the first/default terminal?');
    
    // Test 3: Send additional test to verify mapping
    console.log('\\n🧪 TEST 3: Sending verification commands');
    
    for (let i = 0; i < terminals.length; i++) {
      const terminal = terminals[i];
      const verifyCommand = `echo "VERIFY: This is terminal ${terminal.id.slice(-8)}"`;
      
      console.log(`📤 Verification to ${terminal.id}: ${verifyCommand}`);
      await client.sendInput(terminal.id, verifyCommand + '\\n');
      
      await sleep(1000);
    }

    // Test 4: Try sending executePrompt to see if it has same issue
    console.log('\\n🧪 TEST 4: Testing executePrompt vs sendInput');
    
    const terminal = terminals[0];
    console.log(`📤 Using executePrompt on ${terminal.id}`);
    
    try {
      await client.executePrompt(terminal.id, 'echo "PROMPT TEST: This should go to terminal ' + terminal.id.slice(-8) + '"', 'claude');
      console.log('   ✅ executePrompt sent successfully');
    } catch (error) {
      console.log(`   ❌ executePrompt failed: ${error.message}`);
    }

    await sleep(2000);

    console.log('\\n📊 ANALYSIS:');
    console.log('If all commands went to the first terminal in UI:');
    console.log('   → Terminal ID mapping issue in Auto-Terminal API');
    console.log('   → sendInput might be using process ID instead of terminal ID');
    console.log('   → Or terminal ID to process ID mapping is incorrect');
    console.log('\\nIf commands went to correct terminals:');
    console.log('   → Terminal mapping is working correctly');
    console.log('   → Issue might be with agent-monitor terminal tracking');

  } catch (error) {
    console.error('❌ Debug failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

debugTerminalMapping().catch(console.error);