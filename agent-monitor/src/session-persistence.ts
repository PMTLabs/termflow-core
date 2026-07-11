/**
 * Session Persistence Manager
 * 
 * Handles saving and loading agent session data for resuming after crashes/restarts
 */

import fs from 'fs';
import path from 'path';
import chalk from 'chalk';
import { AgentInstance, TeamConfiguration } from './team-types';

export interface SessionData {
  version: string;
  timestamp: Date;
  teamConfig: TeamConfiguration;
  sharedTabId?: string;
  chatHub: {
    channelId: number;
    agentId?: string;
    connected: boolean;
  };
  agents: SerializedAgent[];
  projectStatus: {
    pendingTasksReported: boolean;
    lastHeartbeat?: Date;
  };
}

export interface SerializedAgent {
  agentId: string;
  name: string;
  role: string;
  terminalId: string;
  processId: string;
  status: string;
  isConnectedToHub: boolean;
  tasksCompleted?: boolean;
  completionVerified?: boolean;
  lastActivity: Date;
}

export class SessionPersistence {
  private dataPath: string;
  private lockPath: string;

  constructor(projectFolder: string) {
    // Store session data in project folder
    const sessionDir = path.join(projectFolder, '.agent-monitor');
    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
    }
    
    this.dataPath = path.join(sessionDir, 'session-data.json');
    this.lockPath = path.join(sessionDir, 'session.lock');
  }

  /**
   * Save current session data
   */
  async saveSession(
    teamConfig: TeamConfiguration,
    agentInstances: Map<string, AgentInstance>,
    sharedTabId: string | undefined,
    chatHubInfo: { channelId: number; agentId?: string; connected: boolean },
    projectStatus: { pendingTasksReported: boolean; lastHeartbeat?: Date }
  ): Promise<void> {
    try {
      // Serialize agent instances
      const agents: SerializedAgent[] = [];
      for (const [agentId, instance] of agentInstances) {
        agents.push({
          agentId,
          name: instance.agent.name,
          role: instance.agent.role,
          terminalId: instance.terminalId,
          processId: instance.processId,
          status: instance.status,
          isConnectedToHub: instance.isConnectedToHub,
          tasksCompleted: instance.tasksCompleted,
          completionVerified: instance.completionVerified,
          lastActivity: instance.lastActivity
        });
      }

      const sessionData: SessionData = {
        version: '1.0.0',
        timestamp: new Date(),
        teamConfig,
        sharedTabId,
        chatHub: chatHubInfo,
        agents,
        projectStatus
      };

      // Write session data
      fs.writeFileSync(this.dataPath, JSON.stringify(sessionData, null, 2));
      
      // Create lock file to indicate active session
      fs.writeFileSync(this.lockPath, JSON.stringify({
        pid: process.pid,
        started: new Date(),
        lastUpdate: new Date()
      }));

      console.log(chalk.green(`💾 Session data saved to ${this.dataPath}`));
    } catch (error) {
      console.error(chalk.red(`❌ Failed to save session data: ${error}`));
      throw error;
    }
  }

  /**
   * Load existing session data
   */
  async loadSession(): Promise<SessionData | null> {
    try {
      if (!fs.existsSync(this.dataPath)) {
        console.log(chalk.yellow('⚠️ No previous session data found'));
        return null;
      }

      const data = fs.readFileSync(this.dataPath, 'utf-8');
      const sessionData = JSON.parse(data) as SessionData;
      
      // Convert date strings back to Date objects
      sessionData.timestamp = new Date(sessionData.timestamp);
      sessionData.agents.forEach(agent => {
        agent.lastActivity = new Date(agent.lastActivity);
      });
      if (sessionData.projectStatus.lastHeartbeat) {
        sessionData.projectStatus.lastHeartbeat = new Date(sessionData.projectStatus.lastHeartbeat);
      }

      console.log(chalk.green(`📂 Loaded session data from ${new Date(sessionData.timestamp).toLocaleString()}`));
      return sessionData;
    } catch (error) {
      console.error(chalk.red(`❌ Failed to load session data: ${error}`));
      return null;
    }
  }

  /**
   * Check if there's an active session lock
   */
  hasActiveSession(): boolean {
    if (!fs.existsSync(this.lockPath)) {
      return false;
    }

    try {
      const lockData = JSON.parse(fs.readFileSync(this.lockPath, 'utf-8'));
      const lockAge = Date.now() - new Date(lockData.lastUpdate).getTime();
      
      // Consider session stale if lock hasn't been updated in 5 minutes
      if (lockAge > 300000) {
        console.log(chalk.yellow('⚠️ Session lock is stale, removing...'));
        this.clearSession();
        return false;
      }

      // Check if process is still running (platform-specific)
      if (process.platform === 'win32') {
        try {
          // On Windows, this will throw if process doesn't exist
          process.kill(lockData.pid, 0);
          return true;
        } catch {
          console.log(chalk.yellow('⚠️ Previous session process not found, clearing lock...'));
          this.clearSession();
          return false;
        }
      } else {
        // On Unix-like systems
        try {
          process.kill(lockData.pid, 0);
          return true;
        } catch {
          console.log(chalk.yellow('⚠️ Previous session process not found, clearing lock...'));
          this.clearSession();
          return false;
        }
      }
    } catch (error) {
      console.error(chalk.red(`❌ Error checking session lock: ${error}`));
      return false;
    }
  }

  /**
   * Update lock file to indicate session is still active
   */
  async updateLock(): Promise<void> {
    if (fs.existsSync(this.lockPath)) {
      const lockData = JSON.parse(fs.readFileSync(this.lockPath, 'utf-8'));
      lockData.lastUpdate = new Date();
      fs.writeFileSync(this.lockPath, JSON.stringify(lockData));
    }
  }

  /**
   * Clear session data and lock
   */
  clearSession(): void {
    try {
      if (fs.existsSync(this.dataPath)) {
        fs.unlinkSync(this.dataPath);
      }
      if (fs.existsSync(this.lockPath)) {
        fs.unlinkSync(this.lockPath);
      }
      console.log(chalk.blue('🧹 Session data cleared'));
    } catch (error) {
      console.error(chalk.red(`❌ Error clearing session: ${error}`));
    }
  }

  /**
   * Get session summary for display
   */
  getSessionSummary(sessionData: SessionData): string {
    const agentCount = sessionData.agents.length;
    const connectedCount = sessionData.agents.filter(a => a.isConnectedToHub).length;
    const completedCount = sessionData.agents.filter(a => a.completionVerified).length;
    const age = Math.round((Date.now() - new Date(sessionData.timestamp).getTime()) / 60000);

    return `
📊 Previous Session Summary:
  • Project: ${sessionData.teamConfig.teamConfig.projectName}
  • Started: ${new Date(sessionData.timestamp).toLocaleString()} (${age} minutes ago)
  • Agents: ${agentCount} total, ${connectedCount} connected to ChatHub
  • Status: ${completedCount} agents completed tasks
  • Tab ID: ${sessionData.sharedTabId || 'Not saved'}
  • Channel: ${sessionData.chatHub.channelId}`;
  }
}