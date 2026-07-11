# Multi-Agent Software Development Team Orchestration v2.0

## 🎯 Overview

This system creates a fully autonomous software development team using AI agents that collaborate via ChatHub MCP, with intelligent monitoring and supervision by an Agent Monitor.

### ✨ Key Features

- 🤖 **Multi-Agent Collaboration**: Autonomous AI agents working together on software projects
- 📡 **ChatHub Integration**: Real-time coordination via ChatHub MCP tools and WebSocket monitoring  
- 🎭 **Role-Based Team**: Project Coordinator, System Architect, Developers, QA, UI/UX Engineers
- 🧠 **Intelligent Task Routing**: System Architect assigns tasks based on agent skills and availability
- 👁️ **Active Supervision**: Agent Monitor ensures continuous progress and prompts idle agents
- 🔔 **Discord Alerts**: Escalation to humans for critical issues and blockers
- ⚡ **Real-Time Monitoring**: WebSocket-based live activity tracking

## 🏗️ Architecture

```
┌─────────────────┐    WebSocket    ┌─────────────┐
│  Agent Monitor  │◄──────────────►│   ChatHub   │
│  (Supervisor)   │    Monitoring   │   Server    │
└─────────────────┘                 └─────────────┘
                                           ▲
                                           │ MCP Tools
                                           │
          ┌────────────────────────────────┼─────────────────────────────────┐
          │                                │                                 │
          ▼                                ▼                                 ▼
   ┌─────────────┐                 ┌─────────────┐                  ┌─────────────┐
   │ Project     │◄───────────────►│ System      │◄────────────────►│ Backend     │
   │ Coordinator │   Collaboration │ Architect   │   Task Assignment│ Developer   │
   │ (Reports)   │                 │ (Assigns)   │                  │ (Executes)  │
   └─────────────┘                 └─────────────┘                  └─────────────┘
          ▲                                ▲                                 ▲
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

### 🔄 Workflow

1. **Agent Monitor**: Connects to ChatHub via WebSocket (monitoring mode)
2. **AI Agents**: Connect to ChatHub via MCP tools (collaboration mode)
3. **Project Coordinator**: Reports project status and pending tasks
4. **System Architect**: Assigns tasks to appropriate team members
5. **Agent Monitor**: Detects idle agents when tasks are pending and prompts them
6. **Development Team**: Collaborates on implementation via ChatHub
7. **Escalation**: Critical issues automatically escalated to Discord

## 🚀 Quick Start

### Prerequisites

1. **Auto-Terminal**: Running on port 3001
2. **ChatHub Server**: Running on port 8080 with MCP support
3. **API Token**: Valid Auto-Terminal API token
4. **Discord Webhook**: (Optional) For escalation alerts

### Installation

```bash
cd docs/samples/agent-monitor
npm install
npm run build
```

### Basic Usage

1. **Create Team Configuration**:
   ```bash
   npm run team:example my-team.json
   ```

2. **Set Environment Variables**:
   ```bash
   # .env file
   API_TOKEN=your-auto-terminal-token
   CHATHUB_WS_URL=ws://localhost:8080
   DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/your-webhook
   ```

3. **Validate Configuration**:
   ```bash
   npm run team:validate my-team.json
   ```

4. **Start Team**:
   ```bash
   npm run team:start my-team.json
   ```

## 📋 Team Configuration

### Example Configuration

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
      "specializations": ["Project Management", "Team Coordination"],
      "maxConcurrentTasks": 5
    },
    {
      "id": "architect-001", 
      "name": "Morgan Architect",
      "role": "System Architect",
      "aiType": "Claude",
      "model": "opus",
      "cliCommand": "claude --model claude-3-opus",
      "priority": 2,
      "specializations": ["System Design", "Architecture Patterns"],
      "maxConcurrentTasks": 3
    },
    {
      "id": "backend-001",
      "name": "Jordan Backend",
      "role": "Backend Developer",
      "aiType": "Claude", 
      "model": "sonnet",
      "cliCommand": "claude --model claude-3-5-sonnet",
      "priority": 3,
      "specializations": ["Node.js", "APIs", "Databases"],
      "maxConcurrentTasks": 4
    }
  ]
}
```

### Available Roles

| Role | Responsibilities | MCP Tools Used |
|------|------------------|----------------|
| **Project Coordinator** | Reports status, manages blockers | `mcp_chathub_connect`, `mcp_chathub_send_message` |
| **System Architect** | **Assigns tasks**, technical decisions | `mcp_chathub_send_message`, `mcp_chathub_get_responsibility` |
| **Backend Developer** | Server-side implementation | `mcp_chathub_get_messages`, `mcp_chathub_what_next` |
| **Frontend Developer** | User interface development | `mcp_chathub_get_messages`, `mcp_chathub_what_next` |
| **UI/UX Engineer** | Design and user experience | `mcp_chathub_get_messages`, `mcp_chathub_what_next` |
| **QA Engineer** | Testing and quality assurance | `mcp_chathub_get_messages`, `mcp_chathub_what_next` |

