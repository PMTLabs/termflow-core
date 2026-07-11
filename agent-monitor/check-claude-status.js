/**
 * Example: How to check if Claude CLI is running
 * 
 * This shows different ways to detect and monitor Claude CLI status
 */

const { AutoTerminalClient } = require('./dist/api-client');
const { AgentDetector } = require('./dist/agent-detector');
require('dotenv').config();

async function checkClaudeStatus() {
  // Initialize client
  const client = new AutoTerminalClient({
    apiUrl: process.env.API_URL || 'http://localhost:3001',
    wsUrl: process.env.WS_URL || 'ws://localhost:9876',
    token: process.env.API_TOKEN || '',
    autoReconnect: true,
    reconnectInterval: 5000
  });

  // Initialize detector
  const detector = new AgentDetector();

  try {
    // Connect to WebSocket
    await client.connect();
    console.log('Connected to Auto-Terminal\n');

    // Get all terminals
    const terminals = await client.getTerminals();
    console.log(`Found ${terminals.length} terminals\n`);

    // Check each terminal
    for (const terminal of terminals) {
      console.log(`Checking terminal: ${terminal.name} (${terminal.id})`);
      
      // Get recent output to analyze
      const output = await client.getOutput(terminal.id, 50);
      
      // Process the output through detector
      detector.processOutput({
        id: 'check',
        timestamp: new Date().toISOString(),
        terminalId: terminal.id,
        processId: terminal.processId,
        type: 'output.data',
        data: { content: output.raw }
      });

      // Check if Claude is detected
      const activeAgent = detector.getActiveAgent(terminal.id);
      
      if (activeAgent === 'claude') {
        console.log('✅ Claude CLI is running in this terminal\n');
        
        // You can also check Claude patterns in the output
        if (output.raw.includes('Claude>') || output.raw.includes('Human:')) {
          console.log('   Claude prompt detected in output');
        }
      } else if (activeAgent) {
        console.log(`🤖 Different AI detected: ${activeAgent}\n`);
      } else {
        console.log('❌ No AI agent detected in this terminal\n');
        
        // Check if Claude might be installed but not running
        if (output.raw.includes('command not found: claude')) {
          console.log('   ⚠️  Claude CLI might not be installed');
        }
      }
    }

    // Method 2: Subscribe to real-time events
    console.log('\n--- Real-time monitoring ---');
    console.log('Subscribing to terminal events...\n');

    // Listen for agent detection
    detector.on('agentDetected', ({ terminalId, agentType }) => {
      if (agentType === 'claude') {
        console.log(`🎉 Claude CLI just started in terminal ${terminalId}`);
      }
    });

    // Subscribe to terminal output events
    client.on('output.data', (event) => {
      detector.processOutput(event);
    });

    // Wait for real-time events
    console.log('Monitoring for Claude CLI activity (press Ctrl+C to stop)...\n');

  } catch (error) {
    console.error('Error:', error.message);
  }
}

// Run the check
checkClaudeStatus();