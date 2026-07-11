# Multi-Agent Software Development Team Orchestration Guide

## Overview

This system creates a fully autonomous software development team using AI agents that collaborate via ChatHub MCP. The agent-monitor acts as a supervisor, monitoring agent activity and ensuring continuous progress.

### 🖥️ Headless Mode Support

The orchestration system now supports **both UI and headless modes**:

- **Headless Mode**: Each agent runs in an independent terminal process (recommended for servers)
- **UI Mode**: All agents share a tab in Auto-Terminal GUI (traditional mode)
- **Automatic Detection**: The system automatically chooses the best mode based on availability

## Architecture

```
┌─────────────────┐    WebSocket    ┌─────────────┐
│  Agent Monitor  │◄──────────────►│   ChatHub   │
└─────────────────┘                 └─────────────┘
                                           ▲
                                           │ MCP Tools
                                           │
          ┌────────────────────────────────┼─────────────────────────────────┐
          │                                │                                 │
          ▼                                ▼                                 ▼
   ┌─────────────┐                 ┌─────────────┐                  ┌─────────────┐
   │ Project     │                 │ System      │                  │ Backend     │
   │ Coordinator │                 │ Architect   │                  │ Developer   │
   └─────────────┘                 └─────────────┘                  └─────────────┘
          │                                │                                 │
          └────────────────────────────────┼─────────────────────────────────┘
                                           │
                    ┌──────────────────────┼──────────────────────┐
                    │                      │                      │
                    ▼                      ▼                      ▼
             ┌─────────────┐        ┌─────────────┐        ┌─────────────┐
             │ Frontend    │        │ UI/UX       │        │ QA          │
             │ Developer   │        │ Engineer    │        │ Engineer    │
             └─────────────┘        └─────────────┘        └─────────────┘
```

## Key Roles and Responsibilities

### Agent Monitor (Supervisor)
- **Connection**: WebSocket to ChatHub (monitoring mode)
- **Responsibilities**:
  - Monitor all agent activity and status
  - Listen to Project Coordinator messages about pending tasks
  - Prompt idle agents to check ChatHub when tasks are available
  - Escalate critical issues to Discord
  - Maintain heartbeat and health checks

### Project Coordinator (Agent)
- **Connection**: ChatHub MCP tools
- **Responsibilities**:
  - Overall project management and coordination
  - Report task status and blockers in ChatHub
  - Communicate pending tasks that need assignment
  - Escalate issues that require human intervention

### System Architect (Agent)
- **Connection**: ChatHub MCP tools
- **Responsibilities**:
  - **Primary Task Assigner**: Assigns tasks to appropriate team members
  - Technical architecture decisions
  - Code review and approval
  - Cross-team coordination

### Development Team (Agents)
- **Connection**: ChatHub MCP tools
- **Responsibilities**:
  - Implement assigned tasks
  - Collaborate via ChatHub
  - Report progress and blockers
  - Request help when needed

## Workflow

### 1. Team Initialization

#### Headless Mode (Recommended)
```bash
# Automatically start Auto-Terminal in headless mode and run team
npm run team:headless example-team.json

# Test headless integration first
node test-headless-integration.js
```

#### UI Mode (Traditional)
```bash
# Start with Auto-Terminal GUI (ensure Auto-Terminal is running)
npm run team:ui example-team.json

# Or use the original command
npm run team:start example-team.json
```

**What happens:**
1. **Headless Mode**: Agent-monitor connects to Auto-Terminal's headless API
2. Agent-monitor connects to ChatHub via WebSocket
3. Agent-monitor creates independent terminal processes for each agent (headless) or shared tab terminals (UI)
4. Each agent starts their AI CLI and joins ChatHub via MCP
5. All agents introduce themselves in the ChatHub channel

### 2. Task Assignment Flow
```
Project Coordinator → Reports pending tasks → ChatHub
                                                ↓
System Architect → Reads tasks → Assigns to developers → ChatHub
                                                            ↓
Developers → Receive assignments → Acknowledge → Start work
```

### 3. Monitoring and Activation
```
Agent Monitor → Monitors ChatHub → Detects idle agents + pending tasks
                     ↓
Agent Monitor → Prompts idle agents → "Check ChatHub for new tasks"
                     ↓
Idle Agents → Check ChatHub → Find assignments → Begin work
```

## Configuration

### Team Configuration File
```json
{
  "teamConfig": {
    "projectName": "E-Commerce Platform",
    "projectFolder": "C:/Projects/ecommerce-platform",
    "chatHubChannel": 1,
    "discordWebhookUrl": "https://discord.com/api/webhooks/...",
    "maxIdleTime": 300,
    "heartbeatInterval": 120
  },
  "agents": [
    {
      "id": "coordinator-001",
      "name": "Alex Coordinator",
      "role": "Project Coordinator",
      "aiType": "Claude",
      "model": "sonnet",
      "cliCommand": "claude --model claude-3-5-sonnet",
      "priority": 1,
      "specializations": ["Project Management", "Coordination"],
      "maxConcurrentTasks": 5
    }
    // ... more agents
  ]
}
```

