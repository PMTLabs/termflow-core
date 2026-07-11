#!/usr/bin/env node
console.log('=== BEFORE DOTENV ===');
console.log('CHATHUB_WS_URL:', process.env.CHATHUB_WS_URL);
console.log('API_TOKEN present:', !!process.env.API_TOKEN);

require('dotenv').config();

console.log('=== AFTER DOTENV ===');
console.log('CHATHUB_WS_URL:', process.env.CHATHUB_WS_URL);
console.log('API_TOKEN present:', !!process.env.API_TOKEN);

console.log('=== DEFAULT FALLBACK TEST ===');
const testUrl = process.env.CHATHUB_WS_URL || 'ws://localhost:8080';
console.log('Fallback URL would be:', testUrl);