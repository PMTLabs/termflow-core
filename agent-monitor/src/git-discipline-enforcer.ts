/**
 * Git Discipline Enforcer - Implements mandatory git safety protocols
 * Based on communication-enforce.md requirements
 */

import { EventEmitter } from 'events';
import chalk from 'chalk';
import { AgentInstance } from './team-types';

export interface GitDisciplineConfig {
  autoCommitInterval: number; // 30 minutes default (in ms)
  enforceFeatureBranches: boolean;
  requireMeaningfulCommits: boolean;
  maxWorkTimeWithoutCommit: number; // 1 hour max (in ms)
  commitReminderEnabled: boolean;
  emergencyRecoveryEnabled: boolean;
}

export interface GitWorkSession {
  agentId: string;
  startTime: Date;
  lastCommitTime: Date | null;
  currentBranch: string | null;
  uncommittedChanges: boolean;
  workingDirectory: string;
}

export interface GitCommitQuality {
  message: string;
  isMeaningful: boolean;
  score: number; // 0-1 rating
  issues: string[];
  suggestions: string[];
}

export class GitDisciplineEnforcer extends EventEmitter {
  private config: GitDisciplineConfig;
  private workSessions: Map<string, GitWorkSession> = new Map();
  private commitReminders: Map<string, NodeJS.Timeout> = new Map();
  private workTimeWarnings: Map<string, NodeJS.Timeout> = new Map();

  // Bad commit message patterns
  private readonly BAD_COMMIT_PATTERNS = [
    /^(fix|update|change|modify)$/i,
    /^(fixes|updates|changes)$/i,
    /^(wip|temp|tmp)$/i,
    /^(misc|stuff|things)$/i,
    /^[.]{1,3}$/,
    /^(a|an|the)\s/i
  ];

  // Good commit message patterns (examples)
  private readonly GOOD_COMMIT_EXAMPLES = [
    "Add user authentication endpoints with JWT tokens",
    "Fix null pointer in payment processing module", 
    "Refactor database queries for 40% performance gain",
    "Implement Redis caching for session management",
    "Add comprehensive error handling to API routes"
  ];

  constructor(config: GitDisciplineConfig) {
    super();
    this.config = {
      autoCommitInterval: 30 * 60 * 1000, // 30 minutes
      maxWorkTimeWithoutCommit: 60 * 60 * 1000, // 1 hour
      enforceFeatureBranches: true,
      requireMeaningfulCommits: true,
      commitReminderEnabled: true,
      emergencyRecoveryEnabled: true,
      ...config
    };
  }

  /**
   * Start monitoring git discipline for an agent
   */
  startMonitoring(agent: AgentInstance, workingDirectory: string): void {
    const session: GitWorkSession = {
      agentId: agent.agent.id,
      startTime: new Date(),
      lastCommitTime: null,
      currentBranch: null,
      uncommittedChanges: false,
      workingDirectory
    };

    this.workSessions.set(agent.agent.id, session);
    
    if (this.config.commitReminderEnabled) {
      this.startCommitReminders(agent.agent.id);
    }

    this.emit('monitoringStarted', {
      agentId: agent.agent.id,
      workingDirectory,
      timestamp: new Date()
    });

    console.log(chalk.blue(`🔍 Git discipline monitoring started for ${agent.agent.name}`));
  }

  /**
   * Stop monitoring for an agent
   */
  stopMonitoring(agentId: string): void {
    // Clear timers
    const commitTimer = this.commitReminders.get(agentId);
    if (commitTimer) {
      clearInterval(commitTimer);
      this.commitReminders.delete(agentId);
    }

    const workTimer = this.workTimeWarnings.get(agentId);
    if (workTimer) {
      clearTimeout(workTimer);
      this.workTimeWarnings.delete(agentId);
    }

    this.workSessions.delete(agentId);
    
    this.emit('monitoringStopped', {
      agentId,
      timestamp: new Date()
    });
  }

  /**
   * Start automated commit reminders
   */
  private startCommitReminders(agentId: string): void {
    const reminder = setInterval(() => {
      this.sendCommitReminder(agentId);
    }, this.config.autoCommitInterval);

    this.commitReminders.set(agentId, reminder);

    // Also set up 1-hour warning
    const workWarning = setTimeout(() => {
      this.sendWorkTimeWarning(agentId);
    }, this.config.maxWorkTimeWithoutCommit);

    this.workTimeWarnings.set(agentId, workWarning);
  }

