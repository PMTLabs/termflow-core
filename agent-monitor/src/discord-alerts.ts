/**
 * Discord Alerting System for Team Escalations
 * 
 * This module handles sending alerts to Discord when the AI development team
 * encounters issues that require human intervention.
 */

import chalk from 'chalk';
import { EscalationAlert, TeamConfiguration } from './team-types';

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  fields: DiscordField[];
  timestamp: string;
  footer?: {
    text: string;
    icon_url?: string;
  };
  thumbnail?: {
    url: string;
  };
}

export interface DiscordField {
  name: string;
  value: string;
  inline: boolean;
}

export interface DiscordMessage {
  content?: string;
  embeds: DiscordEmbed[];
}

export class DiscordAlerter {
  private webhookUrl: string;
  private teamConfig: TeamConfiguration;
  private alertHistory: Map<string, Date> = new Map();
  private rateLimitWindow: number = 300000; // 5 minutes
  private maxAlertsPerWindow: number = 10;

  constructor(webhookUrl: string, teamConfig: TeamConfiguration) {
    this.webhookUrl = webhookUrl;
    this.teamConfig = teamConfig;
  }

  /**
   * Send an escalation alert to Discord
   */
  async sendEscalationAlert(alert: EscalationAlert, agentInstances?: Map<string, any>): Promise<boolean> {
    try {
      // Check rate limiting
      if (!this.checkRateLimit(alert)) {
        console.log(chalk.yellow(`⏱️  Rate limited - skipping alert: ${alert.title}`));
        return false;
      }

      const embed = this.createEscalationEmbed(alert, agentInstances);
      const message: DiscordMessage = {
        content: this.getMentionString(alert),
        embeds: [embed]
      };

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      if (response.ok) {
        console.log(chalk.green(`📢 Discord alert sent: ${alert.title}`));
        this.recordAlert(alert);
        return true;
      } else {
        const errorText = await response.text();
        console.error(chalk.red(`❌ Discord webhook failed (${response.status}): ${errorText}`));
        return false;
      }

    } catch (error) {
      console.error(chalk.red(`❌ Discord alert error: ${error}`));
      return false;
    }
  }

  /**
   * Send team status update to Discord
   */
  async sendStatusUpdate(status: {
    activeAgents: number;
    totalAgents: number;
    completedTasks: number;
    totalTasks: number;
    blockedTasks: number;
    criticalIssues: number;
  }): Promise<boolean> {
    try {
      const embed: DiscordEmbed = {
        title: '📊 Team Status Update',
        description: `Project: **${this.teamConfig.teamConfig.projectName}**`,
        color: this.getStatusColor(status),
        fields: [
          {
            name: '👥 Agent Status',
            value: `${status.activeAgents}/${status.totalAgents} agents active`,
            inline: true
          },
          {
            name: '📋 Task Progress', 
            value: `${status.completedTasks}/${status.totalTasks} tasks completed`,
            inline: true
          },
          {
            name: '🚫 Blocked Tasks',
            value: status.blockedTasks.toString(),
            inline: true
          },
          {
            name: '🚨 Critical Issues',
            value: status.criticalIssues.toString(),
            inline: true
          },
          {
            name: '📁 Project Folder',
            value: `\`${this.teamConfig.teamConfig.projectFolder}\``,
            inline: false
          },
          {
            name: '🔧 Agent Monitor PID',
            value: `${process.pid}`,
            inline: true
          }
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Auto-Terminal Team Orchestrator'
        }
      };

      const message: DiscordMessage = {
        embeds: [embed]
      };

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      if (response.ok) {
        console.log(chalk.green('📢 Status update sent to Discord'));
        return true;
      } else {
        console.error(chalk.red(`❌ Status update failed: ${response.statusText}`));
        return false;
      }

    } catch (error) {
      console.error(chalk.red(`❌ Status update error: ${error}`));
      return false;
    }
  }

