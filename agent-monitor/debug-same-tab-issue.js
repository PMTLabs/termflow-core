#!/usr/bin/env node

// Debug the same tab issue - why multiple terminals in same tab route to first terminal
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function debugSameTabIssue() {
  console.log('🔍 DEBUGGING SAME TAB TERMINAL ROUTING ISSUE');
  console.log('='.repeat(60));
  
  const CONFIG = {
    apiUrl: process.env.API_URL || 'http://localhost:3001',
    wsUrl: process.env.WS_URL || 'ws://localhost:9876',
    token: process.env.API_TOKEN || ''
  };

  // Create a new tab ID for this test
  const testTabId = `test-tab-${Date.now()}-${Math.random().toString(36).substr(2, 8)}`;
  console.log(`🧪 Test Tab ID: ${testTabId}`);
  console.log('   This will create all terminals in the same tab\n');

  const client = new AutoTerminalClient({
    apiUrl: CONFIG.apiUrl,
    wsUrl: CONFIG.wsUrl,
    token: CONFIG.token,
    autoReconnect: false
  });

  try {
    await client.connect();
    console.log('✅ Connected to Auto-Terminal\n');

    // Step 1: Create multiple terminals in the SAME TAB
    console.log('📂 STEP 1: Creating multiple terminals in same tab');
    
    const terminals = [];
    const agentNames = ['Alex Coordinator', 'Jordan Backend', 'Test Agent'];
    
    for (let i = 0; i < agentNames.length; i++) {
      const name = agentNames[i];
      console.log(`Creating terminal ${i + 1}: ${name}`);
      
      const terminal = await client.createTerminal({
        name: `${name} - Test`,
        profile: i === 0 ? 'cmd' : 'powershell', // Mix shell types
        tabId: testTabId  // SAME TAB ID for all
      });
      
      terminals.push({ ...terminal, agentName: name });
      console.log(`  ✅ Created: ${terminal.id}`);
      console.log(`     Process ID: ${terminal.processId}`);
      console.log(`     Tab ID: ${testTabId}`);
      console.log('');
      
      // Wait between creations to ensure proper initialization
      await sleep(2000);
    }

    console.log(`📊 Summary: Created ${terminals.length} terminals in tab ${testTabId}\n`);

    // Step 2: Send UNIQUE commands to each terminal to identify where they go
    console.log('📤 STEP 2: Sending unique identifying commands to each terminal');
    
    for (let i = 0; i < terminals.length; i++) {
      const terminal = terminals[i];
      const isCmd = i === 0; // First terminal uses CMD
      
      const command = isCmd 
        ? `echo ====== TERMINAL ${i + 1}: ${terminal.agentName} CMD ======`
        : `Write-Output "====== TERMINAL ${i + 1}: ${terminal.agentName} POWERSHELL ======"`;
      
      console.log(`\n🎯 Sending to Terminal ${i + 1} (${terminal.id}):`);
      console.log(`   Command: ${command}`);
      console.log(`   Agent: ${terminal.agentName}`);
      console.log(`   Process: ${terminal.processId}`);
      
      await client.sendInput(terminal.id, command + '\\n');
      
      // Wait to see results before sending next
      await sleep(3000);
    }

    // Step 3: Send verification commands with delays
    console.log('\\n🔍 STEP 3: Sending verification commands with timestamps');
    
    for (let i = 0; i < terminals.length; i++) {
      const terminal = terminals[i];
      const isCmd = i === 0;
      const timestamp = new Date().toLocaleTimeString();
      
      const command = isCmd
        ? `echo [${timestamp}] VERIFY Terminal ${i + 1} - ${terminal.id.slice(-8)}`
        : `Write-Output "[${timestamp}] VERIFY Terminal ${i + 1} - ${terminal.id.slice(-8)}"`;
      
      console.log(`\\n⏰ ${timestamp} → Terminal ${i + 1}: ${command.substring(0, 50)}...`);
      await client.sendInput(terminal.id, command + '\\n');
      
      await sleep(2000);
    }

    // Step 4: Get terminal list to verify API view
    console.log('\\n🗂️  STEP 4: Getting terminal list from API');
    try {
      const terminalList = await client.axios.get('/api/terminals');
      console.log('Active terminals from API:');
      terminalList.data.forEach(t => {
        const isOurTerminal = terminals.some(our => our.id === t.id);
        console.log(`  ${isOurTerminal ? '🎯' : '📍'} ${t.id} - ${t.name || 'Unnamed'} (Process: ${t.processId.slice(0, 8)}...)`);
      });
    } catch (error) {
      console.log('   ℹ️  Terminal list API not available');
    }

    console.log('\\n' + '='.repeat(60));
    console.log('💡 EXPECTED BEHAVIOR:');
    console.log('   - 3 terminals should appear in the same tab in Auto-Terminal UI');
    console.log('   - Each terminal should show ITS OWN unique message');
    console.log('   - Terminal 1: CMD messages (echo)');
    console.log('   - Terminal 2 & 3: PowerShell messages (Write-Output)');
    
    console.log('\\n❌ CURRENT PROBLEM:');
    console.log('   - If ALL commands appear in the FIRST terminal only');
    console.log('   - Then there is a tab-level routing issue');
    console.log('   - Commands are going to active/focused terminal instead of target terminal');
    
    console.log('\\n🔧 DEBUGGING CLUES:');
    console.log('   - Check which terminal in the tab is visually active/focused');
    console.log('   - See if clicking different terminals changes where commands go');
    console.log('   - Verify if terminal IDs are being mapped correctly to processes');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

debugSameTabIssue().catch(console.error);