#!/usr/bin/env node

// Test different ChatHub API endpoints to find the correct ones
require('dotenv').config();
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

const axios = require('axios');
const https = require('https');

const client = axios.create({
  baseURL: 'https://localhost:5001',
  headers: {
    'Content-Type': 'application/json',
  },
  httpsAgent: new https.Agent({
    rejectUnauthorized: false
  }),
  timeout: 10000
});

async function testEndpoints() {
  console.log('🧪 Testing ChatHub API endpoints...\n');

  const endpoints = [
    '/api/Health',
    '/api/Agent/active',
    '/api/agent/active', 
    '/Agent/active',
    '/agent/active',
    '/api/Agents/active',
    '/api/agents/active',
    '/Agents/active',
    '/agents/active'
  ];

  for (const endpoint of endpoints) {
    try {
      console.log(`Testing: GET ${endpoint}`);
      const response = await client.get(endpoint);
      console.log(`✅ SUCCESS: ${endpoint} - Status: ${response.status}`);
      if (endpoint.includes('agent') || endpoint.includes('Agent')) {
        console.log(`   Data type: ${Array.isArray(response.data) ? 'Array' : typeof response.data}`);
        console.log(`   Sample: ${JSON.stringify(response.data).substring(0, 100)}...\n`);
      }
    } catch (error) {
      console.log(`❌ FAILED: ${endpoint} - Status: ${error.response?.status || 'No response'}`);
      if (error.response?.status !== 404) {
        console.log(`   Error: ${error.response?.data?.message || error.message}`);
      }
      console.log('');
    }
  }
}

testEndpoints().catch(console.error);