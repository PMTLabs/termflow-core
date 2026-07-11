/**
 * Generate a development token with a fixed JWT secret
 * 
 * WARNING: This is for development only! 
 * In production, always get tokens from the running Auto-Terminal instance.
 */

const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');

// Fixed secret for development
const DEV_SECRET = 'dev-secret-do-not-use-in-production';

// Generate token
const token = jwt.sign(
  {
    sub: 'agent-monitor-dev',
    permissions: ['*']
  },
  DEV_SECRET,
  {
    expiresIn: '7d' // 7 days
  }
);

console.log('Generated development token:');
console.log(token);
console.log('\nTo use this token:');
console.log('1. Modify src/main/main.ts in Auto-Terminal');
console.log('2. Add to API_CONFIG:');
console.log('   jwtSecret: \'dev-secret-do-not-use-in-production\'');
console.log('3. Restart Auto-Terminal');
console.log('4. Update your .env file with this token');

// Update .env file if requested
if (process.argv.includes('--update-env')) {
  const envPath = path.join(__dirname, '.env');
  let envContent = '';
  
  if (fs.existsSync(envPath)) {
    envContent = fs.readFileSync(envPath, 'utf8');
    envContent = envContent.replace(/API_TOKEN=.*/, `API_TOKEN=${token}`);
  } else {
    envContent = `# Auto-Terminal API Configuration
API_URL=http://localhost:3001
WS_URL=ws://localhost:9876
API_TOKEN=${token}
`;
  }
  
  fs.writeFileSync(envPath, envContent);
  console.log('\n✅ Updated .env file with development token');
}