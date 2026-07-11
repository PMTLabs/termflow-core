/**
 * Test WebSocket event flow from Auto-Terminal to agent-monitor
 * 
 * This test verifies that process.activity and process.inactive events
 * are properly transmitted from Auto-Terminal via WebSocket to agent-monitor
 */

const WebSocket = require('ws');

class WebSocketEventTester {
  constructor() {
    this.receivedEvents = [];
    this.ws = null;
  }

  async testWebSocketConnection() {
    console.log('🧪 Testing WebSocket Event Flow from Auto-Terminal\n');
    
    try {
      // Get API token from environment
      require('dotenv').config();
      const apiToken = process.env.API_TOKEN;
      
      if (!apiToken) {
        throw new Error('API_TOKEN not found in environment variables');
      }
      
      // Connect to Auto-Terminal WebSocket API with authentication
      const wsUrl = `ws://localhost:9876?token=${apiToken}&mode=headless`;
      console.log(`📡 Connecting to Auto-Terminal WebSocket: ws://localhost:9876`);
      console.log(`🔐 Using authentication token: ${apiToken.substring(0, 20)}...`);
      
      this.ws = new WebSocket(wsUrl, {
        headers: {
          'Authorization': `Bearer ${apiToken}`,
          'X-Client-Mode': 'headless'
        }
      });
      
      return new Promise((resolve, reject) => {
        let connectionTimeout = setTimeout(() => {
          reject(new Error('WebSocket connection timeout'));
        }, 10000);

        this.ws.on('open', () => {
          clearTimeout(connectionTimeout);
          console.log('✅ Connected to Auto-Terminal WebSocket');
          
          // Subscribe to all events
          const subscribeMessage = {
            id: 'test-subscription',
            type: 'subscribe',
            payload: {
              patterns: ['*'], // Subscribe to all events
              includeHistory: false
            }
          };
          
          this.ws.send(JSON.stringify(subscribeMessage));
          console.log('📝 Subscribed to all WebSocket events');
          
          // Set up event listener
          this.ws.on('message', (data) => {
            try {
              const message = JSON.parse(data.toString());
              this.handleWebSocketMessage(message);
            } catch (error) {
              console.error('❌ Failed to parse WebSocket message:', error);
            }
          });
          
          // Wait for some events to come in
          setTimeout(() => {
            this.analyzeReceivedEvents();
            resolve();
          }, 15000);
        });

        this.ws.on('error', (error) => {
          clearTimeout(connectionTimeout);
          console.error('❌ WebSocket connection error:', error.message);
          reject(error);
        });

        this.ws.on('close', () => {
          console.log('📡 WebSocket connection closed');
        });
      });
      
    } catch (error) {
      console.error('❌ WebSocket test failed:', error.message);
      console.log('\n💡 Troubleshooting steps:');
      console.log('1. Make sure Auto-Terminal is running');
      console.log('2. Verify WebSocket server is active on port 9876');
      console.log('3. Check if there are active terminals generating events');
    }
  }

  handleWebSocketMessage(message) {
    if (message.type === 'event' && message.event) {
      const event = message.event;
      this.receivedEvents.push(event);
      
      // Log process activity/inactive events specifically
      if (event.type === 'process.activity') {
        console.log(`🔄 Received process.activity: terminal=${event.terminalId}, timestamp=${new Date(event.timestamp).toLocaleTimeString()}`);
      } else if (event.type === 'process.inactive') {
        console.log(`💤 Received process.inactive: terminal=${event.terminalId}, inactiveTime=${event.data?.inactiveTime}ms`);
      } else if (event.type.startsWith('process.')) {
        console.log(`📊 Received ${event.type}: terminal=${event.terminalId}`);
      }
    } else if (message.type === 'response') {
      console.log(`📋 WebSocket response: ${message.success ? 'Success' : 'Error'}: ${JSON.stringify(message.data || message.error)}`);
    }
  }

  analyzeReceivedEvents() {
    console.log('\n📊 WebSocket Event Analysis:');
    console.log(`Total events received: ${this.receivedEvents.length}`);
    
    const eventTypes = {};
    this.receivedEvents.forEach(event => {
      eventTypes[event.type] = (eventTypes[event.type] || 0) + 1;
    });
    
    console.log('\nEvent types and counts:');
    Object.entries(eventTypes).forEach(([type, count]) => {
      const status = (type === 'process.activity' || type === 'process.inactive') ? '✅' : '📝';
      console.log(`  ${status} ${type}: ${count}`);
    });
    
    // Check for critical events
    const hasProcessActivity = eventTypes['process.activity'] > 0;
    const hasProcessInactive = eventTypes['process.inactive'] > 0;
    
    console.log('\n🔍 Critical Event Status:');
    console.log(`  process.activity events: ${hasProcessActivity ? '✅ FOUND' : '❌ MISSING'}`);
    console.log(`  process.inactive events: ${hasProcessInactive ? '✅ FOUND' : '❌ MISSING'}`);
    
    if (!hasProcessActivity && !hasProcessInactive) {
      console.log('\n⚠️ Missing process activity events! Possible issues:');
      console.log('1. ProcessMonitor not running in Auto-Terminal');
      console.log('2. No active terminals with process activity');
      console.log('3. EventBus not publishing process events');
      console.log('4. WebSocket server not forwarding process events');
    }
    
    // Show sample process events
    const processEvents = this.receivedEvents.filter(e => 
      e.type === 'process.activity' || e.type === 'process.inactive'
    );
    
    if (processEvents.length > 0) {
      console.log('\n📋 Sample Process Events:');
      processEvents.slice(0, 3).forEach((event, index) => {
        console.log(`  ${index + 1}. ${event.type}`);
        console.log(`     Terminal: ${event.terminalId}`);
        console.log(`     Timestamp: ${new Date(event.timestamp).toLocaleString()}`);
        console.log(`     Data: ${JSON.stringify(event.data, null, 2)}`);
      });
    }

    // Test agent-monitor integration readiness  
    console.log('\n🤖 Agent-Monitor Integration Status:');
    if (hasProcessActivity || hasProcessInactive) {
      console.log('✅ Auto-Terminal is emitting process events');
      console.log('✅ WebSocket server is forwarding events');
      console.log('✅ Agent-monitor should receive these events');
      console.log('✅ Smart Activity Detector should work correctly');
    } else {
      console.log('❌ Process events not detected');
      console.log('❌ Smart Activity Detector may not function');
      console.log('❌ Agent status detection will be limited');
    }
  }

  close() {
    if (this.ws) {
      this.ws.close();
    }
  }
}

// Run the test
async function main() {
  const tester = new WebSocketEventTester();
  
  try {
    await tester.testWebSocketConnection();
  } catch (error) {
    console.error('Test failed:', error.message);
  } finally {
    tester.close();
  }
}

// Handle cleanup on exit
process.on('SIGINT', () => {
  console.log('\n👋 Test interrupted, cleaning up...');
  process.exit(0);
});

main().catch(console.error);