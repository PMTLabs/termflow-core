const http = require('http');

const API_HOST = 'localhost';
const API_PORT = 3001;

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeRequest(method, path, data = null) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: API_HOST,
      port: API_PORT,
      path: path,
      method: method,
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (e) {
          resolve(body);
        }
      });
    });

    req.on('error', (e) => {
      reject(e);
    });

    if (data) {
      req.write(JSON.stringify(data));
    }
    req.end();
  });
}

async function testMultipleTerminals() {
  try {
    console.log('Testing multiple terminal creation...\n');
    
    // First, get the list of tabs
    const tabs = await makeRequest('GET', '/tabs');
    console.log(`Found ${tabs.length} tabs`);
    
    if (tabs.length === 0) {
      console.log('No tabs found. Creating a new tab first...');
      const newTab = await makeRequest('POST', '/terminals', {
        name: 'Test Tab',
        profile: 'cmd'
      });
      console.log('Created new tab:', newTab);
      return;
    }
    
    // Use the first tab
    const targetTab = tabs[0];
    console.log(`Using tab: ${targetTab.id} (${targetTab.title})\n`);
    
    // Create 5 terminals in the same tab
    const terminals = [];
    for (let i = 1; i <= 5; i++) {
      console.log(`Creating terminal ${i}...`);
      const response = await makeRequest('POST', '/terminals', {
        name: `Terminal ${i}`,
        profile: 'cmd',
        tabId: targetTab.id
      });
      
      terminals.push(response);
      console.log(`Created terminal ${i}:`, {
        terminalId: response.terminalId,
        processId: response.processId,
        paneId: response.paneId
      });
      
      // Small delay between creations
      await sleep(500);
    }
    
    console.log('\n=== Summary ===');
    console.log('Created terminals:');
    terminals.forEach((term, index) => {
      console.log(`Terminal ${index + 1}: terminalId=${term.terminalId}, processId=${term.processId}`);
    });
    
    // Check if all process IDs are unique
    const processIds = terminals.map(t => t.processId);
    const uniqueProcessIds = [...new Set(processIds)];
    
    if (uniqueProcessIds.length === terminals.length) {
      console.log('\n✓ SUCCESS: All terminals have unique process IDs!');
    } else {
      console.log('\n✗ ISSUE: Some terminals share the same process ID!');
      console.log('Unique process IDs:', uniqueProcessIds);
    }
    
  } catch (error) {
    console.error('Error:', error.message);
  }
}

testMultipleTerminals();