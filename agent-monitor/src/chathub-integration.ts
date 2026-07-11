/**
 * ChatHub SignalR Integration for Team Monitoring
 * 
 * This module provides SignalR integration with ChatHub for monitoring agent collaboration.
 * Updated to use proper SignalR connection instead of WebSocket.
 */

// Disable SSL certificate validation for development
process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";

import { EventEmitter } from 'events';
import chalk from 'chalk';
import * as signalR from '@microsoft/signalr';
import { ChatHubApiClient, AgentRegistrationRequest, ChatHubMessage, ChatHubMention } from './chathub-api-client';
import { AgentRole } from './team-types';

export interface ChatHubAgent {
  id: string;
  name: string;
  role: AgentRole;
  aiType: string;
  status: 'Online' | 'Active' | 'Busy' | 'Away' | 'Offline';
}

// Re-export interfaces for backward compatibility
export { ChatHubMessage, ChatHubMention };

export class ChatHubIntegration extends EventEmitter {
  private connection: signalR.HubConnection | null = null;
  private apiClient: ChatHubApiClient;
  private connected: boolean = false;
  private currentChannel: number | null = null;
  private agentId: string | null = null;
  private agentData: ChatHubAgent | null = null;
  private agents: Map<string, ChatHubAgent> = new Map();
  private hubUrl: string;
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor(baseUrl: string) {
    super();
    if (baseUrl.trim() === '') {
      throw new Error('Base ChatHub URL must be provided');
    }
    
    // Handle both HTTP and WebSocket URLs
    if (baseUrl.startsWith('ws://') || baseUrl.startsWith('wss://')) {
      // Convert WebSocket URL to HTTP URL for both API client and SignalR hub
      const httpUrl = baseUrl.replace('wss://', 'https://').replace('ws://', 'http://').replace('/chathub', '');
      this.hubUrl = `${httpUrl}/chathub`; // SignalR uses HTTPS, not WSS
      this.apiClient = new ChatHubApiClient(httpUrl);
    } else {
      // Standard HTTP URL
      this.hubUrl = `${baseUrl}/chathub`;
      this.apiClient = new ChatHubApiClient(baseUrl);
    }
  }

  /**
   * Connect to ChatHub via SignalR with proper agent registration
   */
  async connect(agentData?: {
    name?: string;
    role?: string;
    description?: string;
  }): Promise<void> {
    try {
      console.log(chalk.yellow(`🔗 Connecting to ChatHub at ${this.hubUrl}...`));
      
      // Step 1: Test API connection first
      const isApiHealthy = await this.apiClient.testConnection();
      if (!isApiHealthy) {
        throw new Error('ChatHub API is not available');
      }

      // Step 2: Register agent via REST API
      const registrationData: AgentRegistrationRequest = {
        name: agentData?.name || 'Agent_Monitor',
        role: agentData?.role || 'Agent Monitor',
        description: agentData?.description || 'Multi-agent orchestration monitor',
        metadata: JSON.stringify({
          aiType: 'Claude',
          version: '2.0.0',
          capabilities: ['monitoring', 'orchestration', 'team-coordination']
        })
      };

      const registration = await this.apiClient.registerAgent(registrationData);
      this.agentId = registration.id;
      
      this.agentData = {
        id: registration.id,
        name: registration.name,
        role: registration.role as AgentRole,
        aiType: 'Claude',
        status: 'Online'
      };

      console.log(chalk.green(`🤖 Agent registered: ${registration.name} (${registration.id})`));

      // Step 3: Create SignalR connection
      this.connection = new signalR.HubConnectionBuilder()
        .withUrl(this.hubUrl)
        .withAutomaticReconnect({
          nextRetryDelayInMilliseconds: (retryContext: any) => {
            return Math.min(1000 * Math.pow(2, retryContext.previousRetryCount), 30000);
          }
        })
        .configureLogging(signalR.LogLevel.Information)
        .build();

      // Step 4: Setup event handlers
      this.setupSignalREventHandlers();

      // Step 5: Start SignalR connection
      await this.connection.start();
      this.connected = true;

      // Step 6: Register with SignalR Hub
      await this.connection.invoke('RegisterAgent', this.agentId);
      
      // Step 7: Update agent status to Active
      await this.apiClient.updateAgentStatus(this.agentId, 'Active');

      // Step 8: Start heartbeat monitoring
      this.startHeartbeat();

      console.log(chalk.green('✅ Connected to ChatHub SignalR Hub'));
      this.emit('connected');

    } catch (error) {
      console.error(chalk.red(`❌ Failed to connect to ChatHub: ${error}`));
      this.connected = false;
      throw error;
    }
  }

