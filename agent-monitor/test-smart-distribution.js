#!/usr/bin/env node

// Test smart terminal distribution
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function testSmartDistribution() {
  console.log('🧪 TESTING SMART TERMINAL DISTRIBUTION');
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

    // Test different team sizes
    const testCases = [
      { 
        name: '2 Agents (Side by side)',
        agents: ['Coordinator', 'Developer'],
        expected: ['vertical']
      },
      {
        name: '3 Agents (One left, two right)',
        agents: ['Coordinator', 'Backend Dev', 'Frontend Dev'],
        expected: ['vertical', 'horizontal']
      },
      {
        name: '4 Agents (2x2 grid)',
        agents: ['Coordinator', 'Backend Dev', 'Frontend Dev', 'QA Engineer'],
        expected: ['vertical', 'horizontal', 'vertical']
      }
    ];

    for (const testCase of testCases) {
      console.log(`\n📋 Test: ${testCase.name}`);
      console.log('─'.repeat(50));
      
      let tabId = null;
      const terminals = [];
      
      for (let i = 0; i < testCase.agents.length; i++) {
        const agentName = testCase.agents[i];
        
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
            // Subsequent agents use smart direction
            const direction = testCase.expected[i - 1];
            console.log(`📦 Creating ${agentName} (${direction} split)...`);
            terminal = await client.createTerminal({
              name: agentName,
              profile: 'cmd',
              tabId: tabId,
              direction: direction
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
        const agent = testCase.agents[i];
        const command = `echo I am ${agent} - Terminal ${i + 1}`;
        
        console.log(`📤 Sending to ${agent}: ${command}`);
        await client.sendInput(terminal.id, command + '\r\n');
        await sleep(500);
      }
      
      console.log('\n✅ Test case completed!');
      console.log('🔍 Check Auto-Terminal UI to verify the layout');
      
      // Wait before next test
      console.log('\n⏳ Waiting 5 seconds before next test...');
      await sleep(5000);
    }
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testSmartDistribution().catch(console.error);