### Environment Setup
```bash
# Required environment variables
API_URL=http://localhost:3001
WS_URL=ws://localhost:9876
API_TOKEN=your-auto-terminal-token
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook
```

## Agent Kickoff Prompts

Each agent receives a role-specific kickoff prompt that includes:

```
You are the [ROLE] for the [PROJECT] project.

Your responsibilities:
- [Role-specific responsibilities]

IMPORTANT: 
1. Join ChatHub channel [CHANNEL_ID] immediately
2. Use /chathub_get_responsibility to understand your full role
3. Monitor ChatHub for task assignments and team communication
4. Collaborate actively with other team members

For System Architect specifically:
- You are responsible for assigning tasks to team members
- Use ChatHub to coordinate task distribution
- Monitor team progress and adjust assignments as needed
```

## Monitoring and Alerting

### Agent Activity Monitoring
- **Idle Detection**: Agents idle > 5 minutes with pending tasks
- **Health Checks**: Every 2 minutes via heartbeat
- **Response Monitoring**: Track completion of assigned work

### Discord Escalation Triggers
- Critical issues reported by any agent
- Project Coordinator requests human help
- Agents unresponsive for > 10 minutes
- System-wide failures or blocks

### Escalation Message Example
```json
{
  "title": "🚨 System Architect Needs Assistance",
  "description": "System Architect reported inability to resolve architecture conflict",
  "severity": "high",
  "affectedAgents": ["architect-001"],
  "suggestedAction": "Review technical requirements and provide guidance"
}
```

## Command Line Interface

### Start Team
```bash
# Start with configuration file
npm run team:start path/to/team-config.json

# Or use the CLI directly
node team-orchestrator.js start team-config.json

# Resume from previous session (reconnect to existing agents)
npm run team:start team-config.json --resume
```

### Session Management
```bash
# Check if there's a saved session
npm run team:session team-config.json

# Resume from saved session
npm run team:start team-config.json --resume
```

### Validate Configuration
```bash
npm run team:validate team-config.json
```

### Create Example Configuration
```bash
npm run team:example my-team-config.json
```

### Monitor Commands
```bash
# Test Discord webhook
npm run test:webhook

# Start in development mode with verbose logging
npm run team:start team-config.json --verbose
```

## ChatHub Integration

### Agent MCP Commands
Agents use these MCP tools for collaboration:

```javascript
// Connect to ChatHub
await mcp_chathub_connect({ role: "Backend Developer", aiType: "Claude" });

// Join team channel
await mcp_chathub_join_channel({ channelId: 1 });

// Send messages
await mcp_chathub_send_message({ 
  content: "I've completed the user authentication module",
  mentions: ["Project Coordinator"] 
});

// Get messages and tasks
await mcp_chathub_get_messages({ limit: 20 });

// Get role responsibilities
await mcp_chathub_get_responsibility({ role: "Backend Developer" });

// Check what to do next
await mcp_chathub_what_next({ 
  context: "Just completed authentication",
  currentTask: "User management system" 
});
```

### Agent Monitor WebSocket
The monitor connects via WebSocket to observe all communication:

```javascript
// Connect to same ChatHub instance
const ws = new WebSocket('ws://chathub-server:8080/channel/1');

// Listen for Project Coordinator messages
ws.on('message', (data) => {
  const message = JSON.parse(data);
  if (message.senderRole === 'Project Coordinator' && 
      message.content.includes('PENDING TASKS')) {
    // Prompt idle agents to check ChatHub
    promptIdleAgents();
  }
});
```

## Troubleshooting

### Common Issues

#### Agents Not Connecting to ChatHub
```bash
# Check ChatHub server status
curl http://localhost:8080/health

# Verify agent MCP tools are available
# In agent terminal: /chathub_connect
```

#### Agent Monitor Not Detecting Messages
```bash
# Check WebSocket connection
# Monitor should log: "✅ Connected to ChatHub WebSocket"

# Verify channel ID matches team configuration
# Check ChatHub server logs for connection attempts
```

#### Tasks Not Being Assigned
```bash
# Verify System Architect is active
# Check ChatHub for architect messages
# Ensure Project Coordinator is reporting tasks correctly
```

#### Discord Alerts Not Working
```bash
# Test webhook
npm run test:webhook

# Check webhook URL format
# Verify Discord server permissions
```

### Debug Mode
Enable detailed logging by setting environment variable:
```bash
DEBUG=agent-monitor:* npm run team:start team-config.json
```

## Resume Feature

The agent-monitor automatically saves session data to allow resuming after crashes or unexpected shutdowns. This ensures your multi-agent team can continue working even after interruptions.

### How It Works

1. **Automatic Saving**: Session data is saved:
   - Immediately after all agents are provisioned
   - Every 60 seconds during operation
   - Location: `{projectFolder}/.agent-monitor/session-data.json`