  /**
   * Setup SignalR event handlers
   */
  private setupSignalREventHandlers(): void {
    if (!this.connection) return;

    // Handle incoming messages
    this.connection.on('NewMessage', (message: any) => {
      this.handleChatHubMessage(message);
    });

    this.connection.on('ReceiveMessage', (message: any) => {
      this.handleChatHubMessage(message);
    });

    // Handle agent status updates
    this.connection.on('AgentStatusUpdate', (data: any) => {
      this.handleAgentStatusUpdate(data);
    });

    // Handle agent connections
    this.connection.on('AgentConnected', (agentData: any) => {
      console.log(chalk.blue(`🔗 Agent connected: ${agentData.agentName || agentData.name}`));
      this.emit('agentConnected', agentData);
    });

    this.connection.on('AgentDisconnected', (agentData: any) => {
      console.log(chalk.yellow(`🔌 Agent disconnected: ${agentData.agentName || agentData.name}`));
      this.emit('agentDisconnected', agentData);
    });

    // Handle mentions
    this.connection.on('Mentioned', (message: any) => {
      console.log(chalk.cyan(`👋 Agent Monitor mentioned in message: ${message.content.substring(0, 50)}...`));
      this.emit('mentioned', message);
    });

    // Handle typing indicators
    this.connection.on('TypingIndicator', (data: any) => {
      this.emit('typingIndicator', data);
    });

    // Handle errors
    this.connection.on('Error', (error: string) => {
      console.error(chalk.red(`❌ SignalR Hub Error: ${error}`));
      this.emit('error', error);
    });

    // Handle connection events
    this.connection.onreconnecting((error: any) => {
      console.log(chalk.yellow(`🔄 SignalR reconnecting: ${error}`));
      this.connected = false;
    });

    this.connection.onreconnected((connectionId: any) => {
      console.log(chalk.green(`✅ SignalR reconnected: ${connectionId}`));
      this.connected = true;
      this.emit('reconnected');
    });

    this.connection.onclose((error: any) => {
      console.log(chalk.red(`🔌 SignalR connection closed: ${error}`));
      this.connected = false;
      this.stopHeartbeat();
      this.emit('disconnected');
    });
  }

  /**
   * Join a specific channel for monitoring
   */
  async joinChannel(channelId: number): Promise<void> {
    if (!this.connected || !this.connection || !this.agentId) {
      throw new Error('Not connected to ChatHub');
    }

    try {
      await this.connection.invoke('JoinChannel', channelId);
      this.currentChannel = channelId;
      
      console.log(chalk.blue(`📡 Joined ChatHub channel ${channelId}`));
      this.emit('channelJoined', channelId);
    } catch (error) {
      throw new Error(`Failed to join channel ${channelId}: ${error}`);
    }
  }

  /**
   * Leave a channel
   */
  async leaveChannel(channelId: number): Promise<void> {
    if (!this.connected || !this.connection) {
      throw new Error('Not connected to ChatHub');
    }

    try {
      await this.connection.invoke('LeaveChannel', channelId);
      if (this.currentChannel === channelId) {
        this.currentChannel = null;
      }
      
      console.log(chalk.gray(`🚪 Left ChatHub channel ${channelId}`));
      this.emit('channelLeft', channelId);
    } catch (error) {
      throw new Error(`Failed to leave channel ${channelId}: ${error}`);
    }
  }

  /**
   * Send monitor message to ChatHub
   */
  async sendMonitorMessage(content: string): Promise<void> {
    if (!this.connected || !this.connection || !this.currentChannel || !this.agentId) {
      console.warn(chalk.yellow('⚠️ Cannot send monitor message: not connected or no channel'));
      return;
    }

    try {
      await this.connection.invoke('SendMessage', {
        channelId: this.currentChannel,
        content: content,
        senderId: this.agentId
      });
      
      console.log(chalk.gray(`📤 Monitor message sent: ${content.substring(0, 50)}${content.length > 50 ? '...' : ''}`));
    } catch (error) {
      console.error(chalk.red(`❌ Failed to send monitor message: ${error}`));
      throw error;
    }
  }

