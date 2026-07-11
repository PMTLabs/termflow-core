/**
 * ChatHub REST API Client for agent registration and management
 */

import axios, { AxiosInstance } from 'axios';
import https from 'https';
import chalk from 'chalk';

export interface AgentRegistrationRequest {
  name: string;
  role: string;
  description?: string;
  metadata?: string;
}

export interface AgentRegistrationResponse {
  id: string;
  name: string;
  role: string;
  status: string;
  description?: string;
  metadata?: string;
}

export interface MessageFilterRequest {
  limit?: number;
  excludeWords?: string[];
  includeWords?: string[];
  excludeRegex?: string[];
  includeRegex?: string[];
  fullFilter?: boolean;
  excludeSenders?: string[];
  sentFrom?: string;
  fromDate?: string;
  toDate?: string;
}

export interface ChatHubMessage {
  id: number;
  projectId?: number;
  channelId?: number;
  phaseId?: number;
  parentMessageId?: number;
  rootMessageId?: number;
  threadDepth: number;
  content: string;
  senderId: string;
  senderName: string;
  senderRole: string;
  sentAt: Date;
  editedAt?: Date;
  isDeleted: boolean;
  mentions: ChatHubMention[];
}

export interface ChatHubMention {
  mentionedAgentId: string;
  mentionType: string;
  positionStart?: number;
  positionEnd?: number;
}

export class ChatHubApiClient {
  private axios: AxiosInstance;

  constructor(baseUrl: string = 'https://localhost:5001') {
    
    // Create axios instance with SSL certificate handling for development
    this.axios = axios.create({
      baseURL: baseUrl,
      headers: {
        'Content-Type': 'application/json',
      },
      httpsAgent: new https.Agent({
        rejectUnauthorized: false // Allow self-signed certificates in development
      }),
      timeout: 30000
    });

    // Add request/response interceptors for logging
    this.axios.interceptors.request.use((config) => {
      console.log(chalk.gray(`📡 ChatHub API: ${config.method?.toUpperCase()} ${config.url}`));
      return config;
    });

    this.axios.interceptors.response.use(
      (response) => {
        console.log(chalk.green(`✅ ChatHub API: ${response.status} ${response.config.method?.toUpperCase()} ${response.config.url}`));
        return response;
      },
      (error) => {
        console.error(chalk.red(`❌ ChatHub API Error: ${error.response?.status} ${error.config?.method?.toUpperCase()} ${error.config?.url}`));
        console.error(chalk.red(`   ${error.response?.data?.message || error.message}`));
        throw error;
      }
    );
  }

  /**
   * Check ChatHub API health
   */
  async checkHealth(): Promise<{ status: string; timestamp: string }> {
    try {
      const response = await this.axios.get('/api/Health');
      return response.data;
    } catch (error) {
      throw new Error(`Health check failed: ${error}`);
    }
  }