  /**
   * Send commit reminder to agent
   */
  private sendCommitReminder(agentId: string): void {
    const session = this.workSessions.get(agentId);
    if (!session) return;

    const timeSinceStart = Date.now() - session.startTime.getTime();
    const timeSinceCommit = session.lastCommitTime 
      ? Date.now() - session.lastCommitTime.getTime()
      : timeSinceStart;

    const reminderMessage = this.generateCommitReminderMessage(timeSinceCommit);

    this.emit('commitReminderRequired', {
      agentId,
      message: reminderMessage,
      timeSinceLastCommit: timeSinceCommit,
      timestamp: new Date()
    });

    console.log(chalk.yellow(`⏰ Commit reminder sent to agent ${agentId}`));
  }

  /**
   * Send work time warning (approaching 1 hour limit)
   */
  private sendWorkTimeWarning(agentId: string): void {
    const session = this.workSessions.get(agentId);
    if (!session || session.lastCommitTime) return;

    const warningMessage = `🚨 **CRITICAL GIT SAFETY WARNING** 🚨

You've been working for nearly 1 hour without committing changes. This violates our git discipline policy and risks losing work.

**IMMEDIATE ACTION REQUIRED:**
1. Save your current work
2. Run: git add -A
3. Run: git commit -m "WIP: [describe what you've been working on]"
4. Continue working with regular commits every 30 minutes

**Remember:** Never work >1 hour without committing. This ensures work is never lost due to crashes or errors.`;

    this.emit('workTimeWarningRequired', {
      agentId,
      message: warningMessage,
      workDuration: Date.now() - session.startTime.getTime(),
      timestamp: new Date()
    });

    console.log(chalk.red(`🚨 Work time warning sent to agent ${agentId}`));
  }

  /**
   * Generate context-appropriate commit reminder message
   */
  private generateCommitReminderMessage(timeSinceCommit: number): string {
    const minutes = Math.floor(timeSinceCommit / (1000 * 60));
    
    if (minutes >= 60) {
      return `🚨 **URGENT**: You haven't committed in ${Math.floor(minutes/60)}h ${minutes%60}m. This violates git safety policy!

**COMMIT NOW:**
\`\`\`bash
git add -A
git commit -m "Progress: [describe what you completed in the last hour]"
\`\`\`

**Never work >1 hour without committing to prevent work loss.**`;
    } else if (minutes >= 30) {
      return `⏰ **Git Discipline Reminder**: It's been ${minutes} minutes since your last commit.

**Time to commit your progress:**
\`\`\`bash
git add -A
git commit -m "Progress: [specific description of what was done]"
\`\`\``;
    }

    return `💡 **Proactive Commit Reminder**: Consider committing your current progress to maintain good git discipline.`;
  }

  /**
   * Validate commit message quality
   */
  validateCommitMessage(message: string): GitCommitQuality {
    const issues: string[] = [];
    const suggestions: string[] = [];
    let score = 1.0;

    // Check for bad patterns
    for (const pattern of this.BAD_COMMIT_PATTERNS) {
      if (pattern.test(message)) {
        issues.push(`Generic or vague commit message: "${message}"`);
        score -= 0.4;
        break;
      }
    }

    // Check length
    if (message.length < 10) {
      issues.push('Commit message too short (minimum 10 characters)');
      score -= 0.2;
    } else if (message.length > 72) {
      issues.push('Commit message too long (maximum 72 characters for summary)');
      score -= 0.1;
    }

    // Check capitalization
    if (message[0] && message[0] !== message[0].toUpperCase()) {
      issues.push('Commit message should start with capital letter');
      score -= 0.1;
    }

    // Check for ending period
    if (message.endsWith('.')) {
      issues.push('Commit message should not end with period');
      score -= 0.05;
    }

    // Generate suggestions if quality is poor
    if (score < 0.7) {
      suggestions.push(...this.generateCommitSuggestions(message));
    }

    const isMeaningful = score >= 0.6 && issues.length === 0;

    return {
      message,
      isMeaningful,
      score: Math.max(0, score),
      issues,
      suggestions
    };
  }

  /**
   * Generate commit message improvement suggestions
   */
  private generateCommitSuggestions(originalMessage: string): string[] {
    const suggestions = [
      'Be specific about what was changed, not just that something was changed',
      'Use imperative mood: "Add feature" not "Added feature"',
      'Include the "why" when the "what" isn\'t obvious',
      'Reference issue numbers when applicable'
    ];

    // Add specific examples
    suggestions.push('\n**Good examples:**');
    suggestions.push(...this.GOOD_COMMIT_EXAMPLES.slice(0, 3));

    return suggestions;
  }

