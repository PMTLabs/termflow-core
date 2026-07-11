#!/usr/bin/env node
// Ensure environment variables are loaded first
require('dotenv').config();

console.log('🔧 Environment Debug:');
console.log('CHATHUB_WS_URL:', process.env.CHATHUB_WS_URL);
console.log('API_TOKEN present:', !!process.env.API_TOKEN);

// Override the problematic URL
process.env.CHATHUB_WS_URL = 'https://localhost:5001';

console.log('🚀 Starting team with corrected environment...\n');

// Run the team manager
require('./dist/team-manager.js');