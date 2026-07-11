// Test WebSocket with Authorization header
const axios = require('axios');
const WebSocket = require('ws');

async function testHeaderAuth() {
    try {
        console.log('Getting token from API...');
        const response = await axios.post('http://localhost:3001/api/auth/token', {
            clientId: 'header-test-client',
            permissions: ['terminal.read', 'event.subscribe']
        });
        
        const token = response.data.token;
        console.log('✅ Token received');
        
        console.log('\n🔄 Testing WebSocket with Authorization header...');
        
        return new Promise((resolve, reject) => {
            const ws = new WebSocket('ws://localhost:9876', {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            const timeout = setTimeout(() => {
                ws.close();
                reject(new Error('Timeout'));
            }, 5000);
            
            ws.on('open', () => {
                clearTimeout(timeout);
                console.log('✅ WebSocket connection with header successful!');
                ws.close();
                resolve();
            });
            
            ws.on('error', (error) => {
                clearTimeout(timeout);
                console.log('❌ WebSocket header auth failed:', error.message);
                reject(error);
            });
            
            ws.on('close', (code, reason) => {
                clearTimeout(timeout);
                console.log(`WebSocket closed: ${code} - ${reason || 'No reason'}`);
                if (code !== 1000) {
                    reject(new Error(`Connection failed: ${code}`));
                }
            });
        });
        
    } catch (error) {
        console.error('Test failed:', error.message);
        throw error;
    }
}

testHeaderAuth()
    .then(() => {
        console.log('\n🎉 Header authentication successful!');
        process.exit(0);
    })
    .catch((error) => {
        console.log('\n💥 Header authentication failed:', error.message);
        process.exit(1);
    });