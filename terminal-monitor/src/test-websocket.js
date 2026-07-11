// Simple WebSocket connection test
// Run this with: node src/test-websocket.js

const WebSocket = require('ws');

// Test basic WebSocket connection
console.log('Testing WebSocket connection to ws://localhost:42031/ws...');

// First test without token
const ws1 = new WebSocket('ws://localhost:42031/ws');

ws1.on('open', () => {
    console.log('✅ WebSocket server is reachable (without token)');
    ws1.close();
});

ws1.on('error', (error) => {
    console.log('❌ WebSocket server error (without token):', error.message);
});

ws1.on('close', (code, reason) => {
    console.log(`WebSocket closed (without token): ${code} - ${reason}`);
    
    // Now test with a dummy token
    console.log('\nTesting with dummy token...');
    const ws2 = new WebSocket('ws://localhost:42031/ws?token=dummy');
    
    ws2.on('open', () => {
        console.log('✅ WebSocket server accepted dummy token (this should not happen)');
        ws2.close();
    });
    
    ws2.on('error', (error) => {
        console.log('❌ WebSocket server error (dummy token):', error.message);
    });
    
    ws2.on('close', (code, reason) => {
        console.log(`WebSocket closed (dummy token): ${code} - ${reason}`);
        
        // Test with the actual token from API
        testWithRealToken();
    });
});

async function testWithRealToken() {
    try {
        const axios = require('axios');
        
        console.log('\nGetting real token from API...');
        const response = await axios.post('http://localhost:42031/api/auth/token', {
            clientId: 'test-client',
            permissions: ['terminal.read', 'terminal.write', 'event.subscribe']
        });
        
        const token = response.data.token;
        console.log('✅ Got token from API:', token.substring(0, 20) + '...');
        
        console.log('\nTesting WebSocket with real token...');
        const ws3 = new WebSocket(`ws://localhost:42031/ws?token=${encodeURIComponent(token)}`);
        
        ws3.on('open', () => {
            console.log('✅ WebSocket connection successful with real token!');
            ws3.close();
        });
        
        ws3.on('error', (error) => {
            console.log('❌ WebSocket error with real token:', error.message);
        });
        
        ws3.on('close', (code, reason) => {
            console.log(`WebSocket closed with real token: ${code} - ${reason}`);
            process.exit(0);
        });
        
    } catch (error) {
        console.log('❌ Failed to get token from API:', error.message);
        process.exit(1);
    }
}