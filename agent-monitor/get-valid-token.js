/**
 * Get a valid token from the running Auto-Terminal instance
 * 
 * This script demonstrates how to obtain a valid JWT token for API access.
 * Since Auto-Terminal generates its own JWT secret on startup, tokens must
 * be obtained from the running instance.
 */

console.log(`
=================================================================
HOW TO GET A VALID API TOKEN FOR AUTO-TERMINAL
=================================================================

Auto-Terminal generates a unique JWT secret each time it starts,
so pre-generated tokens won't work. You need to get a token from
the running instance.

OPTION 1: Use the Developer Console (Recommended)
-------------------------------------------------
1. Open Auto-Terminal
2. Press Ctrl+Shift+I (or Cmd+Option+I on Mac) to open DevTools
3. Go to the Console tab
4. Run this command:

   await window.electronAPI.generateAPIToken('agent-monitor', ['*'])

5. Copy the token and update your .env file:
   API_TOKEN=<paste-token-here>

OPTION 2: Use the Command Palette (if implemented)
-------------------------------------------------
1. Open Auto-Terminal
2. Press Ctrl+Shift+P to open command palette
3. Type "Generate API Token"
4. Follow the prompts

OPTION 3: Disable Authentication (Development Only)
-------------------------------------------------
If you're just testing, you can disable auth by modifying
the Auto-Terminal source code:

1. Edit src/main/main.ts
2. Find the API_CONFIG and add:
   jwtSecret: 'fixed-secret-for-testing'
3. Restart Auto-Terminal
4. Generate a token with the same secret

CURRENT TOKEN STATUS
--------------------
`);

// Check if token exists and try to decode it
require('dotenv').config();
const token = process.env.API_TOKEN;

if (token) {
  try {
    // Basic JWT decode (without verification)
    const [, payload] = token.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64').toString());
    
    console.log('Token found in .env file');
    console.log('Token payload:', decoded);
    
    const exp = new Date(decoded.exp * 1000);
    const now = new Date();
    
    if (exp < now) {
      console.log('❌ Token has EXPIRED on:', exp.toLocaleString());
    } else {
      console.log('✅ Token expires on:', exp.toLocaleString());
    }
  } catch (error) {
    console.log('❌ Invalid token format');
  }
} else {
  console.log('❌ No token found in .env file');
}

console.log('\n=================================================================\n');