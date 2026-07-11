# Enhanced Auto-Terminal Agent Monitor

**Advanced Multi-Agent Software Development Team Orchestration with Communication Enforcement, Quality Gates, and Intelligent Terminal Management**

## 🚀 What's New in Enhanced Mode

The Enhanced Agent Monitor implements comprehensive communication enforcement and quality management based on the `communication-enforce.md` requirements:

### ✨ Key Enhancement Features

- 🔧 **Git Discipline Enforcement** - Automated commit reminders, meaningful commit validation, feature branch workflows
- 💬 **Communication Protocol Enforcement** - Hub-and-spoke model, message templates, anti-pattern detection
- 🏷️ **Intelligent Terminal Naming** - Auto-rename terminals with descriptive names based on agent roles
- 🚪 **Quality Gate Management** - Automated quality checks, PM verification, blocking for failed gates
- 🛡️ **Anti-Pattern Prevention** - Prevents meeting hell, micromanagement, broadcast storms
- 📋 **Project Lifecycle Management** - Systematic project discovery and startup sequences

### 🎯 Core Benefits

- **Zero Work Loss**: Git discipline ensures no code is ever lost
- **Structured Communication**: Templates prevent miscommunication 
- **Quality Assurance**: Automated gates ensure standards are met
- **Team Efficiency**: Anti-pattern prevention reduces overhead
- **Professional Standards**: Enterprise-level team coordination

## 🏗️ Architecture Overview

The Enhanced Agent Monitor extends the base system with modular enforcement components:

```
Enhanced Team Orchestrator
├── Git Discipline Enforcer
├── Communication Protocol Enforcer  
├── Terminal Naming Manager
├── Quality Gate Manager
├── Project Lifecycle Manager
└── Anti-Pattern Guard
```

## 🚀 Quick Start

### Prerequisites

1. **Auto-Terminal** running with API enabled (port 3001)
2. **Node.js 16+** for optimal performance
3. **Valid API Token** from Auto-Terminal
4. **Enhanced team configuration** file

### Installation & Setup

```bash
# 1. Clone and install
git clone <repo>
cd agent-monitor
npm install

# 2. Build the enhanced modules
npm run build

# 3. Get API token from Auto-Terminal
# In Auto-Terminal Developer Console:
# await window.electronAPI.generateAPIToken('agent-monitor', ['*'])

# 4. Set environment variables
export API_TOKEN=your-token-here
export CHATHUB_WS_URL=ws://localhost:5000  # Optional

# 5. Validate configuration
npm run validate:config enhanced-team-config.json

# 6. Test enhanced features
npm run test:enhanced

# 7. Start enhanced team orchestration
npm run team:enhanced
```

### Basic Usage

```bash
# Start with default enhanced configuration
npm run team:enhanced

# Start with custom configuration
npm run team:enhanced:custom my-config.json enforcement-config.json

# Validate configuration before starting
npm run validate:config my-enhanced-config.json

# Test all enhanced features
npm run test:enhanced
```

## 📋 Configuration Guide

### Enhanced Team Configuration

The enhanced configuration extends the standard team config with enforcement settings:

```json
{
  "teamConfig": {
    "projectName": "My Project",
    "projectFolder": "/path/to/project",
    "chatHubChannel": 20,
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
      "cliCommand": "npx claude-code --model sonnet",
      "priority": 1,
      "specializations": ["Project Management", "Quality Assurance", "Git Discipline"],
      "maxConcurrentTasks": 5,
      "additionalResponsibilities": [
        "Enforce git discipline and remind team members to commit every 30 minutes",
        "Validate that all team communications follow message templates",
        "Ensure quality gates are met before allowing phase transitions"
      ]
    }
  ],
  "enforcement": {
    "gitDiscipline": {
      "enabled": true,
      "autoCommitInterval": 1800000,
      "maxWorkTimeWithoutCommit": 3600000,
      "enforceFeatureBranches": true,
      "requireMeaningfulCommits": true
    },
    "communicationProtocol": {
      "enabled": true,
      "enforceTemplates": true,
      "hubAndSpokeStrict": true,
      "maxExchangesBeforeEscalation": 3
    },
    "qualityGates": {
      "enabled": true,
      "minTestCoverage": 80,
      "maxResponseTime": 500,
      "minSecurityScore": 85,
      "automatedChecksEnabled": true,
      "blockingEnabled": true
    }
  }
}
```