## 🎮 CLI Commands

### Team Management
```bash
# Start team with configuration
npm run team:start config.json

# Start with custom ChatHub URL
node team-orchestrator.js start config.json --chathub-url ws://localhost:9090

# Validate configuration
npm run team:validate config.json

# Test environment setup
node team-orchestrator.js test-setup

# Create example configuration  
npm run team:example my-config.json
```

### Monitoring Commands
```bash
# Status is integrated into main process
npm run team:start config.json
# Shows live status every 5 minutes

# For detailed status, check the live output
```

## 📡 ChatHub Integration

### Agent MCP Commands

Each agent uses these MCP tools for collaboration:

```javascript
// Connect to ChatHub (done automatically in kickoff prompt)
/mcp_chathub_connect --role "Backend Developer" --aiType "Claude"

// Join team channel
/mcp_chathub_join_channel --channelId 1

// Send messages
/mcp_chathub_send_message --content "Task completed" --mentions "['Project Coordinator']"

// Get recent messages  
/mcp_chathub_get_messages --limit 20

// Get role responsibilities
/mcp_chathub_get_responsibility --role "Backend Developer"

// Get suggestions for next actions
/mcp_chathub_what_next --context "Just completed authentication"
```

### Agent Monitor WebSocket

The Agent Monitor connects via WebSocket to observe all communication:

```javascript
// Monitors ChatHub WebSocket for:
// - Project Coordinator status reports
// - Pending task announcements
// - Agent idle/active status
// - Critical issues and blockers

// Example monitored message:
{
  "type": "agent_message",
  "data": {
    "senderId": "coordinator-001", 
    "senderRole": "Project Coordinator",
    "content": "PENDING TASKS: Need backend API implementation",
    "timestamp": "2025-01-21T10:30:00Z"
  }
}
```

## 🤖 Agent Workflows

### 1. Project Coordinator Workflow
```
1. Connect to ChatHub via MCP
2. Monitor project progress
3. Report pending tasks: "PENDING TASKS: Need authentication module"  
4. Track blockers and escalate if needed
5. Provide status updates to team
```

### 2. System Architect Workflow  
```
1. Connect to ChatHub via MCP
2. Review pending tasks from Project Coordinator
3. Assign tasks: "@BackendDev please implement user authentication API"
4. Provide technical guidance
5. Review completed work
```

### 3. Developer Workflow
```
1. Connect to ChatHub via MCP
2. Monitor for task assignments
3. Acknowledge: "Accepted authentication task, starting work"
4. Request help if blocked: "Need clarification on security requirements"
5. Report completion: "Authentication API completed and tested"
```

### 4. Agent Monitor Workflow
```
1. Connect to ChatHub via WebSocket
2. Listen for Project Coordinator pending task reports
3. Identify idle agents
4. Prompt idle agents: "Check ChatHub for new task assignments"
5. Escalate critical issues to Discord
```

## 🔔 Discord Integration

### Alert Types

**Team Start Notification**:
```
🚀 Development Team Started
Multi-agent development team for E-Commerce Platform is now operational!
👥 Team Size: 6 agents
📡 ChatHub Channel: 1
```

**Escalation Alert**:
```
🚨 Backend Developer Needs Assistance  
Backend Developer reported: Cannot resolve database connection issue
Severity: HIGH
Suggested Action: Review database configuration
```

**Status Update**:
```
📊 Team Status Update
Project: E-Commerce Platform
🤖 Active Agents: 4/6
📋 Task Progress: 12/20 completed
🚫 Blocked Tasks: 1
```

## 🛠️ Development & Debugging

### Debug Mode
```bash
# Enable verbose logging
DEBUG=agent-monitor:* npm run team:start config.json

# Or use CLI flag
node team-orchestrator.js start config.json --verbose
```

### Environment Variables
```bash
# Required
API_TOKEN=your-auto-terminal-token

# Optional (with defaults)
API_URL=http://localhost:3001
WS_URL=ws://localhost:9876  
CHATHUB_WS_URL=ws://localhost:8080
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

### Testing Setup
```bash
# Test all connections and environment
npm run team:test-setup

