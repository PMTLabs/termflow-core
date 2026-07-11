#!/usr/bin/env node
require('dotenv').config();
const { AutoTerminalClient } = require('./dist/api-client');

async function testAPI() {
  try {
    console.log('🧪 Testing Auto-Terminal API with environment config...');
    console.log(`API URL: ${process.env.API_URL}`);
    console.log(`Token present: ${process.env.API_TOKEN ? 'Yes' : 'No'}`);
    
    const client = new AutoTerminalClient(process.env.API_URL, process.env.API_TOKEN);
    
    const terminals = await client.getTerminals();
    console.log('✅ Auto-Terminal API test successful!');
    console.log(`Found ${terminals.length} existing terminals:`);
    terminals.forEach(t => console.log(`  - ${t.name} (${t.id})`));
    
    return true;
  } catch (err) {
    console.log('❌ API test failed:', err.message);
    return false;
  }
}

testAPI();