#!/usr/bin/env node

// Load environment first
require('dotenv').config();

console.log('🧪 Testing Simple Team Configuration');
console.log('='.repeat(50));

// Debug environment
console.log('🔧 Environment Variables:');
console.log('  API_URL:', process.env.API_URL || 'default');
console.log('  API_TOKEN:', process.env.API_TOKEN ? 'Present' : 'Missing');
console.log('  CHATHUB_WS_URL:', process.env.CHATHUB_WS_URL || 'default');
console.log('  DEFAULT_TERMINAL_TABID:', process.env.DEFAULT_TERMINAL_TABID || 'default');

// Fix the ChatHub URL issue
if (!process.env.CHATHUB_WS_URL || process.env.CHATHUB_WS_URL.includes('localhost:8080')) {
  console.log('🔧 Fixing ChatHub URL...');
  process.env.CHATHUB_WS_URL = 'https://localhost:5001';
}

console.log('  Fixed CHATHUB_WS_URL:', process.env.CHATHUB_WS_URL);
console.log('='.repeat(50));

// Import and run team manager
const { TeamManager } = require('./dist/team-manager');

async function testSimpleTeam() {
  try {
    console.log('🚀 Starting simplified 2-agent team...\n');
    
    const manager = new TeamManager();
    await manager.startTeam('./team-simple.json');
    
  } catch (error) {
    console.error('❌ Test failed:', error.message);
    
    // Provide specific guidance based on the error
    if (error.message.includes('Invalid token')) {
      console.log('\n💡 Fix: Update your API_TOKEN in .env file');
      console.log('   Get new token from Auto-Terminal DevTools:');
      console.log('   await window.electronAPI.generateAPIToken("agent-monitor", ["*"])');
    } else if (error.message.includes('ChatHub')) {
      console.log('\n💡 Fix: ChatHub connection issue');
      console.log('   Check if ChatHub is running on https://localhost:5001');
    } else if (error.message.includes('Configuration')) {
      console.log('\n💡 Fix: Configuration file issue');
      console.log('   Check team-simple.json syntax and paths');
    }
  }
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down...');
  process.exit(0);
});

testSimpleTeam();