// Test token extraction like WebSocket server does
const { URL } = require('url');

const token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXJtaW5hbC1tb25pdG9yIiwicGVybWlzc2lvbnMiOlsidGVybWluYWwucmVhZCIsInRlcm1pbmFsLndyaXRlIiwidGVybWluYWwuY3JlYXRlIiwidGVybWluYWwuZGVsZXRlIiwiZXZlbnQuc3Vic2NyaWJlIiwic3lzdGVtLmluZm8iLCJzeXN0ZW0ucHJvZmlsZXMiXSwiaWF0IjoxNzUzMjMzMDQwLCJleHAiOjE3NTMzMTk0NDB9.4lK7WR56JVtRWdCitG6IeKb6VzB_rnLx2QZx9bLaowc";

console.log('Original token:', token);
console.log('Token length:', token.length);

// Test URL encoding
const encoded = encodeURIComponent(token);
console.log('\nEncoded token:', encoded);
console.log('Encoded length:', encoded.length);

// Test URL parsing (like WebSocket server does)
const testUrl = `ws://localhost:9876?token=${encoded}`;
console.log('\nTest URL:', testUrl);

// Parse like the WebSocket server
const parsedUrl = new URL(testUrl.replace('ws://', 'http://'));
const extractedToken = parsedUrl.searchParams.get('token');

console.log('\nExtracted token:', extractedToken);
console.log('Tokens match:', token === extractedToken);

// Test the simpler case
const simpleUrl = `/?token=${encoded}`;
const simpleTestUrl = new URL(simpleUrl, 'http://localhost:9876');
const simpleExtracted = simpleTestUrl.searchParams.get('token');

console.log('\nSimple extraction test:');
console.log('Extracted token:', simpleExtracted);
console.log('Tokens match:', token === simpleExtracted);

if (token !== extractedToken || token !== simpleExtracted) {
    console.log('\n❌ Token extraction failed!');
    console.log('Original bytes:', Buffer.from(token).length);
    console.log('Extracted bytes:', Buffer.from(extractedToken || '').length);
} else {
    console.log('\n✅ Token extraction works correctly');
}