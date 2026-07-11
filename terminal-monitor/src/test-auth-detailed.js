// Detailed authentication test
const axios = require('axios');
const WebSocket = require('ws');

async function testAuthentication() {
    try {
        console.log('🔄 Step 1: Testing API authentication...');
        
        // Test API authentication
        const tokenResponse = await axios.post('http://localhost:3001/api/auth/token', {
            clientId: 'test-auth-client',
            permissions: ['terminal.read', 'event.subscribe']
        });
        
        console.log('✅ API token generation successful');
        const token = tokenResponse.data.token;
        console.log(`📝 Token: ${token.substring(0, 50)}...`);
        
        // Test API endpoint with token
        console.log('\n🔄 Step 2: Testing API endpoint with token...');
        const apiTest = await axios.get('http://localhost:3001/api/terminals', {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });
        
        console.log('✅ API endpoint authentication successful');
        console.log(`📊 API response status: ${apiTest.status}`);
        
        // Test WebSocket authentication  
        console.log('\n🔄 Step 3: Testing WebSocket authentication...');
        
        return new Promise((resolve, reject) => {
            const wsUrl = `ws://localhost:9876?token=${encodeURIComponent(token)}`;
            console.log(`🔗 WebSocket URL: ${wsUrl.substring(0, 80)}...`);
            
            const ws = new WebSocket(wsUrl);
            let resolved = false;
            
            const timeout = setTimeout(() => {
                if (!resolved) {
                    resolved = true;
                    ws.close();
                    reject(new Error('WebSocket connection timeout'));
                }
            }, 10000);
            
            ws.on('open', () => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    console.log('✅ WebSocket authentication successful!');
                    ws.close();
                    resolve();
                }
            });
            
            ws.on('error', (error) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    console.log('❌ WebSocket error:', error.message);
                    reject(error);
                }
            });
            
            ws.on('close', (code, reason) => {
                if (!resolved) {
                    resolved = true;
                    clearTimeout(timeout);
                    console.log(`❌ WebSocket closed: ${code} - ${reason || 'No reason provided'}`);
                    
                    // Provide specific error analysis
                    if (code === 1006) {
                        console.log('💡 Code 1006 usually means connection was rejected before opening');
                        console.log('💡 This often indicates authentication failure during handshake');
                    } else if (code === 1008) {
                        console.log('💡 Code 1008 means policy violation (authentication failed)');
                    }
                    
                    reject(new Error(`WebSocket connection failed: ${code}`));
                }
            });
        });
        
    } catch (error) {
        console.error('❌ Test failed:', error.message);
        if (error.response) {
            console.error(`📊 HTTP Status: ${error.response.status}`);
            console.error(`📊 Response: ${JSON.stringify(error.response.data, null, 2)}`);
        }
        throw error;
    }
}

testAuthentication()
    .then(() => {
        console.log('\n🎉 All tests passed! Authentication is working correctly.');
        process.exit(0);
    })
    .catch((error) => {
        console.log('\n💥 Authentication test failed:', error.message);
        process.exit(1);
    });