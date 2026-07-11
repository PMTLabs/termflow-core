#!/usr/bin/env node

// Test the ChatHub integration fix
require('dotenv').config();

const { ChatHubIntegration } = require('./dist/chathub-integration');

async function testChatHubFix() {
  console.log('🧪 TESTING CHATHUB INTEGRATION FIX');
  console.log('='.repeat(50));
  
  // Test URL conversion
  console.log('🔧 Testing URL conversion logic:');
  
  const testUrls = [
    'wss://localhost:5001',
    'wss://localhost:5001/chathub',
    'https://localhost:5001',
    'https://localhost:5001/chathub'
  ];
  
  for (const url of testUrls) {
    try {
      console.log(`\n📡 Testing URL: ${url}`);
      const chatHub = new ChatHubIntegration(url);
      console.log(`  ✅ ChatHubIntegration created successfully`);
      
      // Test connection (this will show us the actual HTTP URL being used)
      console.log(`  🔗 Attempting connection test...`);
      
      setTimeout(async () => {
        try {
          await chatHub.connect({
            name: 'Test Agent',
            role: 'Tester',
            description: 'Testing ChatHub integration fix'
          });
          console.log(`  ✅ Connection successful!`);
          await chatHub.disconnect();
        } catch (error) {
          console.log(`  ❌ Connection failed: ${error.message}`);
          // Extract the specific error type
          if (error.message.includes('Unsupported protocol')) {
            console.log(`    🔍 Still has protocol issue - needs more fixing`);
          } else if (error.message.includes('ECONNREFUSED') || error.message.includes('network')) {
            console.log(`    ℹ️  Network error - ChatHub might not be running`);
          } else {
            console.log(`    ℹ️  Other error: ${error.message}`);
          }
        }
      }, 1000);
      
    } catch (error) {
      console.log(`  ❌ Failed to create ChatHubIntegration: ${error.message}`);
    }
  }
  
  console.log('\n⏳ Test results will appear above as connections are attempted...');
  
  // Wait for all tests to complete
  setTimeout(() => {
    console.log('\n✅ ChatHub integration fix test completed!');
    process.exit(0);
  }, 10000);
}

testChatHubFix();