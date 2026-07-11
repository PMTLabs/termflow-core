#!/usr/bin/env node

// Fix the tab ID issue by getting current valid tab IDs or removing DEFAULT_TERMINAL_TABID
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function fixTabIdIssue() {
  console.log('🔧 FIXING TAB ID ISSUE FOR AGENT MONITOR');
  console.log('='.repeat(50));
  
  const CONFIG = {
    apiUrl: process.env.API_URL || 'http://localhost:3001',
    wsUrl: process.env.WS_URL || 'ws://localhost:9876',
    token: process.env.API_TOKEN || ''
  };

  console.log(`Current DEFAULT_TERMINAL_TABID: ${process.env.DEFAULT_TERMINAL_TABID}`);
  console.log('Problem: This tab ID no longer exists in Auto-Terminal\\n');

  const client = new AutoTerminalClient({
    apiUrl: CONFIG.apiUrl,
    wsUrl: CONFIG.wsUrl,
    token: CONFIG.token,
    autoReconnect: false
  });

  try {
    await client.connect();
    console.log('✅ Connected to Auto-Terminal\\n');

    // Get current tabs to find valid tab IDs
    console.log('🔍 Getting current tabs in Auto-Terminal...');
    
    try {
      // This is a hypothetical call - we need to check if API supports getting tabs
      const response = await client.axios.get('/api/tabs');
      console.log('Current tabs:', response.data);
    } catch (error) {
      console.log('ℹ️  Tab listing not available via API');
    }

    // Solution 1: Test creating terminal without tabId
    console.log('\\n💡 SOLUTION 1: Create terminal without specific tabId');
    try {
      const terminal1 = await client.createTerminal({
        name: 'Test Terminal No Tab',
        profile: 'cmd'
      });
      console.log(`✅ SUCCESS: Terminal created without tabId: ${terminal1.id}`);
      console.log('   This will work for agent-monitor');
    } catch (error) {
      console.log(`❌ Failed: ${error.message}`);
    }

    // Solution 2: Create a new terminal first to get a valid tab, then use it
    console.log('\\n💡 SOLUTION 2: Create terminal to get new valid tabId');
    try {
      const refTerminal = await client.createTerminal({
        name: 'Reference Terminal',
        profile: 'cmd'
      });
      console.log(`✅ Reference terminal created: ${refTerminal.id}`);
      
      // If the API returns tab info, we could extract it here
      // For now, let's just show that terminals work without specific tabId
      
    } catch (error) {
      console.log(`❌ Failed: ${error.message}`);
    }

    console.log('\\n🎯 RECOMMENDED FIX:');
    console.log('1. Remove DEFAULT_TERMINAL_TABID from .env file');
    console.log('2. Let agent-monitor create terminals in default locations');
    console.log('3. Or get current tab ID from Auto-Terminal UI and update .env');
    
    console.log('\\n📝 To get current tab ID:');
    console.log('   - Open Auto-Terminal DevTools (F12)');
    console.log('   - Run: window.electronAPI.getActiveTabId() or similar');
    console.log('   - Update DEFAULT_TERMINAL_TABID in .env with valid tab ID');

  } catch (error) {
    console.error('❌ Fix attempt failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

fixTabIdIssue().catch(console.error);