# Test Discord webhook
npm run test:webhook
```

## 📊 Monitoring & Metrics

### Real-Time Status Display
```
📊 Team Status Summary:
══════════════════════════════════════════════════
  Project: E-Commerce Platform
  🤖 Active Agents: 4/6
  🔗 Connected to ChatHub: 6/6  
  💤 Idle: 2
  ❌ Errors: 0
  📡 Monitor Connected: ✅
  📋 Status: Pending tasks reported by Project Coordinator
══════════════════════════════════════════════════
```

### Key Metrics Tracked
- Agent connectivity to ChatHub
- Active vs idle agent status  
- Pending task notifications
- Response times to task assignments
- Critical issues and escalations
- Project Coordinator status reports

## 🚨 Troubleshooting

### Common Issues

**Agents Not Connecting to ChatHub**
```bash
# Check ChatHub server
curl http://localhost:8080/health

# Verify MCP tools available in agent terminals
# In agent CLI: /mcp_chathub_connect
```

**Agent Monitor WebSocket Connection Failed**
```bash
# Check WebSocket URL
echo $CHATHUB_WS_URL

# Test connection
node -e "const ws = require('ws'); new ws('ws://localhost:8080').on('open', () => console.log('✅ Connected'))"
```

**Tasks Not Being Assigned**
```bash
# Verify System Architect is connected
# Check ChatHub for architect messages  
# Ensure Project Coordinator is reporting tasks with "PENDING TASKS:" prefix
```

**Discord Alerts Not Working**
```bash
# Test webhook
npm run test:webhook

# Check webhook URL format
# Verify Discord server permissions
```

### Log Analysis

Monitor for these key log messages:
```bash
✅ Agent Monitor connected to ChatHub      # Monitor WebSocket OK
🔗 AgentName connected to ChatHub          # Agent MCP connection OK  
📋 Project Coordinator reports X pending   # Task detection working
📨 Prompted AgentName to check ChatHub     # Idle agent activation
🚨 Critical issues detected: N             # Escalation triggered
```

## 🎯 Best Practices

### Team Configuration
- **Start small**: 3-4 agents for initial testing
- **Required roles**: Always include Project Coordinator and System Architect
- **Balanced workload**: Set appropriate `maxConcurrentTasks` per agent
- **Clear specializations**: Define specific skills per agent

### Project Coordination  
- **Specific task descriptions**: Provide clear, actionable task details
- **Regular status updates**: Project Coordinator should report progress frequently
- **Escalation protocols**: Define when to request human intervention
- **Documentation**: Keep track of decisions and architecture changes

### System Architecture
- **Task granularity**: Break large features into smaller, manageable tasks
- **Clear dependencies**: Define task prerequisites and order
- **Skill matching**: Assign tasks based on agent specializations  
- **Load balancing**: Distribute work evenly across team

### Quality Assurance
- **Continuous testing**: QA Engineer validates all completed work
- **Code review**: System Architect reviews critical changes
- **Automated testing**: Implement test suites where possible
- **Documentation**: Maintain current technical documentation

## 📈 Success Metrics

### Team Performance
- **Task completion rate**: Percentage of tasks completed on time
- **Agent utilization**: Average workload across team members
- **Communication frequency**: Messages per hour in ChatHub
- **Response time**: Time from task assignment to acknowledgment

### Quality Metrics  
- **Issue detection**: Problems caught before completion
- **Review effectiveness**: Feedback quality from System Architect
- **Test coverage**: Automated and manual test success rates
- **Documentation quality**: Up-to-date technical documentation

### Operational Metrics
- **Uptime**: Agent availability and connectivity
- **Escalation rate**: Human intervention requests per day
- **Issue resolution**: Average time to resolve blockers
- **Coordination efficiency**: Time from task creation to assignment

## 📚 Advanced Usage

### Custom AI Models
```json
{
  "agents": [
    {
      "aiType": "Gemini",
      "model": "gemini-2.0-flash-exp", 
      "cliCommand": "gemini --model gemini-2.0-flash-exp"
    }
  ]
}
```

### Multiple Projects
```bash
# Run separate teams for different projects
npm run team:start project-a-config.json &
npm run team:start project-b-config.json &
```

### Extended Roles
```json
{
  "agents": [
    {
      "role": "DevOps Engineer",
      "specializations": ["Docker", "Kubernetes", "CI/CD"]
    },
    {
      "role": "Database Engineer", 
      "specializations": ["PostgreSQL", "Redis", "MongoDB"]
    }
  ]
}
```

---

## 📄 License

MIT License - see LICENSE file for details.

## 🤝 Contributing

This is a demonstration system for Auto-Terminal's multi-agent capabilities. Contributions welcome!

---

**Multi-Agent Team Orchestration v2.0** - Autonomous AI development teams with intelligent supervision and real-time collaboration.