### Configuration Validation

```bash
# Validate enhanced configuration
npm run validate:config enhanced-team-config.json

# Generate configuration report
node validate-enhanced-config.js enhanced-team-config.json
```

## 🔧 Enhancement Modules

### 1. Git Discipline Enforcer

**Purpose**: Prevents work loss through automated git safety protocols

**Features**:
- ⏰ **Auto-commit reminders** every 30 minutes
- 📝 **Meaningful commit validation** (blocks generic messages like "fixes")
- 🌿 **Feature branch enforcement** for new development
- 🚨 **Work time warnings** if >1 hour without commits
- 🔄 **Emergency recovery** commands and procedures

**Configuration**:
```json
{
  "gitDiscipline": {
    "enabled": true,
    "autoCommitInterval": 1800000,
    "maxWorkTimeWithoutCommit": 3600000,
    "enforceFeatureBranches": true,
    "requireMeaningfulCommits": true,
    "commitReminderEnabled": true,
    "emergencyRecoveryEnabled": true
  }
}
```

**Agent Integration**:
- Project Coordinators enforce discipline across team
- Automatic reminders sent via ChatHub or terminal messages
- Blocks task progression for agents with uncommitted work

### 2. Communication Protocol Enforcer

**Purpose**: Implements structured communication templates and hub-and-spoke model

**Features**:
- 📋 **Message templates** for STATUS, TASK, ESCALATION, BLOCKED, COMPLETED
- 🕸️ **Hub-and-spoke routing** (developers → PM → other roles)
- 🚫 **Anti-pattern detection** (broadcast storms, endless threads, micromanagement)
- ⚡ **Rate limiting** and message frequency control
- 📊 **Communication analytics** and violation tracking

**Message Templates**:

**STATUS Update**:
```
STATUS [AGENT_NAME] [TIMESTAMP]
Completed: 
- [Specific task 1]
- [Specific task 2]
Current: [What working on now]
Blocked: [Any blockers]
ETA: [Expected completion]
```

**TASK Assignment**:
```
TASK [ID]: [Clear title]
Assigned to: [AGENT]
Objective: [Specific goal]
Success Criteria:
- [Measurable outcome]
- [Quality requirement]
Priority: HIGH/MED/LOW
```

**Configuration**:
```json
{
  "communicationProtocol": {
    "enabled": true,
    "enforceTemplates": true,
    "hubAndSpokeStrict": true,
    "antiPatternDetection": true,
    "maxExchangesBeforeEscalation": 3,
    "rateLimitEnabled": true,
    "broadcastPreventionEnabled": true
  }
}
```

### 3. Terminal Naming Manager

**Purpose**: Organizes terminals with descriptive, role-based names

**Features**:
- 🏷️ **Auto-rename** terminals based on content analysis
- 🤖 **Agent role detection** (Claude-Frontend, Claude-Backend, etc.)
- 🖥️ **Service identification** (NextJS-Dev, API-Server, etc.)
- 💬 **Startup prompt** for user consent
- 📊 **Confidence scoring** for naming suggestions

**Naming Conventions**:
- **Claude Agents**: `Claude-Frontend`, `Claude-Backend`, `Claude-QA`
- **Dev Servers**: `NextJS-Dev`, `API-Server`, `Database-Server`
- **Services**: `Convex-Server`, `Docker-Container`, `Redis-Cache`
- **Utilities**: `Frontend-Shell`, `Backend-Shell`, `Testing-Shell`

**Configuration**:
```json
{
  "terminalNaming": {
    "enabled": true,
    "agentPattern": "Claude-{role}",
    "servicePattern": "{service}-Dev",
    "shellPattern": "{project}-Shell",
    "autoRename": true,
    "promptUser": true,
    "minimumConfidence": 0.6
  }
}
```

### 4. Quality Gate Manager

**Purpose**: Enforces quality standards with automated checks and PM verification

**Features**:
- 🚪 **Phase-based quality gates** for each project stage
- 🤖 **Automated quality checks** (tests, performance, security)
- 📊 **Continuous monitoring** with configurable intervals
- 🚫 **Blocking mechanism** prevents progression on failed gates
- 👨‍💼 **PM verification** requirements for critical transitions

