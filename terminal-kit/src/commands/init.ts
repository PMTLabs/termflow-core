import chalk from 'chalk';
import fs from 'fs-extra';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

interface InitOptions {
  force?: boolean;
  docs?: boolean;
  apiUrl?: string;
}

// Template content embedded directly for portability
const TEMPLATES = {
  agentCommsReadme: `# Agent Communication Directory

This directory facilitates cross-terminal communication between AI agent teams.

## Structure

\`\`\`
.agent-comms/
├── requests/        # PM -> Leader Agent requests (REQ-YYYYMMDD-NNN.md)
├── responses/       # Leader Agent -> PM responses (RESP-YYYYMMDD-NNN.md)
├── status/          # Real-time status files (terminal-{id}.status)
├── shared/          # Shared context and cached findings
│   └── findings/    # Research results cache
└── README.md        # This file
\`\`\`

## Usage

See \`docs/multi-team-agent-workflow.md\` for full protocol documentation.

## Quick Reference

### Create Request (PM)
\`\`\`bash
cat > requests/REQ-$(date +%Y%m%d)-001.md << 'EOF'
# Research Request
**ID:** REQ-...
**Priority:** HIGH
**Status:** PENDING
## Description
...
EOF
\`\`\`

### Write Response (Leader Agent)
\`\`\`bash
cat > responses/RESP-$(date +%Y%m%d)-001.md << 'EOF'
# Research Response
**Request ID:** REQ-...
**Status:** COMPLETE
## Summary
...
EOF
\`\`\`

## Notes

- Files in this directory are ephemeral communication artifacts
- Clean up periodically to avoid clutter
`,

  mcpJson: (apiUrl: string) => `{
  "mcpServers": {
    "open-terminal": {
      "command": "node",
      "type": "stdio",
      "args": ["path/to/auto-terminal/mcp-server/build/index.js"],
      "env": {
        "AUTO_TERMINAL_API_URL": "${apiUrl}"
      }
    }
  }
}
`,

  geminiSettings: (apiUrl: string) => `{
  "mcpServers": {
    "open-terminal": {
      "command": "node",
      "type": "stdio",
      "args": ["path/to/auto-terminal/mcp-server/build/index.js"],
      "env": {
        "AUTO_TERMINAL_API_URL": "${apiUrl}"
      }
    }
  }
}
`,

  claudeSettings: `{
  "permissions": {
    "allow": [
      "Bash(npm:*)",
      "Bash(npx:*)",
      "Bash(git:*)",
      "mcp__open-terminal__*"
    ],
    "deny": []
  }
}
`,

  workflowDoc: `# Multi-Team Agent Workflow Protocol

> **Version:** 1.0
> Initialized by terminal-kit

---

## Overview

This document defines the workflow protocol for multi-team AI agent orchestration across separate terminals.

## Team Structure

\`\`\`
                                    +-----------------+
                                    |     Human       |
                                    |  (User Input)   |
                                    +--------+--------+
                                             |
                                             | Terminal I/O
                                             v
+------------------------------------------------------------------+
|                         TERMINAL A                                |
|                    (Development Team)                             |
|                                                                   |
|  +------------------+                                             |
|  | Project Manager  |<------------------------------------------+ |
|  |  (Orchestrator)  |                                           | |
|  +--------+---------+                                           | |
|           |                                                     | |
|           | Subagent Delegation                                 | |
|           v                                                     | |
|  +--------+---------+    +-------------+    +---------------+   | |
|  |    Architect     |    | Implementer |    | QA/Reviewer   |   | |
|  | (Design Phase)   |    | (Code Phase)|    | (Test Phase)  |   | |
|  +------------------+    +-------------+    +---------------+   | |
|                                                                   |
+------------------------------------------------------------------+
         |                                              ^
         | MCP: execute_command                         | File Read
         | File Write (.agent-comms/)                   | (.agent-comms/)
         v                                              |
+------------------------------------------------------------------+
|                         TERMINAL B                                |
|                      (Research Team)                              |
|                                                                   |
|  +------------------+                                             |
|  |  Leader Agent    |<------ Reads request from .agent-comms/    |
|  | (Team Lead)      |------- Writes report to .agent-comms/      |
|  +--------+---------+                                             |
|           |                                                       |
|           | Subagent Delegation                                   |
|           v                                                       |
|  +------------------+                                             |
|  |  Explorer Agent  |                                             |
|  | (Search/Read)    |                                             |
|  +------------------+                                             |
|                                                                   |
+------------------------------------------------------------------+
\`\`\`

---

## Communication Channels

### 1. Human <-> Project Manager (Terminal I/O)
**Direction:** Bidirectional
**Method:** Direct terminal input/output

### 2. Project Manager <-> Leader Agent (Cross-Terminal)
**Direction:** Bidirectional
**Method:** File exchange (\`.agent-comms/\`) + MCP Server

#### PM -> Leader Agent (Request)
1. PM writes request to \`.agent-comms/requests/REQ-{timestamp}.md\`
2. PM uses MCP \`execute_command\` to spawn/activate Leader Agent in Terminal B
3. Leader Agent monitors/reads \`.agent-comms/requests/\` for new files

#### Leader Agent -> PM (Response)
1. Leader Agent writes report to \`.agent-comms/responses/RESP-{timestamp}.md\`
2. PM polls \`.agent-comms/responses/\` or receives notification

### 3. Within-Terminal Communication (Subagents)
**Direction:** Bidirectional
**Method:** In-process subagent delegation (Task tool)

---

## MCP Server Tools

| Tool | Purpose |
|------|---------|
| \`list_terminals\` | Discover available terminals |
| \`create_terminal\` | Spawn new terminal |
| \`execute_command\` | Run command in terminal |
| \`get_terminal_output\` | Read terminal output |
| \`close_terminal\` | Terminate terminal |

---

## File Exchange Protocol

### Request Message Format

\`\`\`markdown
# Research Request

**ID:** REQ-{YYYYMMDD}-{SEQ}
**From:** Project Manager
**To:** Leader Agent
**Timestamp:** {ISO 8601}
**Priority:** HIGH | MEDIUM | LOW
**Status:** PENDING

## Request Type
- [ ] Code Exploration
- [ ] Log Analysis
- [ ] Documentation Search

## Description
{Detailed description}

## Expected Output
{What the PM needs back}
\`\`\`

### Response Message Format

\`\`\`markdown
# Research Response

**ID:** RESP-{YYYYMMDD}-{SEQ}
**Request ID:** REQ-{YYYYMMDD}-{SEQ}
**From:** Leader Agent
**To:** Project Manager
**Status:** COMPLETE | PARTIAL | FAILED

## Summary
{Brief summary of findings}

## Detailed Findings
...

## Recommendations
{Suggestions based on findings}
\`\`\`

---

## Quick Start

### Step 1: Initialize Communication Folder (Done by tk init)

### Step 2: Start Auto-Terminal API Server
\`\`\`bash
# In auto-terminal project
npm run api
\`\`\`

### Step 3: Configure MCP in Your AI Tool
Update \`.mcp.json\` with the correct path to the MCP server.

### Step 4: Start Working
Use the PM in Terminal A to orchestrate, and Leader Agent in Terminal B for research.

---

*Initialized by terminal-kit CLI*
`
};