  /**
   * Register a new agent with ChatHub (checks for existing agent first)
   */
  async registerAgent(agentData: AgentRegistrationRequest): Promise<AgentRegistrationResponse> {
    // First, try to get existing agent to avoid 409 errors
    try {
      console.log(chalk.blue(`🔍 Checking if agent '${agentData.name}' already exists...`));
      const existingAgent = await this.getExistingAgent(agentData.name);
      console.log(chalk.green(`✅ Found existing agent: ${existingAgent.name} (${existingAgent.id})`));
      return existingAgent;
    } catch (error: any) {
      // Agent doesn't exist, proceed with registration
      if (error.message.includes('not found') || error.response?.status === 404) {
        console.log(chalk.blue(`🆕 Agent '${agentData.name}' not found, creating new agent...`));
      } else {
        console.warn(chalk.yellow(`⚠️ Error checking existing agent: ${error.message}`));
      }
    }

    // Try to register new agent
    try {
      const response = await this.axios.post('/api/Agent/register', agentData);
      console.log(chalk.green(`🤖 Agent registered: ${response.data.name} (${response.data.id})`));
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 409) {
        // Agent was created between our check and registration attempt
        console.log(chalk.yellow(`⚠️ Agent ${agentData.name} already exists (race condition), retrieving...`));
        try {
          return await this.getExistingAgent(agentData.name);
        } catch (getError: any) {
          throw new Error(`Agent exists but cannot retrieve: ${getError.message}`);
        }
      }
      throw new Error(`Failed to register agent: ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Get existing agent by name
   */
  async getExistingAgent(name: string): Promise<AgentRegistrationResponse> {
    try {
      const response = await this.axios.get(`/api/Agent/name/${encodeURIComponent(name)}`);
      const existingAgent = response.data;
      
      if (existingAgent && existingAgent.id) {
        console.log(chalk.blue(`🔄 Found existing agent: ${existingAgent.name} (${existingAgent.id})`));
        return existingAgent;
      } else {
        throw new Error(`Agent ${name} data is invalid or incomplete`);
      }
    } catch (error: any) {
      if (error.response?.status === 404) {
        throw new Error(`Agent ${name} not found`);
      }
      if (error.message.includes('Agent') && error.message.includes('not found')) {
        // Re-throw our own error messages
        throw error;
      }
      throw new Error(`Failed to retrieve existing agent '${name}': ${error.response?.data?.message || error.message}`);
    }
  }

  /**
   * Update agent status
   */
  async updateAgentStatus(agentId: string, status: string): Promise<void> {
    try {
      await this.axios.put(`/api/Agent/${agentId}/status`, { status });
      console.log(chalk.blue(`📊 Agent ${agentId} status updated to: ${status}`));
    } catch (error) {
      throw new Error(`Failed to update agent status: ${error}`);
    }
  }

  /**
   * Send agent heartbeat
   */
  async sendHeartbeat(agentId: string): Promise<void> {
    try {
      await this.axios.put(`/api/Agent/${agentId}/heartbeat`);
      console.log(chalk.gray(`💓 Heartbeat sent for agent: ${agentId}`));
    } catch (error) {
      console.error(chalk.red(`❌ Heartbeat failed for agent ${agentId}: ${error}`));
      throw error;
    }
  }

  /**
   * Get active agents
   */
  async getActiveAgents(): Promise<AgentRegistrationResponse[]> {
    try {
      const response = await this.axios.get('/api/Agent/active');
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get active agents: ${error}`);
    }
  }

  /**
   * Get channel messages with advanced filtering
   */
  async getChannelMessages(channelId: number, filter?: MessageFilterRequest): Promise<ChatHubMessage[]> {
    try {
      const params = new URLSearchParams();
      
      if (filter) {
        Object.entries(filter).forEach(([key, value]) => {
          if (value !== undefined && value !== null) {
            if (Array.isArray(value)) {
              value.forEach(v => params.append(key, v.toString()));
            } else {
              params.append(key, value.toString());
            }
          }
        });
      }      

      const url = `/api/Message/channel/${channelId}/filtered${params.toString() ? '?' + params.toString() : ''}`;

      const response = await this.axios.get(url);
      
      console.log(chalk.blue(`📨 Retrieved ${response.data.length} messages from channel ${channelId}`));
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get channel messages: ${error}`);
    }
  }

  /**
   * Send message via REST API (fallback method)
   */
  async sendMessage(message: {
    channelId?: number;
    projectId?: number;
    phaseId?: number;
    parentMessageId?: number;
    content: string;
    senderId: string;
    mentions?: ChatHubMention[];
  }): Promise<ChatHubMessage> {
    try {
      const response = await this.axios.post('/message', message);
      console.log(chalk.green(`📤 Message sent via REST API: ${message.content.substring(0, 50)}...`));
      return response.data;
    } catch (error) {
      throw new Error(`Failed to send message: ${error}`);
    }
  }

  /**
   * Get projects
   */
  async getActiveProjects(): Promise<any[]> {
    try {
      const response = await this.axios.get('/project/active');
      return response.data;
    } catch (error) {
      throw new Error(`Failed to get active projects: ${error}`);
    }
  }

  /**
   * Test connection to ChatHub API
   */
  async testConnection(): Promise<boolean> {
    try {
      await this.checkHealth();
      console.log(chalk.green('✅ ChatHub API connection successful'));
      return true;
    } catch (error) {
      console.error(chalk.red('❌ ChatHub API connection failed:', error));
      return false;
    }
  }
}