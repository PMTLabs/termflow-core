#!/usr/bin/env node
require('dotenv').config();

async function testChatHubWS() {
  try {
    console.log('🧪 Testing ChatHub WebSocket connection...');
    
    const { ChatHubIntegration } = require('./dist/chathub-integration');
    const chatHub = new ChatHubIntegration();
    
    console.log('Attempting to connect to ChatHub SignalR...');
    
    await chatHub.connect();
    console.log('✅ ChatHub SignalR connection successful!');
    
    // Try to join channel 20
    await chatHub.joinChannel(20);
    console.log('✅ Successfully joined channel 20!');
    
    await chatHub.disconnect();
    console.log('✅ All ChatHub tests passed!');
    
  } catch (err) {
    console.log('❌ ChatHub test failed:', err.message);
  }
}

testChatHubWS();