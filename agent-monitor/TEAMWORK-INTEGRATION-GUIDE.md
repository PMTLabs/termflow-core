# Team Collaboration Integration Guide

## 📋 How to Add Team Collaboration to Your Project

This guide explains how to integrate the multi-agent team collaboration model into your existing project by updating your project's CLAUDE.md file.

## 🎯 Quick Integration Steps

### Step 1: Copy Teamwork Framework
1. Copy `teamwork.md` to your project's root directory or documentation folder
2. Ensure it's accessible to all team members and agent instances

### Step 2: Update Project CLAUDE.md
Add the following reference to your project's CLAUDE.md file:

```markdown
## Team Collaboration Framework
@include teamwork.md

## Agent Team Configuration
When working as part of a multi-agent development team, you must:

1. **Connect to ChatHub immediately upon startup**:
   ```
   /mcp chathub connect role="Your Role" aiType="Claude"  
   /mcp chathub join_channel channelId=<project_channel_id>
   /mcp chathub get_responsibility role="Your Role"
   ```

2. **Follow the communication protocols** defined in teamwork.md
3. **Monitor team messages** regularly using `/mcp chathub get_messages`
4. **Respond to @mentions** within 1 hour during active development
5. **Report progress and blockers** using the standard message formats

Your specific role and responsibilities are defined in the teamwork.md collaboration guide.
```

### Step 3: Project-Specific Customization
Add your project-specific details after the teamwork.md reference:

```markdown
## Project Context
- **Project Name**: [Your Project Name]
- **ChatHub Channel**: [Channel ID for this project] 
- **Technology Stack**: [Your tech stack]
- **Team Roles**: [List of assigned roles and team members]

## Project-Specific Guidelines
[Any additional rules, standards, or processes specific to your project]
```

## 📝 Complete Integration Template

Here's a complete template for adding team collaboration to your CLAUDE.md:

```markdown
# CLAUDE.md - [Project Name]

[Your existing project instructions...]

## Multi-Agent Team Collaboration

### Team Framework
@include teamwork.md

### Team Configuration  
This project uses multi-agent development with the following team structure:

**Team Roles:**
- **Project Coordinator**: [Name/ID] - Project oversight and coordination
- **System Architect**: [Name/ID] - Technical architecture and task assignment  
- **Backend Developer**: [Name/ID] - Server-side implementation
- **Frontend Developer**: [Name/ID] - User interface implementation
- **UI/UX Engineer**: [Name/ID] - User experience design
- **QA Engineer**: [Name/ID] - Quality assurance and testing

**ChatHub Integration:**
- **Channel ID**: [Your project's ChatHub channel]
- **Connection Required**: All agents must connect via MCP tools upon startup
- **Monitoring**: Agent Monitor supervises team coordination and progress

### Your Role and Responsibilities
Execute the following immediately when starting work:

1. **Connect to team communication**:
   ```
   /mcp chathub connect role="[Your Role]" aiType="Claude"
   /mcp chathub join_channel channelId=[Channel ID]
   /mcp chathub get_responsibility role="[Your Role]"
   ```

2. **Check for pending work**:
   ```
   /mcp chathub get_messages limit=20
   ```

3. **Follow the collaboration protocols** outlined in teamwork.md

4. **Coordinate with team members** using the standard message formats

### Project-Specific Requirements
[Add any project-specific collaboration rules, coding standards, testing requirements, etc.]

### Integration with Agent Monitor
The Agent Monitor system supervises this project and will:
- Detect when you're idle and prompt you to check for new tasks
- Monitor task assignments from the System Architect  
- Escalate issues to human supervisors when needed
- Track overall project progress and team coordination
- **Smart Idle Detection**: Verifies with Project Coordinator before prompting idle agents
- **Resume Capability**: Automatically saves and restores team sessions after crashes

Stay active in ChatHub communications and respond promptly to team coordination messages.

[Continue with your existing project-specific instructions...]
```

## 🔧 Environment Setup

### Required MCP Tools
Ensure your project environment includes these MCP tools for ChatHub integration:

