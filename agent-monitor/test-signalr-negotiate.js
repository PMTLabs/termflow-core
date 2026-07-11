#!/usr/bin/env node

// Test SignalR hub connection with negotiation
require('dotenv').config();
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

const signalR = require('@microsoft/signalr');

async function testSignalRWithNegotiation() {
  console.log('🧪 Testing SignalR Hub with negotiation...\n');

  const basePaths = [
    'https://localhost:5001/chathub',
    'https://localhost:5001/ChatHub', 
    'https://localhost:5001/hubs/chat',
    'https://localhost:5001/hubs/chathub',
    'https://localhost:5001/hub/chat',
    'https://localhost:5001/hub/chathub'
  ];

  for (const hubUrl of basePaths) {
    try {
      console.log(`Testing: ${hubUrl} (with negotiation)`);
      
      const connection = new signalR.HubConnectionBuilder()
        .withUrl(hubUrl) // Let SignalR handle negotiation
        .withAutomaticReconnect()
        .configureLogging(signalR.LogLevel.Information)
        .build();

      // Set a timeout for the test
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection timeout after 10s')), 10000);
      });

      await Promise.race([
        connection.start(),
        timeoutPromise
      ]);

      console.log(`✅ SUCCESS: ${hubUrl} - Connected with negotiation!`);
      await connection.stop();
      
      console.log(`\n🎯 Working SignalR Hub URL found: ${hubUrl}`);
      break;

    } catch (error) {
      console.log(`❌ FAILED: ${hubUrl}`);
      console.log(`   Error: ${error.message}`);
      
      // Check if it's a specific error that gives us clues
      if (error.message.includes('negotiate')) {
        console.log(`   💡 Negotiate endpoint issue - hub might not exist`);
      } else if (error.message.includes('404')) {
        console.log(`   💡 404 - Hub path doesn't exist`);
      }
      console.log('');
    }
  }
  
  console.log('💡 If all paths failed, the ChatHub server might not be running or configured differently.');
}

testSignalRWithNegotiation().catch(console.error);