2. **Session Data Includes**:
   - All agent terminal IDs and process IDs
   - Agent status and completion state
   - ChatHub connection information
   - Project status and pending tasks
   - Tab ID for terminal grouping

3. **Resume Process**:
   - Reconnects to existing terminals if they're still alive
   - Recreates missing terminals in the same tab
   - Restores agent status and project state
   - Prompts agents to reconnect to ChatHub
   - Resumes monitoring and idle detection

### Usage

```bash
# Check if a previous session exists
npm run team:session team-config.json

# Resume from saved session
npm run team:start team-config.json --resume

# Example output when resuming:
# 🔄 Resuming Multi-Agent Software Development Team
# 📊 Previous Session Summary:
#   • Project: E-Commerce Platform
#   • Started: 1/22/2025, 10:30:00 AM (15 minutes ago)
#   • Agents: 7 total, 5 connected to ChatHub
#   • Status: 2 agents completed tasks
#   • Tab ID: tab-1234567890
#   • Channel: 1
# 
# 🔍 Verifying agent terminals...
# ✅ Reconnected to Alex Coordinator (term-001)
# ✅ Reconnected to Morgan Architect (term-002)
# ⚠️ Terminal no longer exists for Jordan Backend, recreating...
# ...
```

### Session Lock

- A lock file prevents multiple instances from running simultaneously
- Lock file: `{projectFolder}/.agent-monitor/session.lock`
- Contains process ID and last update timestamp
- Automatically cleared when process exits normally
- Stale locks (>5 minutes) are automatically removed

### Best Practices for Resume

1. **Always use --resume** after unexpected shutdowns
2. **Check session status** before starting a new team
3. **Agents may need to reconnect** to ChatHub after resume
4. **Monitor Discord** for resume notifications
5. **Clear session data** if you want a fresh start:
   ```bash
   rm -rf {projectFolder}/.agent-monitor/
   ```

## Best Practices

### Team Configuration
- **Start small**: Begin with 3-4 agents for testing
- **Clear roles**: Ensure each agent has distinct responsibilities  
- **Realistic workload**: Don't overload agents with too many concurrent tasks
- **Monitor capacity**: Adjust `maxConcurrentTasks` based on performance

### Project Coordination
- **Clear communication**: Project Coordinator should provide specific task descriptions
- **Regular check-ins**: Schedule periodic status updates
- **Escalation paths**: Define when to involve humans
- **Documentation**: Keep track of decisions and progress

### System Architecture Tasks
- **Task granularity**: Break large features into smaller, manageable tasks
- **Dependencies**: Clearly define task dependencies
- **Skill matching**: Assign tasks based on agent specializations
- **Load balancing**: Distribute work evenly across team

### Quality Assurance
- **Continuous testing**: QA Engineer should validate all completed work
- **Test automation**: Implement automated testing where possible
- **Code review**: System Architect should review all critical changes
- **Documentation**: Maintain up-to-date technical documentation

## Example Scenarios

### Scenario 1: New Feature Development
```
1. Project Coordinator: "We need to implement user profile management"
2. System Architect: Reviews requirements, breaks into tasks:
   - Backend: User profile API endpoints
   - Frontend: Profile management UI
   - UI/UX: Profile design mockups
   - QA: Test cases for profile functionality
3. System Architect assigns tasks via ChatHub
4. Developers acknowledge and begin work
5. Agent Monitor ensures all agents stay active
6. QA Engineer validates completed components
```

### Scenario 2: Bug Fix Emergency
```
1. QA Engineer: "Critical bug in payment processing"
2. Project Coordinator: Escalates to high priority
3. System Architect: Assigns to Backend Developer immediately
4. Agent Monitor: Ensures rapid response
5. Backend Developer: Investigates and fixes
6. QA Engineer: Validates fix
7. System Architect: Approves deployment
```

### Scenario 3: Agent Becomes Idle
```
1. Agent Monitor: Detects Frontend Developer idle for 5 minutes
2. Project Coordinator: Has reported pending UI tasks
3. Agent Monitor: Prompts Frontend Developer to check ChatHub
4. Frontend Developer: Checks messages, finds new assignment
5. Frontend Developer: Acknowledges task and begins work
```

## Success Metrics

### Team Performance
- **Task completion rate**: % of tasks completed on time
- **Agent utilization**: Average workload across team
- **Communication frequency**: Messages per hour in ChatHub
- **Escalation rate**: Human intervention requests per day

### Quality Metrics
- **Bug detection rate**: Issues caught by QA before completion
- **Code review feedback**: Architecture feedback frequency
- **Test coverage**: Automated test success rate
- **Documentation quality**: Up-to-date documentation percentage

### Operational Metrics
- **Uptime**: Agent availability percentage
- **Response time**: Average time to acknowledge tasks
- **Coordination efficiency**: Time from task creation to assignment
- **Issue resolution**: Average time to resolve blockers

This orchestration system creates a self-managing development team that can handle complex software projects with minimal human oversight while maintaining high quality and communication standards.