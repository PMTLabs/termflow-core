#!/usr/bin/env node

// Test SignalR hub connection paths
require('dotenv').config();
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

const signalR = require('@microsoft/signalr');

async function testSignalRPaths() {
  console.log('🧪 Testing SignalR Hub paths...\n');

  const basePaths = [
    'wss://localhost:5001/chathub',
    'wss://localhost:5001/ChatHub', 
    'wss://localhost:5001/hubs/chat',
    'wss://localhost:5001/hubs/chathub',
    'wss://localhost:5001/hub/chat',
    'wss://localhost:5001/hub/chathub',
    'wss://localhost:5001/signalr/chathub',
    'wss://localhost:5001/api/chathub'
  ];

  for (const hubUrl of basePaths) {
    try {
      console.log(`Testing: ${hubUrl}`);
      
      const connection = new signalR.HubConnectionBuilder()
        .withUrl(hubUrl, {
          skipNegotiation: true,
          transport: signalR.HttpTransportType.WebSockets
        })
        .withAutomaticReconnect()
        .configureLogging(signalR.LogLevel.Error)
        .build();

      // Set a short timeout for the test
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Connection timeout')), 5000);
      });

      await Promise.race([
        connection.start(),
        timeoutPromise
      ]);

      console.log(`✅ SUCCESS: ${hubUrl} - Connected!`);
      await connection.stop();
      
      // If we found a working one, we can stop testing
      console.log(`\n🎯 Working SignalR Hub URL found: ${hubUrl}`);
      break;

    } catch (error) {
      console.log(`❌ FAILED: ${hubUrl}`);
      console.log(`   Error: ${error.message}\n`);
    }
  }
}

testSignalRPaths().catch(console.error);