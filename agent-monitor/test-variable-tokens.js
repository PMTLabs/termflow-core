#!/usr/bin/env node

/**
 * Test script to demonstrate variable token replacement in kickoff prompts
 */

const fs = require('fs');
const path = require('path');

// Load the team configuration
const configPath = path.join(__dirname, 'example-team.json');
const teamConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

console.log('\n🔧 VARIABLE TOKEN REPLACEMENT DEMONSTRATION\n');

console.log('📋 TEAM CONFIGURATION VALUES:');
console.log(`   Project Name: "${teamConfig.teamConfig.projectName}"`);
console.log(`   Project Folder: "${teamConfig.teamConfig.projectFolder}"`);
console.log(`   ChatHub Channel: ${teamConfig.teamConfig.chatHubChannel}`);

console.log('\n🎯 VARIABLE TOKENS SUPPORTED:');
console.log('   {projectName}       → Gets replaced with teamConfig.projectName');
console.log('   {projectFolder}     → Gets replaced with teamConfig.projectFolder');
console.log('   {channelId}         → Gets replaced with teamConfig.chatHubChannel');
console.log('   {requirementsFolder} → Gets replaced with teamConfig.requirementsFolder');

// Function to simulate token replacement (matches team-orchestrator.ts logic)
function replaceTokens(prompt, teamConfig) {
  return prompt
    .replace('{channelId}', teamConfig.teamConfig.chatHubChannel.toString())
    .replace('{projectName}', teamConfig.teamConfig.projectName)
    .replace('{projectFolder}', teamConfig.teamConfig.projectFolder)
    .replace('{requirementsFolder}', teamConfig.teamConfig.requirementsFolder || '/docs');
}

console.log('\n📝 KICKOFF PROMPT EXAMPLES:\n');

// Show a few examples of before/after token replacement
const examples = [
  teamConfig.agents.find(a => a.role === 'Project Coordinator'),
  teamConfig.agents.find(a => a.role === 'Product Manager'),
  teamConfig.agents.find(a => a.role === 'Backend Developer')
];

examples.forEach((agent, index) => {
  if (agent && agent.kickoffPrompt) {
    console.log(`${index + 1}. ${agent.role.toUpperCase()} (${agent.name})`);
    console.log('─'.repeat(50));
    console.log('BEFORE (with tokens):');
    console.log(`"${agent.kickoffPrompt}"\n`);
    
    console.log('AFTER (tokens replaced):');
    const processedPrompt = replaceTokens(agent.kickoffPrompt, teamConfig);
    console.log(`"${processedPrompt}"\n`);
  }
});

console.log('✅ Variable tokens allow the same configuration to work with different:');
console.log('   • Project names');
console.log('   • ChatHub channels');
console.log('   • Project directories');
console.log('\n💡 This makes team configurations reusable across multiple projects!');

// Show token usage in context
console.log('\n🔄 USAGE EXAMPLE:');
console.log('─'.repeat(60));
console.log('1. Create team-config-template.json with tokens like {projectName}');
console.log('2. Copy template for new project');  
console.log('3. Update teamConfig values (projectName, chatHubChannel, etc.)');
console.log('4. Agent kickoff prompts automatically use the correct values');
console.log('5. Same template works for any project!');