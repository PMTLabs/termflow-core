#!/usr/bin/env node

// Working solution: Launch agents without ChatHub dependency
require('dotenv').config();

const { AutoTerminalClient } = require('./dist/api-client');
const fs = require('fs');

async function launchAgents() {
  console.log('🚀 LAUNCHING TODO APP DEVELOPMENT TEAM');
  console.log('='.repeat(60));
  
  try {
    // Load team configuration
    const teamConfig = JSON.parse(fs.readFileSync('./team-simple.json', 'utf-8'));
    
    // Initialize Auto-Terminal client
    const client = new AutoTerminalClient({
      apiUrl: process.env.API_URL,
      token: process.env.API_TOKEN,
      autoReconnect: false  // Simplified for testing
    });
    
    console.log('🔌 Connecting to Auto-Terminal...');
    await client.connect();
    console.log('✅ Connected to Auto-Terminal API\n');
    
    console.log('👥 Creating agent terminals...');
    const agents = teamConfig.agents;
    const createdAgents = [];
    
    for (let i = 0; i < agents.length; i++) {
      const agent = agents[i];
      console.log(`\n🤖 Agent ${i+1}/${agents.length}: ${agent.name} (${agent.role})`);
      
      // Create terminal
      const createOptions = {
        name: `${agent.name} - ${agent.role}`,
        profile: 'cmd'
      };
      
      if (process.env.DEFAULT_TERMINAL_TABID) {
        createOptions.tabId = process.env.DEFAULT_TERMINAL_TABID;
        console.log(`  📂 Using tab: ${process.env.DEFAULT_TERMINAL_TABID}`);
      }
      
      const terminal = await client.createTerminal(createOptions);
      console.log(`  ✅ Terminal created: ${terminal.id}`);
      
      // Navigate to project directory
      await client.sendInput(terminal.id, `cd "${teamConfig.teamConfig.projectFolder}"`);
      console.log(`  📁 Changed to project directory`);
      
      // Wait a moment
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Prepare kickoff prompt with variable replacement
      let kickoffPrompt = agent.kickoffPrompt
        .replace('{projectName}', teamConfig.teamConfig.projectName)
        .replace('{requirementsFolder}', teamConfig.teamConfig.requirementsFolder || '/docs')
        .replace('{channelId}', teamConfig.teamConfig.chatHubChannel);
      
      // Add MCP connection instructions
      kickoffPrompt += `\n\nIMPORTANT: Connect to ChatHub for team coordination:
1. Use /mcp_chathub_connect with role="${agent.role}" and aiType="${agent.aiType}"  
2. Use /mcp_chathub_join_channel with channelId=${teamConfig.teamConfig.chatHubChannel}
3. Use /mcp_chathub_get_responsibility to get your role responsibilities
4. Monitor team communications and coordinate with other agents

You are working on the ${teamConfig.teamConfig.projectName} project located in ${teamConfig.teamConfig.projectFolder}. Check ${teamConfig.teamConfig.requirementsFolder} for requirements.`;

      // Start AI CLI
      console.log(`  🚀 Starting ${agent.aiType} CLI...`);
      await client.sendInput(terminal.id, agent.cliCommand);
      
      // Wait for CLI to start
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Send kickoff prompt
      console.log(`  📨 Sending kickoff prompt...`);
      await client.executePrompt(terminal.id, kickoffPrompt, agent.aiType.toLowerCase());
      
      createdAgents.push({
        agent,
        terminal,
        status: 'starting'
      });
      
      console.log(`  ✅ ${agent.name} launched successfully!`);
      
      // Wait between agents to avoid overwhelming
      if (i < agents.length - 1) {
        console.log(`  ⏳ Waiting 2 seconds before next agent...`);
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    console.log('\n🎉 TEAM LAUNCH COMPLETE!');
    console.log('='.repeat(60));
    console.log(`✅ Successfully launched ${createdAgents.length} agents:`);
    
    createdAgents.forEach((item, index) => {
      console.log(`  ${index + 1}. ${item.agent.name} (${item.agent.role})`);
      console.log(`     Terminal: ${item.terminal.id}`);
    });
    
    console.log('\n📋 NEXT STEPS:');
    console.log('1. Each agent will connect to ChatHub channel 20 via MCP tools');
    console.log('2. Alex Coordinator will start project coordination');
    console.log('3. Jordan Backend will begin backend development work');
    console.log('4. Monitor their progress in their respective terminals');
    
    console.log('\n🔧 TROUBLESHOOTING:');
    console.log('- If agents seem stuck, send them: /mcp_chathub_get_messages');  
    console.log('- To check agent status: /mcp_chathub_get_agents');
    console.log('- Project requirements are in: D:\\sources\\demo\\todo-app\\docs\\requirements.md');
    
    await client.disconnect();
    
  } catch (error) {
    console.error('\n❌ Team launch failed:', error.message);
    
    if (error.message.includes('Invalid token')) {
      console.log('\n💡 SOLUTION: Update API token');
      console.log('1. Open Auto-Terminal');
      console.log('2. Press Ctrl+Shift+I (DevTools)');
      console.log('3. Run: await window.electronAPI.generateAPIToken("agent-monitor", ["*"])');
      console.log('4. Update .env file with new token');
    } else if (error.message.includes('Connection')) {
      console.log('\n💡 SOLUTION: Check Auto-Terminal is running');
      console.log('1. cd D:\\sources\\demo\\auto-terminal');
      console.log('2. npm run dev');
    }
  }
}

console.log('🎯 TODO App Development Team Launcher');
console.log('This will create 2 agents: Project Coordinator + Backend Developer');
console.log('Press Ctrl+C to cancel, or wait 3 seconds to proceed...\n');

setTimeout(() => {
  launchAgents();
}, 3000);