  /**
   * Generate emergency recovery commands
   */
  generateEmergencyRecovery(): string[] {
    return [
      '# Git Emergency Recovery Commands',
      '',
      '# 1. Check recent commits',
      'git log --oneline -10',
      '',
      '# 2. Save any uncommitted changes',
      'git stash',
      '',
      '# 3. Return to last stable commit if needed',
      'git reset --hard HEAD',
      '',
      '# 4. Check stashed changes',
      'git stash list',
      '',
      '# 5. Restore stashed changes if needed',
      'git stash pop',
      '',
      '# 6. Create emergency backup branch',
      'git checkout -b emergency-backup-$(date +%Y%m%d-%H%M%S)',
      'git add -A',
      'git commit -m "Emergency backup: recover work in progress"'
    ];
  }

  /**
   * Check if agent should create feature branch for new work
   */
  shouldCreateFeatureBranch(agentId: string, taskDescription: string): boolean {
    if (!this.config.enforceFeatureBranches) return false;

    const session = this.workSessions.get(agentId);
    if (!session) return false;

    // Suggest feature branch for new features, major changes
    const featureKeywords = ['feature', 'implement', 'add', 'create', 'new'];
    const hasFeatureKeyword = featureKeywords.some(keyword => 
      taskDescription.toLowerCase().includes(keyword)
    );

    return hasFeatureKeyword;
  }

  /**
   * Generate feature branch creation instructions
   */
  generateFeatureBranchInstructions(taskDescription: string): string {
    const branchName = this.generateBranchName(taskDescription);
    
    return `🌿 **Feature Branch Required**

Before starting this task, create a feature branch:

\`\`\`bash
# Create and switch to feature branch
git checkout -b ${branchName}

# After completing the feature
git add -A
git commit -m "Complete: ${taskDescription}"
git tag stable-${branchName}-$(date +%Y%m%d-%H%M%S)
\`\`\``;
  }

  /**
   * Generate branch name from task description
   */
  private generateBranchName(taskDescription: string): string {
    return 'feature/' + taskDescription
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 40);
  }

  /**
   * Update agent's commit status
   */
  updateCommitStatus(agentId: string, committed: boolean, branchName?: string): void {
    const session = this.workSessions.get(agentId);
    if (!session) return;

    if (committed) {
      session.lastCommitTime = new Date();
      session.uncommittedChanges = false;
      
      // Reset work time warning
      const workTimer = this.workTimeWarnings.get(agentId);
      if (workTimer) {
        clearTimeout(workTimer);
        const newWarning = setTimeout(() => {
          this.sendWorkTimeWarning(agentId);
        }, this.config.maxWorkTimeWithoutCommit);
        this.workTimeWarnings.set(agentId, newWarning);
      }
    }

    if (branchName) {
      session.currentBranch = branchName;
    }

    this.emit('commitStatusUpdated', {
      agentId,
      committed,
      branchName,
      lastCommitTime: session.lastCommitTime,
      timestamp: new Date()
    });
  }

  /**
   * Get current git discipline status for an agent
   */
  getAgentStatus(agentId: string): GitWorkSession | null {
    return this.workSessions.get(agentId) || null;
  }

  /**
   * Get git discipline statistics
   */
  getStatistics(): {
    totalAgents: number;
    agentsWithRecentCommits: number;
    agentsAtRisk: number;
    averageTimeBetweenCommits: number;
  } {
    const sessions = Array.from(this.workSessions.values());
    const now = Date.now();
    
    const agentsWithRecentCommits = sessions.filter(session =>
      session.lastCommitTime && 
      (now - session.lastCommitTime.getTime()) < this.config.autoCommitInterval
    ).length;

    const agentsAtRisk = sessions.filter(session => {
      const timeSinceCommit = session.lastCommitTime
        ? now - session.lastCommitTime.getTime()
        : now - session.startTime.getTime();
      return timeSinceCommit > this.config.maxWorkTimeWithoutCommit;
    }).length;

    const commitTimes = sessions
      .filter(session => session.lastCommitTime)
      .map(session => now - session.startTime.getTime());
    
    const averageTimeBetweenCommits = commitTimes.length > 0
      ? commitTimes.reduce((sum, time) => sum + time, 0) / commitTimes.length
      : 0;

    return {
      totalAgents: sessions.length,
      agentsWithRecentCommits,
      agentsAtRisk,
      averageTimeBetweenCommits
    };
  }
}