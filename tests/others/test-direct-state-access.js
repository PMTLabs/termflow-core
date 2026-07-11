const fs = require('fs');
const path = require('path');
const http = require('http');

const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwicGVybWlzc2lvbnMiOlsiKiJdLCJpYXQiOjE3NTI5ODg1MjQsImV4cCI6MTc1Mjk5MjEyNH0.BioEmvKhHmw-e7CRGM7w6GOOpldixyU3zGhbRw56IJU';

console.log('Direct State Access Test\n');
console.log('This test shows how terminal names are accessed directly from state without extra files.\n');

// 1. Check terminal registry (real-time data)
const registryPath = path.join(process.env.APPDATA, 'auto-terminal', 'terminal-registry.json');
if (fs.existsSync(registryPath)) {
  console.log('1. Terminal Registry (Real-time terminal data):');
  try {
    const data = fs.readFileSync(registryPath, 'utf8');
    const registry = JSON.parse(data);
    
    if (registry.terminals && registry.terminals.length > 0) {
      registry.terminals.forEach((t, i) => {
        console.log(`   ${i + 1}. "${t.name}" (Process ID: ${t.id.substring(0, 8)}...)`);
      });
    } else {
      console.log('   No active terminals');
    }
  } catch (error) {
    console.error('   Error reading registry:', error.message);
  }
} else {
  console.log('1. No terminal registry found');
}

// 2. Test API access
console.log('\n2. API Access (Direct from memory):');
const options = {
  hostname: 'localhost',
  port: 3001,
  path: '/api/terminals',
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`
  }
};

const req = http.request(options, (res) => {
  let body = '';
  res.on('data', chunk => body += chunk);
  res.on('end', () => {
    if (res.statusCode === 200) {
      try {
        const terminals = JSON.parse(body);
        console.log(`   Found ${terminals.length} terminals via API:`);
        terminals.forEach((t, i) => {
          console.log(`   ${i + 1}. "${t.name}" (ID: ${t.id.substring(0, 8)}..., PID: ${t.pid})`);
        });
      } catch (e) {
        console.log('   Error parsing response:', e.message);
      }
    } else {
      console.log(`   API returned status ${res.statusCode}`);
    }
  });
});

req.on('error', (err) => {
  console.log('   API not available:', err.message);
  console.log('   Make sure the app is running (npm run dev)');
});

req.end();

// 3. Explain the data flow
setTimeout(() => {
  console.log('\n3. How Terminal Names Work (Simplified):');
  console.log('   • Tab names are stored in Redux state (tabs.tabs[].title)');
  console.log('   • Pane names are stored in Redux state (panes.paneTree.name)');
  console.log('   • State is persisted to localStorage automatically');
  console.log('   • On app restart, StateManager restores the entire state');
  console.log('   • Terminal names come directly from the restored state');
  console.log('   • API reads names from in-memory metadata manager');
  console.log('   • No extra metadata.json file needed!');
  
  console.log('\n4. Benefits:');
  console.log('   • Single source of truth (Redux state)');
  console.log('   • Automatic persistence via StateManager');
  console.log('   • Less file I/O operations');
  console.log('   • Simpler code maintenance');
  console.log('   • Names are always in sync with UI state');
}, 1000);