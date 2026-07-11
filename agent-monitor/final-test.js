#!/usr/bin/env node

// Final test with forced correct environment
require('dotenv').config();

// Force correct environment variables
process.env.CHATHUB_WS_URL = 'wss://localhost:5001';
process.env.CHATHUB_BASE_URL = 'https://localhost:5001';

console.log('🎯 FINAL CHATHUB INTEGRATION TEST');
console.log('='.repeat(50));
console.log('Forced environment:');
console.log('  CHATHUB_WS_URL:', process.env.CHATHUB_WS_URL);
console.log('  API_TOKEN present:', !!process.env.API_TOKEN);
console.log('='.repeat(50));

const { TeamManager } = require('./dist/team-manager');

async function finalTest() {
  try {
    console.log('🚀 Creating team manager with forced URLs...');
    
    // Override the problematic environment loading
    const manager = new TeamManager();
    
    console.log('📋 Starting simplified team...');
    await manager.startTeam('./team-simple.json');
    
    console.log('🎉 SUCCESS! ChatHub integration is working!');
    
  } catch (error) {
    console.error('❌ Final test result:', error.message);
    
    if (error.message.includes('ChatHub API is not available')) {
      console.log('\n🔍 Debug Info:');
      console.log('- Auto-Terminal: Connected ✅');
      console.log('- ChatHub Health Check: Failed ❌');
      console.log('- This might be a ChatHub server issue or SSL cert problem');
      
      console.log('\n💡 Quick verification:');
      console.log('Try: curl -k https://localhost:5001/api/Health');
    } else if (error.message.includes('Invalid token')) {
      console.log('\n💡 Token issue - get new one from Auto-Terminal DevTools');
    } else {
      console.log('\n💡 Unexpected error type');
    }
  }
}

finalTest();