export async function initCommand(options: InitOptions): Promise<void> {
  const cwd = process.cwd();
  const apiUrl = options.apiUrl || 'http://localhost:42031';
  const includeDocs = options.docs !== false;

  console.log(chalk.blue.bold('\n🚀 Terminal Kit - Initializing multi-team agent workflow\n'));
  console.log(chalk.gray(`   Target: ${cwd}`));
  console.log(chalk.gray(`   API URL: ${apiUrl}\n`));

  try {
    // Check for existing files
    const existingFiles: string[] = [];
    const filesToCheck = [
      '.agent-comms',
      '.mcp.json',
      '.gemini',
      '.claude'
    ];

    if (includeDocs) {
      filesToCheck.push('docs/multi-team-agent-workflow.md');
    }

    for (const file of filesToCheck) {
      if (await fs.pathExists(path.join(cwd, file))) {
        existingFiles.push(file);
      }
    }

    if (existingFiles.length > 0 && !options.force) {
      console.log(chalk.yellow('⚠️  The following files/folders already exist:'));
      existingFiles.forEach(f => console.log(chalk.yellow(`   - ${f}`)));
      console.log(chalk.yellow('\n   Use --force to overwrite.\n'));
      process.exit(1);
    }

    // Create .agent-comms directory structure
    console.log(chalk.cyan('Creating .agent-comms/ structure...'));
    await fs.ensureDir(path.join(cwd, '.agent-comms/requests'));
    await fs.ensureDir(path.join(cwd, '.agent-comms/responses'));
    await fs.ensureDir(path.join(cwd, '.agent-comms/status'));
    await fs.ensureDir(path.join(cwd, '.agent-comms/shared/findings'));
    await fs.writeFile(
      path.join(cwd, '.agent-comms/README.md'),
      TEMPLATES.agentCommsReadme
    );
    console.log(chalk.green('✓ Created .agent-comms/'));
    console.log(chalk.gray('  ├── requests/'));
    console.log(chalk.gray('  ├── responses/'));
    console.log(chalk.gray('  ├── status/'));
    console.log(chalk.gray('  ├── shared/findings/'));
    console.log(chalk.gray('  └── README.md'));

    // Create .mcp.json
    console.log(chalk.cyan('\nCreating .mcp.json...'));
    await fs.writeFile(
      path.join(cwd, '.mcp.json'),
      TEMPLATES.mcpJson(apiUrl)
    );
    console.log(chalk.green('✓ Created .mcp.json'));

    // Create .gemini/settings.json
    console.log(chalk.cyan('\nCreating .gemini/settings.json...'));
    await fs.ensureDir(path.join(cwd, '.gemini'));
    await fs.writeFile(
      path.join(cwd, '.gemini/settings.json'),
      TEMPLATES.geminiSettings(apiUrl)
    );
    console.log(chalk.green('✓ Created .gemini/settings.json'));

    // Create .claude/settings.local.json
    console.log(chalk.cyan('\nCreating .claude/settings.local.json...'));
    await fs.ensureDir(path.join(cwd, '.claude'));
    await fs.writeFile(
      path.join(cwd, '.claude/settings.local.json'),
      TEMPLATES.claudeSettings
    );
    console.log(chalk.green('✓ Created .claude/settings.local.json'));

    // Create docs if requested
    if (includeDocs) {
      console.log(chalk.cyan('\nCreating docs/multi-team-agent-workflow.md...'));
      await fs.ensureDir(path.join(cwd, 'docs'));
      await fs.writeFile(
        path.join(cwd, 'docs/multi-team-agent-workflow.md'),
        TEMPLATES.workflowDoc
      );
      console.log(chalk.green('✓ Created docs/multi-team-agent-workflow.md'));
    }

    // Success message
    console.log(chalk.green.bold('\n✨ Multi-team agent workflow initialized!\n'));

    console.log(chalk.white.bold('Next steps:'));
    console.log(chalk.white('  1. Start Auto-Terminal API server (port 42031)'));
    console.log(chalk.white('  2. Update .mcp.json with the correct MCP server path'));
    console.log(chalk.white('  3. Configure your AI tool to use the MCP servers'));
    if (includeDocs) {
      console.log(chalk.white('  4. See docs/multi-team-agent-workflow.md for protocol details'));
    }
    console.log('');

  } catch (error) {
    console.error(chalk.red('\n❌ Error initializing workflow:'), error);
    process.exit(1);
  }
}
