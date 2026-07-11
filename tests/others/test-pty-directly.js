// Direct test of PTY manager to understand the issue
const { PTYManager } = require('./dist/main/shell/PTYManager');

const ptyManager = new PTYManager();

// Spawn a test terminal
console.log('Spawning test terminal...');
const processId = ptyManager.spawn({
  shell: 'C:\\Windows\\System32\\cmd.exe',
  cols: 80,
  rows: 24
});

console.log(`Created process with ID: ${processId}`);

// Check if we can get it back
const process = ptyManager.getProcess(processId);
console.log(`getProcess returned:`, !!process);
console.log(`Process PID:`, process?.pid);

// Check active processes
const activeProcesses = ptyManager.getActiveProcesses();
console.log(`Active processes:`, activeProcesses.length);
console.log(`First process ID:`, activeProcesses[0]?.id);

// Compare
console.log(`\nIDs match:`, processId === activeProcesses[0]?.id);
console.log(`Can retrieve via getProcess:`, !!ptyManager.getProcess(activeProcesses[0]?.id));

// Clean up
setTimeout(() => {
  console.log('\nCleaning up...');
  ptyManager.kill(processId);
  process.exit(0);
}, 2000);