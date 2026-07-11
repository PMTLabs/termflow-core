/**
 * Simple test to verify pause/resume pattern detection
 */

// Mock the TeamOrchestrator class methods we want to test
class MockTeamOrchestrator {
  constructor() {
    this.isPaused = false;
    this.pausedBy = '';
    this.pausedAt = null;
  }

  /**
   * Check if message contains pause command
   */
  isPauseCommand(content) {
    const pausePatterns = [
      'done',
      'stop',
      'pause',
      'halt',
      'hold',
      'wait',
      'suspend',
      'finish',
      'complete',
      'end'
    ];
    
    return pausePatterns.some(pattern => 
      content === pattern ||
      content.includes(`${pattern} agents`) ||
      content.includes(`${pattern} monitoring`) ||
      content.includes(`${pattern} team`) ||
      content.includes(`${pattern} for now`) ||
      content.includes(`${pattern} work`) ||
      content.includes(`${pattern} everything`) ||
      content.includes(`${pattern} all`) ||
      (pattern === 'done' && (content.includes('all done') || content.includes('we are done'))) ||
      (pattern === 'stop' && (content.includes('stop all') || content.includes('stop now')))
    );
  }
  
  /**
   * Check if message contains resume command
   */
  isResumeCommand(content) {
    const resumePatterns = [
      'continue',
      'resume',
      'start',
      'go',
      'proceed',
      'keep going',
      'carry on',
      'restart',
      'begin again',
      'activate again',
      'back to work',
      'let\'s go'
    ];
    
    return resumePatterns.some(pattern => content.includes(pattern));
  }

  /**
   * Check for human indicators
   */
  isHumanMessage(message) {
    const humanIndicators = [
      'human',
      'admin',
      'user',
      'monitor',
      'supervisor',
      'manager'
    ];
    
    const senderName = message.senderName?.toLowerCase() || '';
    
    // Check if sender name contains human indicators
    if (humanIndicators.some(indicator => senderName.includes(indicator))) {
      return true;
    }
    
    // Check if message contains override commands typically used by humans
    const content = message.content?.toLowerCase() || '';
    const overridePatterns = [
      'activate agent',
      'force activate',
      'override activate',
      'human command',
      'admin command',
      'monitor command',
      'urgent activate',
      'immediately activate'
    ];
    
    return overridePatterns.some(pattern => content.includes(pattern)) ||
           this.isPauseCommand(content) ||
           this.isResumeCommand(content);
  }

  // Mock pause/resume functionality
  handlePause(message) {
    if (this.isPaused) {
      console.log(`⏸️ System already paused by ${this.pausedBy}`);
      return;
    }
    
    this.isPaused = true;
    this.pausedBy = message.senderName;
    this.pausedAt = new Date();
    
    console.log(`⏸️ SYSTEM PAUSED by ${message.senderName} at ${this.pausedAt.toLocaleString()}`);
    console.log(`   Message: "${message.content}"`);
    console.log(`   All agent monitoring and activation suspended`);
  }

  handleResume(message) {
    if (!this.isPaused) {
      console.log(`▶️ System is already running normally`);
      return;
    }
    
    const pauseDuration = this.pausedAt ? Date.now() - this.pausedAt.getTime() : 0;
    const previousPausedBy = this.pausedBy;
    
    this.isPaused = false;
    this.pausedBy = '';
    this.pausedAt = null;
    
    console.log(`▶️ SYSTEM RESUMED by ${message.senderName}`);
    console.log(`   Previously paused by: ${previousPausedBy}`);
    console.log(`   Pause duration: ${Math.round(pauseDuration / 1000)}s`);
    console.log(`   Agent monitoring and activation restored`);
  }
}

function testPatterns() {
  console.log('🧪 Testing Human Pause/Resume Pattern Detection\n');
  
  const orchestrator = new MockTeamOrchestrator();
  
  // Test pause patterns
  console.log('📋 Testing PAUSE patterns:');
  const pauseTestCases = [
    'DONE',
    'done for now',
    'stop all agents',
    'pause team',
    'halt everything',
    'we are done',
    'all done',
    'stop work',
    'pause monitoring',
    'complete for today',
    'finish work',
    'end session'
  ];
  
  pauseTestCases.forEach((testCase, index) => {
    const result = orchestrator.isPauseCommand(testCase.toLowerCase());
    console.log(`  ${index + 1}. "${testCase}" → ${result ? '✅ PAUSE' : '❌ No match'}`);
  });
  
  console.log('\n📋 Testing RESUME patterns:');
  const resumeTestCases = [
    'continue',
    'resume work',
    'keep going',
    'start again',
    'proceed',
    'back to work',
    'let\'s go',
    'carry on',
    'restart monitoring',
    'begin again',
    'activate again'
  ];
  
  resumeTestCases.forEach((testCase, index) => {
    const result = orchestrator.isResumeCommand(testCase.toLowerCase());
    console.log(`  ${index + 1}. "${testCase}" → ${result ? '✅ RESUME' : '❌ No match'}`);
  });
  
  console.log('\n📋 Testing Human Message Detection:');
  const humanTestCases = [
    { senderName: 'Human Supervisor', content: 'done for now' },
    { senderName: 'Admin User', content: 'pause all agents' },
    { senderName: 'Monitor Bot', content: 'continue work' },
    { senderName: 'Regular Agent', content: 'activate agent' },
    { senderName: 'Manager John', content: 'stop everything' },
    { senderName: 'User123', content: 'human command: stop' }
  ];
  
  humanTestCases.forEach((testCase, index) => {
    const result = orchestrator.isHumanMessage(testCase);
    console.log(`  ${index + 1}. ${testCase.senderName}: "${testCase.content}" → ${result ? '✅ Human' : '❌ Not human'}`);
  });
  
  console.log('\n📋 Testing Full Pause/Resume Flow:');
  
  // Test pause
  const pauseMessage = {
    senderName: 'Human Supervisor',
    content: 'DONE for now, pause all agents',
    timestamp: Date.now()
  };
  
  console.log(`\n👨‍💻 Human says: "${pauseMessage.content}"`);
  if (orchestrator.isPauseCommand(pauseMessage.content.toLowerCase())) {
    orchestrator.handlePause(pauseMessage);
  }
  
  // Wait a bit
  setTimeout(() => {
    // Test resume
    const resumeMessage = {
      senderName: 'Human Supervisor',
      content: 'continue work, resume monitoring',
      timestamp: Date.now()
    };
    
    console.log(`\n👨‍💻 Human says: "${resumeMessage.content}"`);
    if (orchestrator.isResumeCommand(resumeMessage.content.toLowerCase())) {
      orchestrator.handleResume(resumeMessage);
    }
    
    console.log('\n✅ Pattern detection testing completed!');
  }, 2000);
}

// Run the tests
testPatterns();