**Quality Standards**:
- **Test Coverage**: Minimum 80% (configurable)
- **Performance**: Max 500ms response time
- **Security**: Minimum 85/100 security score
- **Documentation**: Minimum 70% coverage
- **Technical Debt**: Maximum 10% ratio

**Configuration**:
```json
{
  "qualityGates": {
    "enabled": true,
    "minTestCoverage": 80,
    "maxResponseTime": 500,
    "minSecurityScore": 85,
    "maxTechnicalDebtRatio": 0.1,
    "minDocumentationCoverage": 70,
    "automatedChecksEnabled": true,
    "continuousMonitoringEnabled": true,
    "blockingEnabled": true,
    "pmVerificationRequired": true
  }
}
```

### 5. Anti-Pattern Prevention

**Purpose**: Guards against common communication and management anti-patterns

**Prevented Anti-Patterns**:
- ❌ **Meeting Hell**: No synchronous meetings, async updates only
- ❌ **Endless Threads**: Max 3 exchanges before escalation required
- ❌ **Broadcast Storms**: Prevents "FYI to all" messages
- ❌ **Micromanagement**: Detects excessive status requests
- ❌ **Quality Shortcuts**: Blocks compromising quality standards

**Configuration**:
```json
{
  "antiPatternPrevention": {
    "enabled": true,
    "meetingPreventionEnabled": true,
    "micromanagementDetectionEnabled": true,
    "escalationTimeoutEnabled": true,
    "qualityShortcutPrevention": true
  }
}
```

## 📊 Monitoring & Analytics

### Real-Time Dashboard

Access the monitoring dashboard at `http://localhost:3000` when using terminal-monitor:

- **Agent Status**: Real-time view of all agents and their current activities
- **Communication Flow**: Visual representation of message routing
- **Quality Gates**: Status of all project quality gates
- **Git Discipline**: Commit frequency and compliance metrics
- **Terminal Organization**: Current terminal naming and organization

### Statistics & Reporting

```bash
# Get comprehensive statistics
node -e "
const orchestrator = require('./dist/enhanced-team-orchestrator');
console.log(JSON.stringify(orchestrator.getEnhancementStatistics(), null, 2));
"

# Export configuration and session state
# Automatic export on graceful shutdown to:
# enhanced-team-export-[timestamp].json
```

## 🔄 Workflows & Integration

### Enhanced Feature Development Workflow

```json
{
  "name": "Feature Development with Quality Gates",
  "phases": [
    {
      "name": "Requirements Analysis",
      "roles": ["Project Coordinator", "System Architect"],
      "qualityGateRequired": true,
      "gitRequirements": "Feature branch required",
      "communicationProtocol": "STATUS updates every 2 hours"
    },
    {
      "name": "Implementation", 
      "roles": ["Backend Developer", "Frontend Developer"],
      "qualityGateRequired": true,
      "gitRequirements": "Commit every 30 minutes, 80%+ test coverage",
      "communicationProtocol": "Cross-team communication through PM only"
    },
    {
      "name": "Testing & QA",
      "roles": ["QA Engineer"],
      "qualityGateRequired": true,
      "qualityStandards": "80% coverage, <500ms response time, security scan pass"
    }
  ]
}
```

### Integration with External Systems

**Discord Notifications**:
```json
{
  "teamConfig": {
    "discordWebhookUrl": "https://discord.com/api/webhooks/..."
  },
  "humanInteraction": {
    "notificationChannels": ["discord", "console"],
    "escalationToHuman": true
  }
}
```

**ChatHub Communication**:
```json
{
  "teamConfig": {
    "chatHubChannel": 20
  }
}
```

## 🛠️ Advanced Usage

### Custom Rules & Automation

Create custom enforcement rules:

```json
{
  "customRules": [
    {
      "id": "git-commit-frequency",
      "name": "Git Commit Frequency Enforcement",
      "condition": "timeSinceLastCommit > 30 * 60 * 1000",
      "action": {
        "type": "notify",
        "message": "CRITICAL: You must commit your work now."
      },
      "severity": "high"
    }
  ]
}
```

### Headless Mode Integration

```bash
# Enhanced headless mode
USE_HEADLESS=true npm run team:enhanced

# With custom headless configuration
USE_HEADLESS=true npm run team:enhanced:custom headless-team-config.json
```

### Multi-Environment Support

