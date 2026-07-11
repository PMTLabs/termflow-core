// Test script to run in the browser console of Auto-Terminal
// This tests the UI's ability to create multiple terminals with unique process IDs

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testMultipleTerminals() {
  console.log('Testing multiple terminal creation via UI...\n');
  
  // Get the current tab
  const store = window.__REDUX_STORE__;
  const state = store.getState();
  const tabs = state.tabs.tabs;
  
  if (tabs.length === 0) {
    console.log('No tabs found. Please create a tab first.');
    return;
  }
  
  const targetTab = tabs[0];
  console.log(`Using tab: ${targetTab.id} (${targetTab.title})\n`);
  
  // Create 5 terminals in the same tab
  const createdTerminals = [];
  
  for (let i = 1; i <= 5; i++) {
    console.log(`Creating terminal ${i}...`);
    
    // Dispatch the API create event
    const event = new CustomEvent('api:createTerminalTab', {
      detail: {
        name: `Test Terminal ${i}`,
        profile: 'cmd',
        tabId: targetTab.id
      }
    });
    
    // Create a promise to wait for the response
    const responsePromise = new Promise((resolve) => {
      const handler = (event) => {
        window.electronAPI.off('api:terminalTabCreated', handler);
        resolve(event);
      };
      window.electronAPI.on('api:terminalTabCreated', handler);
    });
    
    // Dispatch the event
    window.dispatchEvent(event);
    
    // Wait for response
    const response = await responsePromise;
    console.log(`Terminal ${i} created:`, response);
    createdTerminals.push(response);
    
    // Wait a bit between creations
    await sleep(1000);
  }
  
  console.log('\n=== Summary ===');
  console.log('Created terminals:');
  createdTerminals.forEach((term, index) => {
    console.log(`Terminal ${index + 1}: terminalId=${term.terminalId}, processId=${term.processId}`);
  });
  
  // Check if all process IDs are unique
  const processIds = createdTerminals.map(t => t.processId).filter(id => id && id !== 'pending');
  const uniqueProcessIds = [...new Set(processIds)];
  
  if (uniqueProcessIds.length === processIds.length) {
    console.log('\n✓ SUCCESS: All terminals have unique process IDs!');
  } else {
    console.log('\n✗ ISSUE: Some terminals share the same process ID!');
    console.log('Process IDs:', processIds);
    console.log('Unique process IDs:', uniqueProcessIds);
  }
  
  // Also check the terminal service
  console.log('\n=== Terminal Service State ===');
  const terminalService = window.terminalService;
  if (terminalService && terminalService.processes) {
    console.log('Terminal mappings:');
    for (const [terminalId, process] of terminalService.processes) {
      console.log(`  ${terminalId} -> ${process.id}`);
    }
  }
}

// Run the test
testMultipleTerminals();