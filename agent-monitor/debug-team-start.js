#!/usr/bin/env node

// Debug team start issue
require('dotenv').config();

const fs = require('fs');
const path = require('path');

console.log('🔍 Debugging team start...\n');

// Check environment variables
console.log('📋 Environment Variables:');
console.log('API_URL:', process.env.API_URL || 'Not set');
console.log('WS_URL:', process.env.WS_URL || 'Not set');
console.log('API_TOKEN:', process.env.API_TOKEN ? 'Set (length: ' + process.env.API_TOKEN.length + ')' : 'Not set');
console.log('CHATHUB_WS_URL:', process.env.CHATHUB_WS_URL || 'Not set');
console.log('DISCORD_WEBHOOK_URL:', process.env.DISCORD_WEBHOOK_URL ? 'Set' : 'Not set');

// Check if config file exists
const configPath = path.join(__dirname, 'team-config.json');
console.log('\n📄 Config file:', configPath);
console.log('Exists:', fs.existsSync(configPath));

if (fs.existsSync(configPath)) {
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log('Valid JSON:', true);
    console.log('Project:', config.teamConfig?.projectName || 'Not specified');
    console.log('Agents:', config.agents?.length || 0);
  } catch (error) {
    console.log('Valid JSON:', false);
    console.log('Error:', error.message);
  }
}

// Check if dist folder exists
const distDir = path.join(__dirname, 'dist');
console.log('\n📂 Dist folder:', distDir);
console.log('Exists:', fs.existsSync(distDir));

if (fs.existsSync(distDir)) {
  const teamManagerPath = path.join(distDir, 'team-manager.js');
  console.log('team-manager.js exists:', fs.existsSync(teamManagerPath));
}

// Test API connection
console.log('\n🔌 Testing Auto-Terminal connection...');
const axios = require('axios');

async function testConnection() {
  const apiUrl = process.env.API_URL || 'http://localhost:3001';
  const token = process.env.API_TOKEN || '';
  
  try {
    const response = await axios.get(`${apiUrl}/api/system/info`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    console.log('✅ Auto-Terminal is running');
    console.log('Version:', response.data.version);
  } catch (error) {
    console.log('❌ Failed to connect to Auto-Terminal');
    console.log('Error:', error.response?.status || error.message);
    console.log('\nMake sure Auto-Terminal is running:');
    console.log('  cd D:\\sources\\demo\\auto-terminal');
    console.log('  JWT_SECRET=dev-key-secret npm run dev');
  }
}

testConnection().then(() => {
  console.log('\n💡 Try running the team orchestrator directly:');
  console.log('  cd ' + __dirname);
  console.log('  node dist/team-manager.js start team-config.json');
}).catch(console.error);