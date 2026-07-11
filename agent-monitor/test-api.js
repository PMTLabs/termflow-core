/**
 * Test script for Auto-Terminal API with recent updates
 * Tests the new api-terminal- ID format, tabId/paneId fields, and profile parameter
 */

const axios = require('axios');

const API_BASE_URL = 'http://localhost:3001';
const API_TOKEN = 'your-api-token-here';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Authorization': `Bearer ${API_TOKEN}`,
    'Content-Type': 'application/json'
  }
});

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testAPIFeatures() {
  console.log('🧪 Testing Auto-Terminal API Features\n');
  
  try {
    // Test 1: Get existing terminals
    console.log('1️⃣ Getting existing terminals...');
    const terminalsResponse = await api.get('/api/terminals');
    console.log(`Found ${terminalsResponse.data.length} terminals`);
    terminalsResponse.data.forEach(term => {
      console.log(`  - ID: ${term.id}, Profile: ${term.profile}, Tab: ${term.tabId}, Pane: ${term.paneId}`);
    });
    
    // Test 2: Create terminal with specific profile (CMD)
    console.log('\n2️⃣ Creating terminal with CMD profile...');
    const cmdTerminal = await api.post('/api/terminals', {
      profile: 'cmd',
      name: 'Test CMD Terminal'
    });
    console.log('Created terminal:', {
      id: cmdTerminal.data.id,
      profile: cmdTerminal.data.profile,
      tabId: cmdTerminal.data.tabId,
      paneId: cmdTerminal.data.paneId
    });
    
    // Verify the ID format
    if (cmdTerminal.data.id.startsWith('api-terminal-')) {
      console.log('✅ Correct ID format with api-terminal- prefix');
    } else {
      console.log('❌ ID format incorrect, expected api-terminal- prefix');
    }
    
    // Verify tabId and paneId are returned
    if (cmdTerminal.data.tabId && cmdTerminal.data.paneId) {
      console.log('✅ Both tabId and paneId returned');
    } else {
      console.log('❌ Missing tabId or paneId in response');
    }
    
    await sleep(2000);
    
    // Test 3: Create terminal in existing tab (split pane)
    console.log('\n3️⃣ Creating terminal in existing tab (split pane)...');
    const splitTerminal = await api.post('/api/terminals', {
      profile: 'powershell',
      name: 'Split PowerShell',
      tabId: cmdTerminal.data.tabId  // Use the tab from previous terminal
    });
    console.log('Created split terminal:', {
      id: splitTerminal.data.id,
      profile: splitTerminal.data.profile,
      tabId: splitTerminal.data.tabId,
      paneId: splitTerminal.data.paneId
    });
    
    // Verify same tab but different pane
    if (splitTerminal.data.tabId === cmdTerminal.data.tabId) {
      console.log('✅ Terminal created in same tab');
    }
    if (splitTerminal.data.paneId !== cmdTerminal.data.paneId) {
      console.log('✅ Terminal has different pane ID');
    }
    
    await sleep(2000);
    
    // Test 4: Get UI tabs to verify structure
    console.log('\n4️⃣ Getting UI tabs structure...');
    const tabsResponse = await api.get('/api/ui/tabs');
    console.log(`Found ${tabsResponse.data.length} tabs`);
    
    // Find our test tab
    const testTab = tabsResponse.data.find(tab => tab.id === cmdTerminal.data.tabId);
    if (testTab) {
      console.log('Found test tab:', testTab.id);
      console.log('Tab structure:', JSON.stringify(testTab.paneTree, null, 2));
    }
    
    // Test 5: List all terminals again to verify they're tracked
    console.log('\n5️⃣ Listing all terminals after creation...');
    const finalTerminals = await api.get('/api/terminals');
    const apiTerminals = finalTerminals.data.filter(t => t.id.startsWith('api-terminal-'));
    console.log(`Found ${apiTerminals.length} API-created terminals`);
    
    // Verify our terminals are in the list
    const cmdFound = apiTerminals.find(t => t.id === cmdTerminal.data.id);
    const splitFound = apiTerminals.find(t => t.id === splitTerminal.data.id);
    
    if (cmdFound && splitFound) {
      console.log('✅ Both test terminals found in list');
      console.log(`  - CMD: ${cmdFound.profile} (${cmdFound.status})`);
      console.log(`  - PowerShell: ${splitFound.profile} (${splitFound.status})`);
    }
    
    console.log('\n✅ All API tests completed successfully!');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.response?.data || error.message);
  }
}

// Run the tests
testAPIFeatures();