  /**
   * Handle ChatHub messages (both NewMessage and ReceiveMessage events)
   */
  private handleChatHubMessage(data: any): void {
    try {
      const message: ChatHubMessage = {
        id: data.Id || data.id,
        projectId: data.ProjectId || data.projectId,
        channelId: data.ChannelId || data.channelId,
        phaseId: data.PhaseId || data.phaseId,
        parentMessageId: data.ParentMessageId || data.parentMessageId,
        rootMessageId: data.RootMessageId || data.rootMessageId,
        threadDepth: data.ThreadDepth || data.threadDepth || 0,
        content: data.Content || data.content,
        senderId: data.SenderId || data.senderId,
        senderName: data.SenderName || data.senderName,
        senderRole: data.SenderRole || data.senderRole,
        sentAt: new Date(data.SentAt || data.sentAt),
        editedAt: data.EditedAt || data.editedAt ? new Date(data.EditedAt || data.editedAt) : undefined,
        isDeleted: data.IsDeleted || data.isDeleted || false,
        mentions: (data.Mentions || data.mentions || []).map((mention: any) => ({
          mentionedAgentId: mention.MentionedAgentId || mention.mentionedAgentId,
          mentionType: mention.MentionType || mention.mentionType || 'Agent',
          positionStart: mention.PositionStart || mention.positionStart,
          positionEnd: mention.PositionEnd || mention.positionEnd
        }))
      };

      // Log message for debugging
      if (message.senderRole !== 'Agent Monitor') { // Don't log our own messages
        console.log(chalk.blue(`💬 ${message.senderRole}: ${message.content.substring(0, 100)}${message.content.length > 100 ? '...' : ''}`));
      }

      // Check for pending tasks from Project Coordinator
      if (message.senderRole === 'Project Coordinator' && 
          message.content && message.content.includes('PENDING TASKS:')) {
        
        const tasks = this.extractTasksFromMessage(message.content);
        console.log(chalk.yellow(`📋 Detected ${tasks.length} pending tasks from Project Coordinator`));
        this.emit('pendingTasks', { message, tasks });
      }

      // Check for System Architect task assignments
      if (message.senderRole === 'System Architect' && 
          message.content && (message.content.includes('@') || message.mentions.length > 0)) {
        
        console.log(chalk.cyan(`🎯 Task assignment detected from System Architect`));
        this.emit('taskAssignment', { message, mentions: message.mentions });
      }

      // Check for agent status updates
      if (message.content.includes('connected to ChatHub') || 
          message.content.includes('joined channel')) {
        
        this.emit('agentStatusUpdate', {
          agentId: message.senderId,
          agentName: message.senderName,
          role: message.senderRole,
          status: 'Online'
        });
      }

      // Check for completion reports
      if (message.content.includes('TASK COMPLETED') || 
          message.content.includes('✅') ||
          message.content.includes('completed') ||
          message.content.includes('finished')) {
        
        console.log(chalk.green(`✅ Task completion reported by ${message.senderName}`));
        this.emit('taskCompletion', { message, agentId: message.senderId });
      }

      // Check for help requests or escalations
      if (message.content.toLowerCase().includes('need help') || 
          message.content.toLowerCase().includes('blocked') ||
          message.content.toLowerCase().includes('stuck') ||
          message.content.includes('ESCALATE')) {
        
        console.log(chalk.red(`🚨 Help request or blocker from ${message.senderName}`));
        this.emit('escalationRequest', { message, severity: 'medium' });
      }

      this.emit('newMessage', message);
    } catch (error) {
      console.error(chalk.red(`❌ Error processing ChatHub message: ${error}`));
    }
  }

  /**
   * Handle agent status updates
   */
  private handleAgentStatusUpdate(data: any): void {
    const agent: ChatHubAgent = {
      id: data.agentId,
      name: data.agentName || 'Unknown',
      role: data.role || 'Unknown',
      aiType: data.aiType || 'Unknown',
      status: data.status || 'Offline'
    };

    this.agents.set(data.agentId, agent);
    console.log(chalk.gray(`👤 ${agent.name} status: ${agent.status}`));
    this.emit('agentStatusUpdate', agent);
  }