```json
{
  "mcpServers": {
    "chathub": {
      "command": "node",
      "args": ["path/to/chathub-mcp-server.js"],
      "env": {
        "CHATHUB_BASE_URL": "https://localhost:5001"
      }
    }
  }
}
```

### Environment Variables
Your project should configure:

```bash
# ChatHub Integration
CHATHUB_BASE_URL=https://localhost:5001
CHATHUB_CHANNEL_ID=your_project_channel_id

# Agent Monitor (if using)
AGENT_MONITOR_ENABLED=true
DISCORD_WEBHOOK_URL=your_discord_webhook_url
```

## 📊 Team Orchestration Setup

### Option 1: Manual Team Setup
Each agent individually connects to ChatHub using MCP tools when they start working on the project.

### Option 2: Automated Team Orchestration  
Use the Agent Monitor system to automatically provision and coordinate the entire team:

1. **Create team configuration file** (e.g., `team-config.json`):
   ```json
   {
     "teamConfig": {
       "projectName": "Your Project Name",
       "projectFolder": "/path/to/your/project", 
       "chatHubChannel": 15,
       "heartbeatInterval": 300,
       "maxIdleTime": 1800,
       "discordWebhookUrl": "your_webhook_url"
     },
     "agents": [
       {
         "id": "coordinator-01",
         "name": "Alex Coordinator",
         "role": "Project Coordinator",
         "aiType": "Claude",
         "cliCommand": "claude"
       },
       {
         "id": "architect-01", 
         "name": "Morgan Architect",
         "role": "System Architect",
         "aiType": "Claude",
         "cliCommand": "claude"
       }
       // ... add other team members
     ]
   }
   ```

2. **Start the orchestrated team**:
   ```bash
   npm run team:start team-config.json
   ```

3. **Resume from previous session** (if crashed/stopped):
   ```bash
   # Check saved session status
   npm run team:session team-config.json
   
   # Resume team with existing terminals
   npm run team:start team-config.json --resume
   ```

## 🎯 Verification Steps

After integration, verify the setup:

### 1. Test Individual Agent Connection
```bash
# Start Claude CLI and test connection
claude

# In Claude, test MCP tools:
/mcp chathub connect role="Backend Developer" aiType="Claude"
/mcp chathub join_channel channelId=15
/mcp chathub get_messages limit=5
```

### 2. Test Team Communication
Have agents send test messages using the standard formats from teamwork.md:

```
[Backend Developer] - STATUS: Testing team communication setup

Details:
- Successfully connected to ChatHub channel 15
- MCP tools working properly
- Ready for project collaboration

Timeline: Immediate - setup complete
```

### 3. Verify Agent Monitor (if used)
Check that the Agent Monitor system:
- Detects agent connections to ChatHub
- Monitors team communications
- Sends appropriate prompts for task coordination

## 🚨 Troubleshooting

### Common Issues

#### "ChatHub connection failed"
- Verify ChatHub server is running at configured URL
- Check MCP server configuration and environment variables
- Ensure proper SSL certificate handling for development

#### "No team messages received"  
- Confirm correct ChatHub channel ID
- Verify agent has joined the channel successfully
- Check message filtering settings

#### "Agent not responding to @mentions"
- Ensure agent is monitoring ChatHub regularly
- Verify mention format matches agent name/role
- Check for message processing errors

### Getting Help
1. **Check teamwork.md** for communication protocols
2. **Review agent monitor logs** for coordination issues
3. **Test MCP tool connections** individually
4. **Verify ChatHub server status** and connectivity

## 📈 Success Metrics

Track team collaboration effectiveness:

- **Response Time**: Average time to respond to @mentions and direct questions
- **Task Completion Rate**: Percentage of assigned tasks completed on time
- **Communication Quality**: Use of standard formats and complete information
- **Team Coordination**: Successful cross-role collaboration and handoffs
- **Issue Resolution**: Time to resolve reported blockers and technical issues

Regular monitoring of these metrics helps ensure the team collaboration model is working effectively for your project.