```bash
# Development environment
NODE_ENV=development npm run team:enhanced

# Production environment (stricter quality gates)
NODE_ENV=production npm run team:enhanced production-config.json

# Testing environment (relaxed enforcement)
NODE_ENV=testing npm run team:enhanced testing-config.json
```

## 🔧 Troubleshooting

### Common Issues

**Configuration Validation Errors**:
```bash
# Validate and get detailed error report
npm run validate:config enhanced-team-config.json
```

**Build Issues**:
```bash
# Ensure TypeScript compilation succeeded
npm run build

# Check for missing files
npm run test:enhanced
```

**API Connection Issues**:
```bash
# Test Auto-Terminal API connection
curl http://localhost:3001/api/terminals

# Regenerate API token
# In Auto-Terminal: await window.electronAPI.generateAPIToken('agent-monitor', ['*'])
```

**Git Discipline Not Working**:
- Ensure agents have proper git configuration
- Check project folder has git repository
- Verify agents have commit permissions

**Quality Gates Failing**:
- Check automated test setup in project
- Verify performance monitoring configuration
- Ensure security scanning tools are available

### Debug Mode

```bash
# Enable debug logging
DEBUG=enhanced-orchestrator npm run team:enhanced

# Verbose error reporting
NODE_ENV=debug npm run team:enhanced
```

### Recovery Procedures

**Emergency Recovery**:
```bash
# If team orchestration becomes unresponsive
kill -SIGTERM [orchestrator-pid]  # Graceful shutdown with export

# If git discipline blocked agents
node -e "
const { GitDisciplineEnforcer } = require('./dist/git-discipline-enforcer');
console.log(enforcer.generateEmergencyRecovery().join('\n'));
"
```

## 📚 Documentation

### Reference Documentation

- **[communication-enforce.md](docs/communication-enforce.md)** - Original requirements specification
- **[teamwork.md](teamwork.md)** - Team collaboration framework
- **[TEAM-ORCHESTRATION-GUIDE.md](TEAM-ORCHESTRATION-GUIDE.md)** - Orchestration guide
- **[HEADLESS-MODE.md](HEADLESS-MODE.md)** - Headless deployment guide

### API Documentation

```typescript
// Enhanced Team Orchestrator API
interface EnhancedTeamOrchestrator {
  start(): Promise<void>;
  deployTeam(): Promise<void>;
  getEnhancementStatistics(): EnhancementStats;
  exportConfiguration(): string;
  shutdown(): Promise<void>;
}

// Git Discipline Enforcer API
interface GitDisciplineEnforcer {
  startMonitoring(agent: AgentInstance, workingDirectory: string): void;
  validateCommitMessage(message: string): GitCommitQuality;
  generateEmergencyRecovery(): string[];
}

// Quality Gate Manager API
interface QualityGateManager {
  createQualityGate(id: string, name: string, phase: ProjectPhase): QualityGate;
  runAutomatedChecks(gateId: string, projectPath: string): Promise<QualityMetrics>;
  canAgentProceed(agentRole: AgentRole, phase: ProjectPhase): {canProceed: boolean, reason?: string};
}
```

## 🤝 Contributing

### Development Setup

```bash
# 1. Fork and clone repository
git clone <your-fork>
cd agent-monitor

# 2. Install dependencies
npm install

# 3. Create feature branch
git checkout -b feature/enhancement-name

# 4. Make changes and test
npm run build
npm run test:enhanced

# 5. Validate configuration
npm run validate:config enhanced-team-config.json

# 6. Submit pull request
```

### Adding New Enhancement Modules

1. Create module in `src/[module-name].ts`
2. Implement EventEmitter-based interface
3. Add to EnhancedTeamOrchestrator integration
4. Update configuration interfaces
5. Add validation tests
6. Update documentation

### Testing

```bash
# Run all enhanced feature tests
npm run test:enhanced

# Validate specific configuration
npm run validate:config my-config.json

# Test individual modules
node -e "require('./dist/git-discipline-enforcer').test()"
```

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🆘 Support

- **GitHub Issues**: Report bugs and feature requests
- **Discord Community**: Real-time community support
- **Documentation**: Comprehensive guides and API reference
- **Examples**: Production-ready configuration templates

---

**Enhanced Agent Monitor v2.0** - Professional multi-agent development team orchestration with enterprise-grade communication enforcement and quality management.