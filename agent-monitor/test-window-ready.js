#!/usr/bin/env node

// Test if Auto-Terminal window is ready
require('dotenv').config();

const axios = require('axios');

async function testWindowReady() {
  console.log('🧪 Testing Auto-Terminal Window Status');
  console.log('='.repeat(50));
  
  const apiUrl = process.env.API_URL || 'http://localhost:3001';
  const token = process.env.API_TOKEN || '';
  
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  };

  try {
    // First check system info
    console.log('📋 Checking system info...');
    const sysResponse = await axios.get(`${apiUrl}/api/system/info`, { headers });
    console.log('✅ System info:', sysResponse.data);
    
    // Check UI tabs
    console.log('\n📋 Checking UI tabs...');
    try {
      const tabsResponse = await axios.get(`${apiUrl}/api/ui/tabs`, { headers });
      console.log('✅ UI tabs:', tabsResponse.data);
    } catch (error) {
      console.error('❌ Failed to get UI tabs:', error.response?.data || error.message);
    }
    
    // Check active processes
    console.log('\n📋 Checking active processes...');
    const procResponse = await axios.get(`${apiUrl}/api/processes`, { headers });
    console.log('✅ Active processes:', procResponse.data.length);
    
    // List existing terminals
    console.log('\n📋 Listing existing terminals...');
    const termsResponse = await axios.get(`${apiUrl}/api/terminals`, { headers });
    console.log('✅ Existing terminals:', termsResponse.data);
    
  } catch (error) {
    console.error('❌ Test failed:', error.response?.data || error.message);
  }
}

testWindowReady().catch(console.error);