#!/usr/bin/env node

/**
 * Test script for headless Auto-Terminal integration
 * Validates that agent-monitor can connect and create terminals in headless mode
 */

const axios = require('axios');
const WebSocket = require('ws');
const chalk = require('chalk');

// Configuration
const API_URL = 'http://localhost:3001';
const WS_URL = 'ws://localhost:9876';
const TOKEN = 'dev-token';

console.log(chalk.cyan('🧪 Testing Agent-Monitor Headless Integration'));
console.log(chalk.gray(`API URL: ${API_URL}`));
console.log(chalk.gray(`WebSocket URL: ${WS_URL}\n`));

/**
 * Test API connectivity
 */
async function testAPIConnectivity() {
  try {
    console.log(chalk.yellow('📡 Testing API connectivity...'));
    
    const response = await axios.get(`${API_URL}/api/health`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
      timeout: 5000
    });
    
    console.log(chalk.green('✅ API connection successful'));
    console.log(chalk.gray(`   Mode: ${response.data.mode || 'unknown'}`));
    console.log(chalk.gray(`   Status: ${response.data.status || 'unknown'}`));
    
    return response.data.mode === 'headless';
  } catch (error) {
    console.error(chalk.red(`❌ API connection failed: ${error.message}`));
    return false;
  }
}

/**
 * Test WebSocket connectivity
 */
function testWebSocketConnectivity() {
  return new Promise((resolve) => {
    console.log(chalk.yellow('🔗 Testing WebSocket connectivity...'));
    
    const ws = new WebSocket(`${WS_URL}?token=${TOKEN}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });

    const timeout = setTimeout(() => {
      ws.terminate();
      console.error(chalk.red('❌ WebSocket connection timeout'));
      resolve(false);
    }, 10000);

    ws.on('open', () => {
      clearTimeout(timeout);
      console.log(chalk.green('✅ WebSocket connection successful'));
      ws.close();
      resolve(true);
    });

    ws.on('error', (error) => {
      clearTimeout(timeout);
      console.error(chalk.red(`❌ WebSocket connection failed: ${error.message}`));
      resolve(false);
    });
  });
}

/**
 * Test terminal creation
 */
async function testTerminalCreation() {
  try {
    console.log(chalk.yellow('🖥️ Testing headless terminal creation...'));
    
    const createResponse = await axios.post(`${API_URL}/api/terminals`, {
      profile: 'powershell',
      name: 'Test Agent Terminal',
      mode: 'headless'
    }, {
      headers: { 
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 10000
    });
    
    const terminal = createResponse.data;
    console.log(chalk.green('✅ Terminal creation successful'));
    console.log(chalk.gray(`   Terminal ID: ${terminal.id}`));
    console.log(chalk.gray(`   Process ID: ${terminal.processId}`));
    console.log(chalk.gray(`   Profile: ${terminal.profile}`));
    
    // Test sending input
    console.log(chalk.yellow('📤 Testing input sending...'));
    await axios.post(`${API_URL}/api/terminals/${terminal.id}/input`, {
      data: 'echo "Hello from Agent Monitor headless test"\r\n'
    }, {
      headers: { 
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      }
    });
    
    console.log(chalk.green('✅ Input sending successful'));
    
    // Wait a moment and get output
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log(chalk.yellow('📥 Testing output retrieval...'));
    const outputResponse = await axios.get(`${API_URL}/api/terminals/${terminal.id}/output`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    
    console.log(chalk.green('✅ Output retrieval successful'));
    console.log(chalk.gray(`   Lines retrieved: ${outputResponse.data.lines?.length || 0}`));
    
    // Clean up - terminate terminal
    console.log(chalk.yellow('🗑️ Cleaning up test terminal...'));
    await axios.delete(`${API_URL}/api/terminals/${terminal.id}`, {
      headers: { Authorization: `Bearer ${TOKEN}` }
    });
    
    console.log(chalk.green('✅ Terminal cleanup successful'));
    
    return true;
  } catch (error) {
    console.error(chalk.red(`❌ Terminal operations failed: ${error.message}`));
    if (error.response?.data) {
      console.error(chalk.gray(`   Response: ${JSON.stringify(error.response.data)}`));
    }
    return false;
  }
}

/**
 * Test AI CLI prompt execution
 */
async function testPromptExecution(terminalId) {
  try {
    console.log(chalk.yellow('🤖 Testing AI CLI prompt execution...'));
    
    const promptResponse = await axios.post(`${API_URL}/api/terminals/${terminalId}/prompt`, {
      prompt: 'Please respond with "Hello from headless mode" to confirm you received this test prompt.',
      cliType: 'claude'
    }, {
      headers: { 
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json'
      },
      timeout: 30000
    });
    
    console.log(chalk.green('✅ Prompt execution successful'));
    console.log(chalk.gray(`   Response: ${JSON.stringify(promptResponse.data)}`));
    
    return true;
  } catch (error) {
    console.error(chalk.red(`❌ Prompt execution failed: ${error.message}`));
    return false;
  }
}

/**
 * Main test execution
 */
async function runTests() {
  let allTestsPassed = true;
  
  console.log(chalk.cyan('🚀 Starting headless integration tests...\n'));
  
  // Test 1: API Connectivity
  const apiConnected = await testAPIConnectivity();
  if (!apiConnected) {
    console.log(chalk.red('\n❌ Auto-Terminal not running in headless mode'));
    console.log(chalk.yellow('   Please start Auto-Terminal with: npm run start:headless'));
    return false;
  }
  
  // Test 2: WebSocket Connectivity
  const wsConnected = await testWebSocketConnectivity();
  allTestsPassed = allTestsPassed && wsConnected;
  
  // Test 3: Terminal Operations
  const terminalOpsWorking = await testTerminalCreation();
  allTestsPassed = allTestsPassed && terminalOpsWorking;
  
  console.log(chalk.cyan('\n📊 Test Results:'));
  console.log(`API Connection: ${apiConnected ? chalk.green('✅ PASS') : chalk.red('❌ FAIL')}`);
  console.log(`WebSocket Connection: ${wsConnected ? chalk.green('✅ PASS') : chalk.red('❌ FAIL')}`);
  console.log(`Terminal Operations: ${terminalOpsWorking ? chalk.green('✅ PASS') : chalk.red('❌ FAIL')}`);
  
  if (allTestsPassed) {
    console.log(chalk.green('\n🎉 All tests passed! Agent-Monitor headless integration is working correctly.'));
    console.log(chalk.blue('✨ You can now use: npm run team:headless'));
  } else {
    console.log(chalk.red('\n❌ Some tests failed. Please check the Auto-Terminal headless mode setup.'));
  }
  
  return allTestsPassed;
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log(chalk.yellow('\n🛑 Test interrupted'));
  process.exit(1);
});

// Run tests
runTests()
  .then(success => process.exit(success ? 0 : 1))
  .catch(error => {
    console.error(chalk.red(`\n💥 Test execution failed: ${error.message}`));
    process.exit(1);
  });