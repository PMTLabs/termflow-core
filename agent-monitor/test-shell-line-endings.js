#!/usr/bin/env node

// Test shell-specific line endings: \r\n for CMD/PowerShell, \n for Git Bash
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');

async function testShellLineEndings() {
  console.log('🧪 TESTING SHELL-SPECIFIC LINE ENDINGS');
  console.log('='.repeat(50));
  console.log('CMD/PowerShell: \\r\\n | Git Bash: \\n\n');
  
  const CONFIG = {
    apiUrl: process.env.API_URL || 'http://localhost:3001',
    wsUrl: process.env.WS_URL || 'ws://localhost:9876',
    token: process.env.API_TOKEN || ''
  };

  const client = new AutoTerminalClient({
    apiUrl: CONFIG.apiUrl,
    wsUrl: CONFIG.wsUrl,
    token: CONFIG.token,
    autoReconnect: false
  });

  // Helper function matching the team-orchestrator logic
  function getShellLineEnding(shellProfile) {
    switch (shellProfile?.toLowerCase()) {
      case 'cmd':
      case 'powershell':
      case 'pwsh':
        return '\\r\\n';
      case 'bash':
      case 'git-bash':
        return '\\n';
      default:
        return '\\r\\n';
    }
  }

  try {
    await client.connect();
    console.log('✅ Connected to Auto-Terminal\n');

    // Test different shell types
    const shellTests = [
      { profile: 'cmd', expected: '\\r\\n', command: 'echo "CMD Line Ending Test"' },
      { profile: 'powershell', expected: '\\r\\n', command: 'Write-Output "PowerShell Line Ending Test"' },
      { profile: 'bash', expected: '\\n', command: 'echo "Git Bash Line Ending Test"' }
    ];

    const terminals = [];
    
    // Create terminals for each shell type
    for (const test of shellTests) {
      try {
        console.log(`🔧 Creating ${test.profile.toUpperCase()} terminal...`);
        
        const terminal = await client.createTerminal({
          name: `Line Ending Test - ${test.profile.toUpperCase()}`,
          profile: test.profile
        });
        
        terminals.push({ ...terminal, shellProfile: test.profile, testCommand: test.command });
        
        const lineEnding = getShellLineEnding(test.profile);
        console.log(`✅ Created ${test.profile} terminal: ${terminal.id}`);
        console.log(`   Expected line ending: ${test.expected}`);
        console.log(`   Using line ending: ${lineEnding}`);
        console.log('');
        
        await sleep(2000);
        
      } catch (error) {
        console.log(`❌ Failed to create ${test.profile} terminal: ${error.message}\n`);
      }
    }

    // Test commands with appropriate line endings
    console.log('📤 TESTING COMMANDS WITH SHELL-SPECIFIC LINE ENDINGS\n');
    
    for (let i = 0; i < terminals.length; i++) {
      const terminal = terminals[i];
      const lineEnding = getShellLineEnding(terminal.shellProfile);
      
      console.log(`🎯 Testing Terminal ${i + 1}: ${terminal.shellProfile.toUpperCase()}`);
      console.log(`   Terminal ID: ${terminal.id}`);
      console.log(`   Line Ending: ${lineEnding}`);
      console.log(`   Command: ${terminal.testCommand}`);
      
      // Send command with correct line ending
      await client.sendInput(terminal.id, terminal.testCommand + lineEnding);
      
      await sleep(2000);
      
      // Send verification command
      const timestamp = new Date().toLocaleTimeString();
      const verifyCommand = terminal.shellProfile === 'bash' 
        ? `echo "[${timestamp}] ${terminal.shellProfile} line ending working!"`
        : terminal.shellProfile === 'powershell'
          ? `Write-Output "[${timestamp}] ${terminal.shellProfile} line ending working!"`
          : `echo [${timestamp}] ${terminal.shellProfile} line ending working!`;
      
      console.log(`   Verification: ${verifyCommand}`);
      await client.sendInput(terminal.id, verifyCommand + lineEnding);
      
      await sleep(2000);
      console.log(`   ✅ Commands sent to ${terminal.shellProfile} terminal\n`);
    }

    console.log('💡 EXPECTED RESULTS:');
    console.log('   ✅ All commands should execute immediately');
    console.log('   ✅ No hanging input (commands waiting for execution)');
    console.log('   ✅ Each shell type should respond correctly to its line ending');
    console.log('');
    console.log('❌ IF COMMANDS HANG:');
    console.log('   → Wrong line ending for that shell type');
    console.log('   → Commands typed but not executed');
    console.log('');
    console.log('🔍 VERIFICATION IN AUTO-TERMINAL:');
    console.log('   • CMD terminal: Should show echo output immediately');
    console.log('   • PowerShell terminal: Should show Write-Output immediately');
    console.log('   • Bash terminal: Should show echo output immediately');
    console.log('   • All terminals should show timestamp verification messages');

    console.log('\\n📊 LINE ENDING MAPPING:');
    console.log('   cmd: \\r\\n (Windows CMD)');
    console.log('   powershell: \\r\\n (Windows PowerShell)');
    console.log('   pwsh: \\r\\n (PowerShell Core)');
    console.log('   bash: \\n (Git Bash/Unix-style)');
    console.log('   default: \\r\\n (Windows default)');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
  } finally {
    await client.disconnect();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

testShellLineEndings().catch(console.error);