  /**
   * Send team initialization notification
   */
  async sendTeamStartNotification(agentInstances?: Map<string, any>, isResume: boolean = false): Promise<boolean> {
    try {
      const embed: DiscordEmbed = {
        title: isResume ? '🔄 Development Team Resumed' : '🚀 Development Team Started',
        description: isResume 
          ? `Multi-agent team for **${this.teamConfig.teamConfig.projectName}** has been resumed from saved session!`
          : `Multi-agent development team for **${this.teamConfig.teamConfig.projectName}** is now operational!`,
        color: isResume ? 0x3498DB : 0x00FF00, // Blue for resume, Green for start
        fields: [
          {
            name: '👥 Team Size',
            value: `${this.teamConfig.agents.length} agents`,
            inline: true
          },
          {
            name: '📡 ChatHub Channel',
            value: this.teamConfig.teamConfig.chatHubChannel.toString(),
            inline: true
          },
          {
            name: '📁 Project Folder',
            value: `\`${this.teamConfig.teamConfig.projectFolder}\``,
            inline: false
          },
          {
            name: '🔧 Agent Monitor PID',
            value: `${process.pid}`,
            inline: true
          }
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Team orchestration initialized'
        }
      };

      // Add team roster with process IDs if available
      const teamRoster = this.teamConfig.agents.map(agent => {
        const instance = agentInstances?.get(agent.id);
        const pidInfo = instance?.processId ? ` | PID: ${instance.processId}` : '';
        return `• **${agent.name}** - ${agent.role} (${agent.aiType}/${agent.model})${pidInfo}`;
      }).join('\\n');

      embed.fields.push({
        name: '🤖 Team Roster',
        value: teamRoster,
        inline: false
      });

      const message: DiscordMessage = {
        content: '🎭 **Multi-Agent Development Team is now online!**',
        embeds: [embed]
      };

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      if (response.ok) {
        console.log(chalk.green('📢 Team start notification sent to Discord'));
        return true;
      } else {
        console.error(chalk.red(`❌ Team start notification failed: ${response.statusText}`));
        return false;
      }

    } catch (error) {
      console.error(chalk.red(`❌ Team start notification error: ${error}`));
      return false;
    }
  }

  /**
   * Send completion notification when all tasks are done
   */
  async sendCompletionNotification(summary: string): Promise<boolean> {
    try {
      const embed: DiscordEmbed = {
        title: '🎉 Project Completed!',
        description: `All tasks for **${this.teamConfig.teamConfig.projectName}** have been completed successfully!`,
        color: 0xFFD700, // Gold
        fields: [
          {
            name: '📋 Summary',
            value: summary,
            inline: false
          },
          {
            name: '👥 Team Performance',
            value: `${this.teamConfig.agents.length} agents collaborated successfully`,
            inline: true
          },
          {
            name: '✅ Quality Assurance',
            value: 'All test cases passed',
            inline: true
          },
          {
            name: '🔧 Agent Monitor PID',
            value: `${process.pid}`,
            inline: true
          }
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Team orchestration completed'
        }
      };

      const message: DiscordMessage = {
        content: '🎊 **Project completion achieved!** All objectives met.',
        embeds: [embed]
      };

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      if (response.ok) {
        console.log(chalk.green('📢 Completion notification sent to Discord'));
        return true;
      } else {
        console.error(chalk.red(`❌ Completion notification failed: ${response.statusText}`));
        return false;
      }

    } catch (error) {
      console.error(chalk.red(`❌ Completion notification error: ${error}`));
      return false;
    }
  }

  /**
   * Create Discord embed for escalation alert
   */
  private createEscalationEmbed(alert: EscalationAlert, agentInstances?: Map<string, any>): DiscordEmbed {
    const embed: DiscordEmbed = {
      title: `${this.getSeverityEmoji(alert.severity)} ${alert.title}`,
      description: alert.description,
      color: this.getSeverityColor(alert.severity),
      fields: [
        {
          name: '📋 Project',
          value: this.teamConfig.teamConfig.projectName,
          inline: true
        },
        {
          name: '🚨 Severity',
          value: alert.severity.toUpperCase(),
          inline: true
        },
        {
          name: '👤 Reported By',
          value: alert.reportedBy,
          inline: true
        }
      ],
      timestamp: alert.timestamp.toISOString(),
      footer: {
        text: `Alert ID: ${alert.id}`
      }
    };

    // Add affected agents if any
    if (alert.affectedAgents.length > 0) {
      const affectedAgentNames = alert.affectedAgents.map(agentId => {
        const agent = this.teamConfig.agents.find(a => a.id === agentId);
        const instance = agentInstances?.get(agentId);
        const pidInfo = instance?.processId ? ` | PID: ${instance.processId}` : '';
        return agent ? `${agent.name} (${agent.role})${pidInfo}` : agentId;
      }).join('\\n');

      embed.fields.push({
        name: '🤖 Affected Agents',
        value: affectedAgentNames,
        inline: false
      });
    }

    // Add suggested action
    embed.fields.push({
      name: '💡 Suggested Action',
      value: alert.suggestedAction,
      inline: false
    });

    // Add ChatHub link
    embed.fields.push({
      name: '🔗 ChatHub Channel',
      value: `Channel ${this.teamConfig.teamConfig.chatHubChannel}`,
      inline: true
    });

    // Add Agent Monitor process ID
    embed.fields.push({
      name: '🔧 Agent Monitor PID',
      value: `${process.pid}`,
      inline: true
    });

    return embed;
  }

