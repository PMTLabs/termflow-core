// Test different JWT scenarios
const jwt = require('jsonwebtoken');
const axios = require('axios');
const WebSocket = require('ws');

async function testJWTScenarios() {
    try {
        console.log('=== JWT Authentication Debug ===\n');
        
        // Step 1: Get a real token from the API
        console.log('🔄 Step 1: Getting real token from auto-terminal API...');
        const response = await axios.post('http://localhost:3001/api/auth/token', {
            clientId: 'jwt-debug-client',
            permissions: ['terminal.read', 'event.subscribe']
        });
        
        const realToken = response.data.token;
        console.log('✅ Real token received');
        console.log(`📝 Token: ${realToken.substring(0, 50)}...`);
        
        // Decode the real token to see what it contains
        const decoded = jwt.decode(realToken, { complete: true });
        console.log('\n📋 Real token structure:');
        console.log('  Header:', JSON.stringify(decoded.header, null, 2));
        console.log('  Payload:', JSON.stringify(decoded.payload, null, 2));
        
        // Step 2: Test the real token with REST API (should work)
        console.log('\n🔄 Step 2: Testing real token with REST API...');
        try {
            const apiTest = await axios.get('http://localhost:3001/api/health', {
                headers: { 'Authorization': `Bearer ${realToken}` }
            });
            console.log('✅ REST API accepts the token (status:', apiTest.status, ')');
        } catch (error) {
            console.log('❌ REST API rejects the token:', error.response?.status || error.message);
        }
        
        // Step 3: Test the real token with WebSocket (currently fails)
        console.log('\n🔄 Step 3: Testing real token with WebSocket...');
        await testWebSocketToken(realToken, 'Real Token');
        
        // Step 4: Try some debug scenarios
        console.log('\n🔄 Step 4: Testing debug scenarios...');
        
        // Try with a test secret that might be commonly used
        const testSecrets = [
            'secret', 
            'test-secret', 
            'auto-terminal-secret',
            'development-secret'
        ];
        
        for (const testSecret of testSecrets) {
            console.log(`\n🧪 Testing with secret: "${testSecret}"`);
            const testToken = jwt.sign(
                {
                    sub: 'debug-client',
                    permissions: ['terminal.read', 'event.subscribe'],
                    iat: Math.floor(Date.now() / 1000),
                    exp: Math.floor(Date.now() / 1000) + 3600 // 1 hour
                },
                testSecret
            );
            
            await testWebSocketToken(testToken, `Test Secret: ${testSecret}`);
        }
        
    } catch (error) {
        console.error('❌ Debug test failed:', error.message);
    }
}

async function testWebSocketToken(token, description) {
    return new Promise((resolve) => {
        console.log(`  🔗 Testing WebSocket with: ${description}`);
        
        const ws = new WebSocket(`ws://localhost:9876?token=${encodeURIComponent(token)}`);
        
        const timeout = setTimeout(() => {
            ws.close();
            console.log(`  ⏰ ${description}: Timeout`);
            resolve();
        }, 3000);
        
        ws.on('open', () => {
            clearTimeout(timeout);
            console.log(`  ✅ ${description}: SUCCESS!`);
            ws.close();
            resolve();
        });
        
        ws.on('error', (error) => {
            clearTimeout(timeout);
            console.log(`  ❌ ${description}: ${error.message}`);
            resolve();
        });
        
        ws.on('close', (code, reason) => {
            clearTimeout(timeout);
            console.log(`  ❌ ${description}: Closed with code ${code}`);
            resolve();
        });
    });
}

// Install jsonwebtoken if not available
try {
    require('jsonwebtoken');
    testJWTScenarios();
} catch (error) {
    console.log('Installing jsonwebtoken...');
    const { execSync } = require('child_process');
    execSync('npm install jsonwebtoken', { stdio: 'inherit' });
    testJWTScenarios();
}