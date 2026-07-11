#!/usr/bin/env node

// Test minimal functionality: just create terminals without ChatHub
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function testMinimal() {
  console.log('🧪 MINIMAL TEST: Create 2 agent terminals');
  console.log('='.repeat(50));
  
  try {
    // Test API connection
    const client = new AutoTerminalClient({
      apiUrl: process.env.API_URL,
      token: process.env.API_TOKEN
    });
    
    console.log('🔌 Connecting to Auto-Terminal...');
    await client.connect();
    console.log('✅ Connected to Auto-Terminal API');
    
    // Test terminal creation
    console.log('\n📋 Creating agent terminals...');
    
    const terminals = [];
    const agents = [
      { name: 'Alex Coordinator', role: 'Project Coordinator' },
      { name: 'Jordan Backend', role: 'Backend Developer' }
    ];
    
    for (const agent of agents) {
      const createOptions = {
        name: `${agent.name} - ${agent.role}`,
        profile: 'cmd'
      };
      
      // Add default tab if configured
      if (process.env.DEFAULT_TERMINAL_TABID) {
        createOptions.tabId = process.env.DEFAULT_TERMINAL_TABID;
      }
      
      console.log(`  🤖 Creating terminal for ${agent.name}...`);
      const terminal = await client.createTerminal(createOptions);
      terminals.push({ agent, terminal });
      console.log(`    ✅ Created: ${terminal.id}`);
    }
    
    console.log(`\n✅ SUCCESS: Created ${terminals.length} terminals`);
    console.log('🎯 All terminals created in tab:', process.env.DEFAULT_TERMINAL_TABID);
    
    // Test sending commands
    console.log('\n📨 Testing commands...');
    for (const { agent, terminal } of terminals) {
      console.log(`  📤 Sending test command to ${agent.name}...`);
      await client.sendInput(terminal.id, `cd "${process.env.PROJECT_FOLDER || 'D:\\sources\\demo\\todo-app'}"`);
      await client.sendInput(terminal.id, 'echo "Agent terminal ready!"');
    }
    
    console.log('\n🎉 MINIMAL TEST PASSED!');
    console.log('💡 Next step: Fix ChatHub integration to enable full team coordination');
    
    await client.disconnect();
    
  } catch (error) {
    console.error('❌ Minimal test failed:', error.message);
    
    if (error.message.includes('Invalid token')) {
      console.log('\n💡 Solution: Get fresh token from Auto-Terminal DevTools');
      console.log('   Press Ctrl+Shift+I, then run:');
      console.log('   await window.electronAPI.generateAPIToken("agent-monitor", ["*"])');
    }
  }
}

testMinimal();