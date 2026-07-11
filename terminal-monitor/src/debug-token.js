// Token debugging script
// Run this with: node src/debug-token.js

const axios = require('axios');

async function debugToken() {
    try {
        console.log('Getting token from auto-terminal API...');
        const response = await axios.post('http://localhost:42031/api/auth/token', {
            clientId: 'terminal-monitor',
            permissions: [
                'terminal.read',
                'terminal.write', 
                'terminal.create',
                'terminal.delete',
                'event.subscribe',
                'system.info',
                'system.profiles'
            ]
        });
        
        const token = response.data.token;
        console.log('✅ Token received from API');
        console.log('Token:', token);
        console.log('Response data:', JSON.stringify(response.data, null, 2));
        
        // Decode the JWT token manually
        const parts = token.split('.');
        if (parts.length !== 3) {
            console.error('❌ Invalid JWT format');
            return;
        }
        
        const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
        
        console.log('\n📋 JWT Header:', JSON.stringify(header, null, 2));
        console.log('\n📋 JWT Payload:', JSON.stringify(payload, null, 2));
        
        // Check expiration
        const now = Math.floor(Date.now() / 1000);
        const exp = payload.exp;
        const timeUntilExpiry = exp - now;
        
        console.log('\n⏰ Token timing:');
        console.log(`  - Current time: ${now} (${new Date(now * 1000)})`);
        console.log(`  - Expires at: ${exp} (${new Date(exp * 1000)})`);
        console.log(`  - Time until expiry: ${timeUntilExpiry} seconds (${Math.floor(timeUntilExpiry / 60)} minutes)`);
        
        if (timeUntilExpiry <= 0) {
            console.log('❌ Token is already expired!');
        } else {
            console.log('✅ Token is still valid');
        }
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Response status:', error.response.status);
            console.error('Response data:', error.response.data);
        }
    }
}

debugToken();