#!/usr/bin/env node

// Test: Can API send input to terminals in background tabs (not focused)?
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function testBackgroundInput() {
  console.log('🧪 TESTING BACKGROUND TAB INPUT ROUTING');
  console.log('='.repeat(50));
  console.log('Question: Can API send input to terminals in non-focused tabs?\n');
  
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

    // Step 1: Create multiple terminals in separate tabs
    console.log('📂 STEP 1: Creating terminals in separate tabs');
    const terminals = [];
    
    for (let i = 1; i <= 3; i++) {
      const terminal = await client.createTerminal({
        name: `Background Test Terminal ${i}`,
        profile: 'cmd'
      });
      
      terminals.push({ ...terminal, tabNumber: i });
      console.log(`✅ Terminal ${i}: ${terminal.id} (in separate tab)`);
      await sleep(1000);
    }

    console.log(`\n📊 Created ${terminals.length} terminals in separate tabs`);
    console.log('💡 Now manually switch to Tab 1 in Auto-Terminal UI...\n');

    // Step 2: Wait for user to focus on specific tab
    console.log('⏳ STEP 2: Waiting 10 seconds for you to focus on Tab 1...');
    console.log('   👆 Please click on Tab 1 in Auto-Terminal UI');
    console.log('   📍 Focus should be on Terminal 1');
    
    await sleep(10000);

    // Step 3: Send commands to ALL terminals (including background ones)
    console.log('\n📤 STEP 3: Sending commands to ALL terminals via API');
    console.log('   🎯 This tests if background tabs receive commands\n');
    
    for (let i = 0; i < terminals.length; i++) {
      const terminal = terminals[i];
      const timestamp = new Date().toLocaleTimeString();
      
      // Send unique command to each terminal
      const command = `echo "[${timestamp}] BACKGROUND TEST: Terminal ${terminal.tabNumber} - ${terminal.id.slice(-8)}"`;
      
      console.log(`📡 → Terminal ${terminal.tabNumber}: ${command}`);
      await client.sendInput(terminal.id, command + '\\n');
      
      // Small delay between commands
      await sleep(1000);
    }

    console.log('\n⏳ STEP 4: Sending continuous test commands...');
    console.log('   📱 Switch between tabs while this runs to see if all receive commands\n');
    
    // Step 4: Send continuous commands while user switches tabs
    for (let round = 1; round <= 5; round++) {
      console.log(`🔄 Round ${round}/5:`);
      
      for (let i = 0; i < terminals.length; i++) {
        const terminal = terminals[i];
        const command = `echo "Round ${round}: Terminal ${terminal.tabNumber} active - Switch tabs now!"`;
        
        console.log(`   → Terminal ${terminal.tabNumber}: Round ${round}`);
        await client.sendInput(terminal.id, command + '\\n');
        await sleep(1500);
      }
      
      console.log(`   ✅ Round ${round} complete - all terminals should show message\\n`);
      await sleep(2000);
    }

    console.log('🎯 EXPECTED RESULTS:');
    console.log('   ✅ ALL terminals should show their respective commands');
    console.log('   ✅ Commands should appear even in non-focused tabs');
    console.log('   ✅ API works independently of UI focus');
    console.log('');
    console.log('❌ IF COMMANDS ONLY GO TO FOCUSED TAB:');
    console.log('   → API has UI dependency (unexpected)');
    console.log('   → Terminal routing issue exists');
    console.log('');
    console.log('💡 VERIFICATION:');
    console.log('   1. Switch between all 3 tabs');
    console.log('   2. Each tab should show its own unique messages');
    console.log('   3. Background tabs should have received commands while not focused');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testBackgroundInput().catch(console.error);