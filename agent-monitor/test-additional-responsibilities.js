#!/usr/bin/env node

/**
 * Test script to demonstrate additional responsibilities in kickoff prompts
 */

const fs = require('fs');
const path = require('path');

// Load the team configuration
const configPath = path.join(__dirname, 'example-team.json');
const teamConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

// Find the Product Manager and Backend Developer
const productManager = teamConfig.agents.find(agent => agent.role === 'Product Manager');
const backendDeveloper = teamConfig.agents.find(agent => agent.role === 'Backend Developer');
const frontendDeveloper = teamConfig.agents.find(agent => agent.role === 'Frontend Developer');

console.log('\n🧪 ADDITIONAL RESPONSIBILITIES DEMONSTRATION\n');

console.log('📋 PRODUCT MANAGER - Additional Responsibilities:');
if (productManager && productManager.additionalResponsibilities) {
  productManager.additionalResponsibilities.forEach((resp, index) => {
    console.log(`   ${index + 1}. ${resp}`);
  });
} else {
  console.log('   None configured');
}

console.log('\n🔧 BACKEND DEVELOPER - Additional Responsibilities:');
if (backendDeveloper && backendDeveloper.additionalResponsibilities) {
  backendDeveloper.additionalResponsibilities.forEach((resp, index) => {
    console.log(`   ${index + 1}. ${resp}`);
  });
} else {
  console.log('   None configured');
}

console.log('\n💻 FRONTEND DEVELOPER - Additional Responsibilities:');
if (frontendDeveloper && frontendDeveloper.additionalResponsibilities) {
  frontendDeveloper.additionalResponsibilities.forEach((resp, index) => {
    console.log(`   ${index + 1}. ${resp}`);
  });
} else {
  console.log('   None configured (uses only ChatHub core responsibilities)');
}

console.log('\n📝 How Kickoff Prompts Will Include Additional Responsibilities:\n');

// Simulate how the kickoff prompt would be constructed
function simulateKickoffPrompt(agent) {
  let prompt = `Agent: ${agent.name} (${agent.role})\n\n`;
  prompt += 'CORE RESPONSIBILITIES (from ChatHub):\n';
  prompt += 'Will be retrieved via /mcp chathub get_responsibility\n\n';
  
  if (agent.additionalResponsibilities && agent.additionalResponsibilities.length > 0) {
    prompt += 'ADDITIONAL PROJECT-SPECIFIC RESPONSIBILITIES:\n';
    agent.additionalResponsibilities.forEach(resp => {
      prompt += `- ${resp}\n`;
    });
    prompt += '\nThese are supplementary to your core ChatHub role responsibilities.\n\n';
  }
  
  prompt += 'MCP CONNECTION STEPS:\n';
  prompt += `1. Use /mcp chathub connect role="${agent.role}" aiType="${agent.aiType}"\n`;
  prompt += '2. Use /mcp chathub join_channel channelId=1\n';
  prompt += `3. Use /mcp chathub get_responsibility role="${agent.role}"\n`;
  
  return prompt;
}

console.log('🎯 PRODUCT MANAGER KICKOFF PREVIEW:');
console.log('─'.repeat(60));
console.log(simulateKickoffPrompt(productManager));

console.log('\n🔧 BACKEND DEVELOPER KICKOFF PREVIEW:');
console.log('─'.repeat(60));
console.log(simulateKickoffPrompt(backendDeveloper));

console.log('\n✅ This demonstrates how agents receive both ChatHub core responsibilities');
console.log('   AND project-specific additional responsibilities in their kickoff prompts.');