  /**
   * Extract tasks from Project Coordinator message
   */
  private extractTasksFromMessage(content: string): string[] {
    const tasks: string[] = [];
    
    // Look for "PENDING TASKS:" followed by task descriptions
    const pendingIndex = content.indexOf('PENDING TASKS:');
    if (pendingIndex !== -1) {
      const tasksSection = content.substring(pendingIndex + 'PENDING TASKS:'.length);
      const lines = tasksSection.split('\n');
      
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && (trimmed.startsWith('-') || trimmed.startsWith('•') || trimmed.startsWith('*'))) {
          tasks.push(trimmed.substring(1).trim());
        }
      }
    }
    
    return tasks;
  }

  /**
   * Get recent messages from current channel
   */
  async getRecentMessages(limit: number = 20): Promise<ChatHubMessage[]> {
    if (!this.currentChannel) {
      throw new Error('Not connected to any channel');
    }
    
    try {
      const messages = await this.apiClient.getChannelMessages(this.currentChannel, { limit });
      return messages;
    } catch (error) {
      console.error(chalk.red(`Failed to get recent messages: ${error}`));
      return [];
    }
  }

  /**
   * Start heartbeat monitoring
   */
  private startHeartbeat(): void {
    if (this.agentId && !this.heartbeatInterval) {
      this.heartbeatInterval = setInterval(async () => {
        try {
          if (this.agentId && this.connected) {
            await this.apiClient.sendHeartbeat(this.agentId);
            
            // Also update heartbeat via SignalR Hub
            if (this.connection) {
              await this.connection.invoke('UpdateHeartbeat');
            }
          }
        } catch (error) {
          console.error(chalk.red(`💔 Heartbeat failed: ${error}`));
        }
      }, 30000); // Every 30 seconds

      console.log(chalk.blue('💓 Heartbeat monitoring started'));
    }
  }

  /**
   * Stop heartbeat monitoring
   */
  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
      console.log(chalk.gray('💔 Heartbeat monitoring stopped'));
    }
  }

  /**
   * Update agent status
   */
  async updateAgentStatus(status: 'Online' | 'Active' | 'Busy' | 'Away' | 'Offline'): Promise<void> {
    if (!this.agentId || !this.connected) {
      throw new Error('Not connected to ChatHub');
    }

    try {
      // Update via REST API
      await this.apiClient.updateAgentStatus(this.agentId, status);
      
      // Update via SignalR Hub
      if (this.connection) {
        await this.connection.invoke('UpdateAgentStatus', this.agentId, status);
      }

      if (this.agentData) {
        this.agentData.status = status;
      }

      console.log(chalk.blue(`📊 Agent status updated to: ${status}`));
    } catch (error) {
      console.error(chalk.red(`❌ Failed to update agent status: ${error}`));
      throw error;
    }
  }

  /**
   * Get channel messages with filtering
   */
  async getChannelMessages(channelId: number, filter?: any): Promise<ChatHubMessage[]> {
    try {
      return await this.apiClient.getChannelMessages(channelId, filter);
    } catch (error) {
      console.error(chalk.red(`❌ Failed to get channel messages: ${error}`));
      return [];
    }
  }

  /**
   * Get connection status
   */
  get isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get current agent ID
   */
  getAgentId(): string | undefined {
    return this.agentId || undefined;
  }

  /**
   * Get current channel
   */
  get currentChannelId(): number | null {
    return this.currentChannel;
  }

  /**
   * Get current agent data
   */
  get currentAgent(): ChatHubAgent | null {
    return this.agentData;
  }

  /**
   * Get connected agents
   */
  getConnectedAgents(): ChatHubAgent[] {
    return Array.from(this.agents.values());
  }

  /**
   * Disconnect from ChatHub
   */
  async disconnect(): Promise<void> {
    try {
      this.stopHeartbeat();

      if (this.connection && this.connected) {
        // Update status to offline
        if (this.agentId) {
          await this.apiClient.updateAgentStatus(this.agentId, 'Offline');
        }
        
        await this.connection.stop();
        this.connection = null;
      }
      
      this.connected = false;
      this.currentChannel = null;
      this.agents.clear();
      this.agentData = null;
      this.agentId = null;
      
      console.log(chalk.gray('🔌 Disconnected from ChatHub'));
      this.emit('disconnected');
    } catch (error) {
      console.error(chalk.red(`❌ Error during disconnect: ${error}`));
    }
  }
}