  /**
   * Get Discord color for severity level
   */
  private getSeverityColor(severity: string): number {
    const colors = {
      low: 0x95A5A6,      // Gray
      medium: 0xF39C12,   // Orange
      high: 0xE74C3C,     // Red
      critical: 0x8E44AD  // Purple
    };
    return colors[severity as keyof typeof colors] || colors.medium;
  }

  /**
   * Get emoji for severity level
   */
  private getSeverityEmoji(severity: string): string {
    const emojis = {
      low: '💬',
      medium: '⚠️',
      high: '🚨',
      critical: '🆘'
    };
    return emojis[severity as keyof typeof emojis] || '⚠️';
  }

  /**
   * Get color for status update based on health
   */
  private getStatusColor(status: any): number {
    if (status.criticalIssues > 0) return 0xE74C3C; // Red
    if (status.blockedTasks > 0) return 0xF39C12; // Orange
    if (status.activeAgents < status.totalAgents * 0.8) return 0xF1C40F; // Yellow
    return 0x2ECC71; // Green
  }

  /**
   * Get mention string for high-priority alerts
   */
  private getMentionString(alert: EscalationAlert): string | undefined {
    if (alert.severity === 'critical') {
      return '@here **CRITICAL ALERT** - Immediate attention required!';
    }
    if (alert.severity === 'high') {
      return '**HIGH PRIORITY** - Please review when available.';
    }
    return undefined;
  }

  /**
   * Check rate limiting to prevent spam
   */
  private checkRateLimit(alert: EscalationAlert): boolean {
    const now = new Date();
    const windowStart = new Date(now.getTime() - this.rateLimitWindow);
    
    // Clean old alerts
    for (const [alertId, timestamp] of this.alertHistory) {
      if (timestamp < windowStart) {
        this.alertHistory.delete(alertId);
      }
    }

    // Check if we're over the limit
    if (this.alertHistory.size >= this.maxAlertsPerWindow) {
      return false;
    }

    // For critical alerts, always allow
    if (alert.severity === 'critical') {
      return true;
    }

    return true;
  }

  /**
   * Record alert for rate limiting
   */
  private recordAlert(alert: EscalationAlert): void {
    this.alertHistory.set(alert.id, new Date());
  }

  /**
   * Test webhook connection
   */
  async testWebhook(): Promise<boolean> {
    try {
      const testEmbed: DiscordEmbed = {
        title: '🧪 Webhook Test',
        description: 'Auto-Terminal team orchestrator webhook test',
        color: 0x3498DB, // Blue
        fields: [
          {
            name: '✅ Status',
            value: 'Webhook is working correctly',
            inline: false
          },
          {
            name: '🔧 Agent Monitor PID',
            value: `${process.pid}`,
            inline: true
          }
        ],
        timestamp: new Date().toISOString(),
        footer: {
          text: 'Test message'
        }
      };

      const message: DiscordMessage = {
        embeds: [testEmbed]
      };

      const response = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(message)
      });

      if (response.ok) {
        console.log(chalk.green('✅ Discord webhook test successful'));
        return true;
      } else {
        console.error(chalk.red(`❌ Webhook test failed: ${response.statusText}`));
        return false;
      }

    } catch (error) {
      console.error(chalk.red(`❌ Webhook test error: ${error}`));
      return false;
    }
  }

  /**
   * Get webhook status
   */
  get isConfigured(): boolean {
    return !!(this.webhookUrl && this.webhookUrl.length > 0);
  }
}