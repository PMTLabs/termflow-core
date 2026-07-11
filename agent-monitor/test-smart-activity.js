/**
 * Test script to demonstrate the Smart Activity Detector
 * 
 * This script simulates WebSocket events from Auto-Terminal to show
 * how the ActivityDetector processes process.activity and process.inactive events
 * to make intelligent decisions about agent activity status.
 */

const { ActivityDetector } = require('./dist/activity-detector');

// Create activity detector with test configuration
const detector = new ActivityDetector({
  minActivityThreshold: 2,        // 2 activity events for active status
  maxInactivityThreshold: 120000, // 2 minutes max inactivity (faster for testing)
  confidenceThreshold: 0.6,       // 60% confidence minimum
  decisionCooldown: 10000,        // 10 seconds between decisions (faster for testing)
  shortTermWindow: 60000,         // 1 minute short term window
  mediumTermWindow: 300000        // 5 minutes medium term window
});

// Listen for activity decisions
detector.on('activityDecision', (decision) => {
  console.log(`\n🎯 ACTIVITY DECISION:`);
  console.log(`   Terminal: ${decision.terminalId}`);
  console.log(`   Status: ${decision.previousStatus} → ${decision.newStatus}`);
  console.log(`   Confidence: ${Math.round(decision.confidence * 100)}%`);
  console.log(`   Reason: ${decision.reason}`);
  console.log(`   Trigger: ${decision.triggerEvent.type}`);
});

// Test scenarios
async function runTests() {
  console.log('🧪 Testing Smart Activity Detector\n');
  
  const terminalId = 'headless-test-12345';
  let timestamp = Date.now();
  
  console.log('📋 Test 1: Agent starts working (process.activity events)');
  
  // Simulate agent starting to work
  detector.processEvent(terminalId, 'process.activity', timestamp, { reason: 'agent_started' });
  await sleep(2000);
  
  detector.processEvent(terminalId, 'process.activity', timestamp + 15000, { reason: 'continuing_work' });
  await sleep(2000);
  
  detector.processEvent(terminalId, 'process.activity', timestamp + 30000, { reason: 'still_active' });
  await sleep(2000);
  
  console.log('\n📋 Test 2: Agent goes idle (process.inactive events)');
  
  // Simulate agent going idle
  detector.processEvent(terminalId, 'process.inactive', timestamp + 150000, { inactiveTime: 60000 });
  await sleep(2000);
  
  detector.processEvent(terminalId, 'process.inactive', timestamp + 180000, { inactiveTime: 90000 });
  await sleep(2000);
  
  console.log('\n📋 Test 3: Agent resumes activity');
  
  // Agent becomes active again
  detector.processEvent(terminalId, 'process.activity', timestamp + 200000, { reason: 'resumed_work' });
  await sleep(2000);
  
  detector.processEvent(terminalId, 'process.activity', timestamp + 220000, { reason: 'working_again' });
  await sleep(2000);
  
  console.log('\n📋 Test 4: Mixed activity pattern');
  
  // Mixed pattern to test the algorithm
  const baseTime = timestamp + 300000;
  detector.processEvent(terminalId, 'process.activity', baseTime, {});
  await sleep(1000);
  
  detector.processEvent(terminalId, 'process.inactive', baseTime + 10000, {});
  await sleep(1000);
  
  detector.processEvent(terminalId, 'process.activity', baseTime + 20000, {});
  await sleep(1000);
  
  detector.processEvent(terminalId, 'process.activity', baseTime + 25000, {});
  await sleep(1000);
  
  detector.processEvent(terminalId, 'process.inactive', baseTime + 90000, {});
  await sleep(2000);
  
  // Show final statistics
  console.log('\n📊 Final Statistics:');
  const stats = detector.getTerminalStats(terminalId);
  if (stats) {
    console.log(`   Status: ${stats.status} (${Math.round(stats.confidence * 100)}% confidence)`);
    console.log(`   Time since last activity: ${Math.round(stats.timeSinceLastActivity / 1000)}s`);
    console.log(`   Total events: ${stats.totalEvents}`);
    console.log(`   Recent activity events: ${stats.recentActivityEvents}`);
    console.log(`   Recent inactivity events: ${stats.recentInactivityEvents}`);
    console.log(`   Activity streak: ${stats.activityStreak}`);
    console.log(`   Inactivity streak: ${stats.inactivityStreak}`);
    console.log(`   Average activity interval: ${Math.round(stats.averageActivityInterval / 1000)}s`);
  }
  
  const detectorStats = detector.getDetectorStats();
  console.log(`\n🔍 Detector Statistics:`);
  console.log(`   Tracked terminals: ${detectorStats.trackedTerminals}`);
  console.log(`   Total decisions: ${detectorStats.totalDecisions}`);
  console.log(`   Recent decisions: ${detectorStats.recentDecisions}`);
  
  console.log('\n✅ Test completed!');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run the tests
runTests().catch(console.error);