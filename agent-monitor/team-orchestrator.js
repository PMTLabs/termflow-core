#!/usr/bin/env node

/**
 * Team Orchestrator CLI
 * 
 * Main entry point for the Multi-Agent Software Development Team Orchestration system
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Check if TypeScript files need to be compiled
const srcDir = path.join(__dirname, 'src');
const distDir = path.join(__dirname, 'dist');

if (!fs.existsSync(distDir) || !fs.existsSync(path.join(distDir, 'team-manager.js'))) {
  console.log('🔧 Compiling TypeScript files...');
  try {
    execSync('npm run build', { stdio: 'inherit', cwd: __dirname });
  } catch (error) {
    console.error('❌ Failed to compile TypeScript files');
    console.error('Run "npm run build" manually to see detailed errors');
    process.exit(1);
  }
}

// Load and run the compiled JavaScript
try {
  require('./dist/team-manager.js');
} catch (error) {
  console.error('❌ Failed to run team orchestrator:', error.message);
  console.error('');
  console.error('Troubleshooting:');
  console.error('1. Ensure all dependencies are installed: npm install');
  console.error('2. Build the project: npm run build');
  console.error('3. Check your team configuration file is valid');
  console.error('4. Verify your API_TOKEN is set in .env file');
  process.exit(1);
}