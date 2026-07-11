/**
 * Test script for Human Pause/Resume functionality
 * 
 * This script tests the ability for humans to pause and resume
 * the agent monitoring system via ChatHub messages.
 */

const { TeamOrchestrator } = require('./dist/team-orchestrator');
const { AutoTerminalClient } = require('./dist/api-client');
const { AgentDetector } = require('./dist/agent-detector');
const { PromptManager } = require('./dist/prompt-manager');

// Mock clients and config for testing
class MockClient {
  constructor() {
    this.terminals = new Map();
  }
  
  async createTerminal() {
    const id = `test-terminal-${Date.now()}`;
    this.terminals.set(id, { id, status: 'running' });
    return { terminalId: id };
  }
  
  async sendToTerminal(terminalId, command) {
    console.log(`📤 Sent to ${terminalId}: ${command}`);
  }
  
  on() {} // Mock event listener
}

class MockDetector {
  detectAgents() {
    return Promise.resolve([
      { terminalId: 'test-terminal-1', agentInfo: { name: 'Test Agent', role: 'coordinator' } }
    ]);
  }
}

class MockPromptManager {
  getKickoffPrompt() {
    return 'Test kickoff prompt';
  }
}

async function testPauseResume() {
  console.log('🧪 Testing Human Pause/Resume Control System\n');
  
  // Create team config
  const testConfig = {
    name: 'Test Team',
    agents: [
      {
        id: 'agent1',
        name: 'Test Agent 1',
        role: 'Project Coordinator',
        cliType: 'claude',
        responsibilities: ['testing']
      },
      {
        id: 'agent2',
        name: 'Test Agent 2',
        role: 'frontend',
        cliType: 'claude',
        responsibilities: ['ui testing']
      }
    ],
    teamConfig: {
      projectFolder: './test-project',
      chatHubChannel: 'test-channel'
    }
  };
  
  // Write temporary config file
  const fs = require('fs');
  const configPath = './test-team-config.json';
  fs.writeFileSync(configPath, JSON.stringify(testConfig, null, 2));
  
  try {
    // Initialize orchestrator
    const client = new MockClient();
    const detector = new MockDetector();
    const promptManager = new MockPromptManager();
    
    const orchestrator = new TeamOrchestrator(
      client,
      detector,
      promptManager,
      configPath,
      'ws://localhost:8080',
      false
    );
    
    // Test pause commands
    console.log('📋 Test 1: Human sends PAUSE command');
    const pauseMessage = {
      senderName: 'Human Supervisor',
      content: 'DONE for now, pause all agents',
      timestamp: Date.now()
    };
    
    // Simulate human message handling
    await simulateHumanMessage(orchestrator, pauseMessage);
    await sleep(1000);
    
    console.log('\n📋 Test 2: Try to activate agent while paused');
    const activationMessage = {
      senderName: 'Agent Assistant',
      content: 'activate agent @Test Agent 1',
      timestamp: Date.now()
    };
    
    await simulateHumanMessage(orchestrator, activationMessage);
    await sleep(1000);
    
    console.log('\n📋 Test 3: Human sends RESUME command');
    const resumeMessage = {
      senderName: 'Human Supervisor',
      content: 'continue work, resume monitoring',
      timestamp: Date.now()
    };
    
    await simulateHumanMessage(orchestrator, resumeMessage);
    await sleep(1000);
    
    console.log('\n📋 Test 4: Test different pause patterns');
    const pausePatterns = [
      'STOP all agents',
      'done',
      'pause team',
      'halt everything',
      'we are done for now'
    ];
    
    for (const pattern of pausePatterns) {
      console.log(`\n🔍 Testing pause pattern: "${pattern}"`);
      const message = {
        senderName: 'Human Tester',
        content: pattern,
        timestamp: Date.now()
      };
      
      await simulateHumanMessage(orchestrator, message);
      await sleep(500);
      
      // Test resume
      const resumeMessage = {
        senderName: 'Human Tester',
        content: 'resume',
        timestamp: Date.now()
      };
      
      await simulateHumanMessage(orchestrator, resumeMessage);
      await sleep(500);
    }
    
    console.log('\n📋 Test 5: Test resume patterns');
    
    // Pause first
    await simulateHumanMessage(orchestrator, {
      senderName: 'Human Tester',
      content: 'pause',
      timestamp: Date.now()
    });
    
    const resumePatterns = [
      'continue',
      'keep going',
      'resume work',
      'start again',
      'proceed',
      'back to work'
    ];
    
    for (const pattern of resumePatterns) {
      console.log(`\n🔍 Testing resume pattern: "${pattern}"`);
      const message = {
        senderName: 'Human Tester',
        content: pattern,
        timestamp: Date.now()
      };
      
      await simulateHumanMessage(orchestrator, message);
      await sleep(500);
    }
    
    console.log('\n✅ Pause/Resume testing completed!');
    
  } catch (error) {
    console.error('❌ Test failed:', error);
  } finally {
    // Cleanup
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
  }
}

async function simulateHumanMessage(orchestrator, message) {
  console.log(`👨‍💻 Human Message: "${message.content}" from ${message.senderName}`);
  
  // Access private method for testing (normally this would be called via ChatHub)
  if (orchestrator.analyzeMessage) {
    await orchestrator.analyzeMessage(message);
  } else {
    console.log('⚠️ analyzeMessage method not accessible for testing');
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the tests
testPauseResume().catch(console.error);