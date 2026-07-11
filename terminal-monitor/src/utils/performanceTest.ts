/**
 * Performance testing utilities for high-frequency WebSocket message handling
 */

import webSocketService from '../services/WebSocketService';

interface PerformanceTestOptions {
  messagesPerSecond: number;
  durationSeconds: number;
  terminalIds: string[];
  messageSize: number;
}

export class PerformanceTestHelper {
  private testInterval: NodeJS.Timeout | null = null;
  private testStartTime: number = 0;
  private messagesSent: number = 0;

  /**
   * Simulate high-frequency WebSocket messages for performance testing
   */
  startHighFrequencyTest(options: PerformanceTestOptions) {
    const {
      messagesPerSecond,
      durationSeconds,
      terminalIds,
      messageSize
    } = options;

    console.log(`🚀 Starting performance test:`);
    console.log(`  - Messages per second: ${messagesPerSecond}`);
    console.log(`  - Duration: ${durationSeconds} seconds`);
    console.log(`  - Terminals: ${terminalIds.length}`);
    console.log(`  - Message size: ${messageSize} chars`);

    this.testStartTime = Date.now();
    this.messagesSent = 0;

    // Generate test message content
    const testMessage = this.generateTestMessage(messageSize);

    // Calculate interval between messages
    const intervalMs = 1000 / messagesPerSecond;

    this.testInterval = setInterval(() => {
      // Send message to random terminal
      const terminalId = terminalIds[Math.floor(Math.random() * terminalIds.length)];
      
      // Simulate WebSocket message
      const mockEvent = {
        type: 'event' as const,
        event: {
          type: 'output.data',
          terminalId,
          data: {
            content: testMessage + ` [${this.messagesSent}]\n`
          }
        },
        timestamp: new Date().toISOString()
      };

      // Call the private method via reflection for testing
      (webSocketService as any).handleEventMessage(mockEvent);
      this.messagesSent++;

      // Stop test after duration
      if (Date.now() - this.testStartTime >= durationSeconds * 1000) {
        this.stopTest();
      }
    }, intervalMs);

    // Auto-stop after duration
    setTimeout(() => {
      this.stopTest();
    }, durationSeconds * 1000);
  }

  /**
   * Stop the performance test and report results
   */
  stopTest() {
    if (this.testInterval) {
      clearInterval(this.testInterval);
      this.testInterval = null;
    }

    const testDuration = (Date.now() - this.testStartTime) / 1000;
    const actualRate = this.messagesSent / testDuration;

    console.log(`✅ Performance test completed:`);
    console.log(`  - Messages sent: ${this.messagesSent}`);
    console.log(`  - Duration: ${testDuration.toFixed(2)}s`);
    console.log(`  - Actual rate: ${actualRate.toFixed(2)} msg/sec`);
    
    // Get WebSocket service performance metrics
    const metrics = webSocketService.getPerformanceMetrics();
    console.log(`  - Peak rate detected: ${metrics.messagesPerSecond} msg/sec`);
    console.log(`  - Adaptive batching working: ${metrics.messagesPerSecond > 50 ? '✅' : '❌'}`);
  }

  /**
   * Generate test message content of specified size
   */
  private generateTestMessage(size: number): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 .,!?\n';
    let message = '';
    
    for (let i = 0; i < size; i++) {
      message += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    return message;
  }

  /**
   * Test different scenarios
   */
  static runStandardTests(terminalIds: string[]) {
    const tester = new PerformanceTestHelper();
    
    console.log('🔬 Running standard performance tests...');
    
    // Test 1: Moderate load
    setTimeout(() => {
      console.log('\n📊 Test 1: Moderate load (50 msg/sec)');
      tester.startHighFrequencyTest({
        messagesPerSecond: 50,
        durationSeconds: 10,
        terminalIds,
        messageSize: 100
      });
    }, 1000);

    // Test 2: High load
    setTimeout(() => {
      console.log('\n📊 Test 2: High load (200 msg/sec)');
      tester.startHighFrequencyTest({
        messagesPerSecond: 200,
        durationSeconds: 10,
        terminalIds,
        messageSize: 200
      });
    }, 12000);

    // Test 3: Very high load
    setTimeout(() => {
      console.log('\n📊 Test 3: Very high load (500 msg/sec)');
      tester.startHighFrequencyTest({
        messagesPerSecond: 500,
        durationSeconds: 10,
        terminalIds,
        messageSize: 50
      });
    }, 24000);

    // Test 4: Extreme load (1000 msg/sec)
    setTimeout(() => {
      console.log('\n📊 Test 4: Extreme load (1000 msg/sec)');
      tester.startHighFrequencyTest({
        messagesPerSecond: 1000,
        durationSeconds: 5,
        terminalIds,
        messageSize: 50
      });
    }, 36000);
  }
}

// Make it available on window for testing in browser console
declare global {
  interface Window {
    PerformanceTestHelper: typeof PerformanceTestHelper;
  }
}

if (typeof window !== 'undefined') {
  window.PerformanceTestHelper = PerformanceTestHelper;
}

export default PerformanceTestHelper;