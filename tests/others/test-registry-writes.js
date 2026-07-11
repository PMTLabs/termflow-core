const fs = require('fs');
const path = require('path');

const registryPath = path.join(process.env.APPDATA, 'auto-terminal', 'terminal-registry.json');

console.log('Terminal Registry Write Test\n');
console.log('This test monitors writes to terminal-registry.json\n');

let lastModified = null;
let writeCount = 0;

// Check initial state
if (fs.existsSync(registryPath)) {
  const stats = fs.statSync(registryPath);
  lastModified = stats.mtimeMs;
  console.log(`Registry file exists, last modified: ${new Date(stats.mtime).toLocaleTimeString()}`);
} else {
  console.log('Registry file does not exist yet');
}

console.log('\nMonitoring file writes for 20 seconds...');
console.log('(Before fix: File was written every 2 seconds)');
console.log('(After fix: File only written on terminal create/close/rename)\n');

// Monitor for 20 seconds
const interval = setInterval(() => {
  if (fs.existsSync(registryPath)) {
    const stats = fs.statSync(registryPath);
    if (lastModified === null || stats.mtimeMs !== lastModified) {
      writeCount++;
      console.log(`[${new Date().toLocaleTimeString()}] File written (write #${writeCount})`);
      
      // Show what changed
      try {
        const content = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        console.log(`   - ${content.terminals?.length || 0} terminals in registry`);
      } catch (e) {
        // Ignore parse errors
      }
      
      lastModified = stats.mtimeMs;
    }
  }
}, 100); // Check every 100ms

// Stop after 20 seconds
setTimeout(() => {
  clearInterval(interval);
  console.log('\nTest complete!');
  console.log(`Total writes detected: ${writeCount}`);
  
  if (writeCount === 0) {
    console.log('\n✓ No unnecessary writes detected!');
    console.log('The file is only written when terminals are created, closed, or renamed.');
  } else if (writeCount <= 2) {
    console.log('\n✓ Minimal writes detected.');
    console.log('These were likely from actual terminal operations.');
  } else {
    console.log('\n✗ Multiple writes detected.');
    console.log('The periodic save might still be active.');
  }
}, 20000);