/**
 * Communication Protocol Enforcer - Implements structured communication templates
 * Based on communication-enforce.md hub-and-spoke model and message templates
 */

import { EventEmitter } from 'events';
import chalk from 'chalk';
import { AgentRole } from './team-types';

export interface MessageTemplate {
  pattern: RegExp;
  requiredFields: string[];
  format: string;
  example: string;
  category: MessageCategory;
}

export type MessageCategory = 'status' | 'task' | 'escalation' | 'report' | 'blocked' | 'completed';

export interface CommunicationRule {
  sourceRole: AgentRole;
  targetRole: AgentRole;
  allowDirect: boolean;
  requiresRouting: boolean;
  routeThrough: AgentRole;
}

export interface MessageValidation {
  isValid: boolean;
  template: MessageTemplate | null;
  missingFields: string[];
  suggestions: string[];
  category: MessageCategory | null;
}

export interface CommunicationStats {
  agentId: string;
  messagesSent: number;
  messagesReceived: number;
  templateViolations: number;
  escalations: number;
  lastActivity: Date;
}

export interface AntiPatternDetection {
  broadcastStorm: boolean;
  meetingHell: boolean;
  micromanagement: boolean;
  endlessThread: boolean;
  violationType: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export class CommunicationProtocolEnforcer extends EventEmitter {
  private messageTemplates: Map<MessageCategory, MessageTemplate>;
  private communicationRules: CommunicationRule[];
  private messageHistory: Map<string, any[]> = new Map();
  private agentStats: Map<string, CommunicationStats> = new Map();
  private threadTracking: Map<string, any[]> = new Map();
  private rateLimiting: Map<string, number[]> = new Map();

  // Anti-pattern thresholds
  private readonly BROADCAST_THRESHOLD = 3; // Max messages to >2 people in 5 min
  private readonly THREAD_LIMIT = 3; // Max exchanges before escalation required
  private readonly RATE_LIMIT_WINDOW = 5 * 60 * 1000; // 5 minutes
  private readonly RATE_LIMIT_MAX = 10; // Max messages per window

  constructor() {
    super();
    this.initializeMessageTemplates();
    this.initializeCommunicationRules();
  }

  /**
   * Initialize standard message templates from communication-enforce.md
   */
  private initializeMessageTemplates(): void {
    this.messageTemplates = new Map([
      ['status', {
        pattern: /^STATUS\s+\[([^\]]+)\]\s+\[([^\]]+)\]/i,
        requiredFields: ['AGENT_NAME', 'TIMESTAMP', 'Completed', 'Current', 'Blocked', 'ETA'],
        format: `STATUS [AGENT_NAME] [TIMESTAMP]
Completed: 
- [Specific task 1]
- [Specific task 2]
Current: [What working on now]
Blocked: [Any blockers]
ETA: [Expected completion]`,
        example: `STATUS [Jordan Backend] [2024-01-15 14:30]
Completed:
- Implemented user authentication API endpoints
- Added JWT token validation middleware
Current: Working on password reset functionality
Blocked: None
ETA: Password reset completion by 16:00`,
        category: 'status'
      }],

      ['task', {
        pattern: /^TASK\s+\[([^\]]+)\]:\s*(.+)/i,
        requiredFields: ['ID', 'title', 'Assigned to', 'Objective', 'Success Criteria', 'Priority'],
        format: `TASK [ID]: [Clear title]
Assigned to: [AGENT]
Objective: [Specific goal]
Success Criteria:
- [Measurable outcome]
- [Quality requirement]
Priority: HIGH/MED/LOW`,
        example: `TASK [AUTH-001]: Implement User Authentication System
Assigned to: Jordan Backend
Objective: Create secure login/logout functionality with JWT tokens
Success Criteria:
- Users can register with email/password
- Secure JWT-based authentication
- Password hashing with bcrypt
- Rate limiting on login attempts
Priority: HIGH`,
        category: 'task'
      }],

      ['escalation', {
        pattern: /^ESCALATION\s+\[([^\]]+)\]/i,
        requiredFields: ['ISSUE', 'BLOCKER', 'ATTEMPTED_SOLUTIONS', 'IMPACT', 'URGENCY'],
        format: `ESCALATION [ISSUE_ID]
Blocker: [Specific problem]
Attempted Solutions:
- [Solution 1]
- [Solution 2]
Impact: [Business/technical impact]
Urgency: CRITICAL/HIGH/MEDIUM
Escalating to: [Role/Person]`,
        example: `ESCALATION [DB-CONN-001]
Blocker: Database connection pool exhausted, preventing all API calls
Attempted Solutions:
- Increased pool size from 10 to 20 connections
- Added connection timeout handling
- Reviewed slow queries and optimized 3 critical queries
Impact: All users unable to access application features
Urgency: CRITICAL
Escalating to: System Architect`,
        category: 'escalation'
      }],

      ['blocked', {
        pattern: /^BLOCKED\s+\[([^\]]+)\]/i,
        requiredFields: ['AGENT', 'TASK', 'DEPENDENCY', 'IMPACT'],
        format: `BLOCKED [AGENT_NAME]
Task: [Current task]
Dependency: [What is blocking progress]
Impact: [How this affects timeline]
Need: [Specific help needed]`,
        example: `BLOCKED [Casey Frontend]
Task: Implementing user dashboard components
Dependency: Waiting for API endpoint specifications from backend team
Impact: Frontend development 2 days behind schedule
Need: API contract definitions and mock data structure`,
        category: 'blocked'
      }],

      ['completed', {
        pattern: /^COMPLETED\s+\[([^\]]+)\]/i,
        requiredFields: ['TASK', 'DELIVERABLES', 'TESTING', 'NEXT_STEPS'],
        format: `COMPLETED [TASK_ID]
Task: [Task description]
Deliverables:
- [Deliverable 1]
- [Deliverable 2]
Testing: [Test results/coverage]
Next Steps: [What comes next]`,
        example: `COMPLETED [AUTH-001]
Task: User Authentication System Implementation
Deliverables:
- Registration endpoint with validation
- Login endpoint with JWT generation
- Middleware for token verification
- Password hashing with bcrypt
Testing: 95% test coverage, all integration tests passing
Next Steps: Ready for QA review and integration testing`,
        category: 'completed'
      }]
    ]);
  }

  /**
   * Initialize hub-and-spoke communication rules
   */
  private initializeCommunicationRules(): void {
    this.communicationRules = [
      // Developers report to Project Coordinator only
      {
        sourceRole: 'Backend Developer',
        targetRole: 'Project Coordinator',
        allowDirect: true,
        requiresRouting: false,
        routeThrough: 'Project Coordinator'
      },
      {
        sourceRole: 'Frontend Developer', 
        targetRole: 'Project Coordinator',
        allowDirect: true,
        requiresRouting: false,
        routeThrough: 'Project Coordinator'
      },
      // Cross-functional communication goes through PM
      {
        sourceRole: 'Backend Developer',
        targetRole: 'Frontend Developer',
        allowDirect: false,
        requiresRouting: true,
        routeThrough: 'Project Coordinator'
      },
      // QA can communicate directly for urgent issues
      {
        sourceRole: 'QA Engineer',
        targetRole: 'Backend Developer',
        allowDirect: true,
        requiresRouting: false,
        routeThrough: 'Project Coordinator'
      },
      // Emergency escalation to System Architect allowed
      {
        sourceRole: 'Backend Developer',
        targetRole: 'System Architect',
        allowDirect: true,
        requiresRouting: false,
        routeThrough: 'Project Coordinator'
      }
    ];
  }

  /**
   * Validate message against templates and communication rules
   */
  validateMessage(
    fromAgent: string,
    fromRole: AgentRole,
    toAgent: string,
    toRole: AgentRole,
    message: string
  ): MessageValidation {
    // Detect message category
    const category = this.detectMessageCategory(message);
    const template = category ? this.messageTemplates.get(category) : null;

    const validation: MessageValidation = {
      isValid: true,
      template,
      missingFields: [],
      suggestions: [],
      category
    };

    if (template) {
      // Check template format
      const templateMatch = template.pattern.test(message);
      if (!templateMatch) {
        validation.isValid = false;
        validation.suggestions.push(`Message should follow ${category} template format`);
        validation.suggestions.push(`Example: ${template.example}`);
      }

      // Check required fields
      const missingFields = template.requiredFields.filter(field => {
        const fieldPattern = new RegExp(field, 'i');
        return !fieldPattern.test(message);
      });

      validation.missingFields = missingFields;
      if (missingFields.length > 0) {
        validation.isValid = false;
        validation.suggestions.push(`Missing required fields: ${missingFields.join(', ')}`);
      }
    }

    // Check communication rules
    const ruleViolation = this.checkCommunicationRules(fromRole, toRole, message);
    if (ruleViolation) {
      validation.isValid = false;
      validation.suggestions.push(ruleViolation);
    }

    return validation;
  }

  /**
   * Detect message category from content
   */
  private detectMessageCategory(message: string): MessageCategory | null {
    const upperMessage = message.toUpperCase();
    
    if (upperMessage.startsWith('STATUS')) return 'status';
    if (upperMessage.startsWith('TASK')) return 'task';
    if (upperMessage.startsWith('ESCALATION')) return 'escalation';
    if (upperMessage.startsWith('BLOCKED')) return 'blocked';
    if (upperMessage.startsWith('COMPLETED')) return 'completed';
    
    // Content-based detection
    if (upperMessage.includes('BLOCKED') || upperMessage.includes('WAITING FOR')) return 'blocked';
    if (upperMessage.includes('COMPLETED') || upperMessage.includes('FINISHED')) return 'completed';
    if (upperMessage.includes('HELP') || upperMessage.includes('URGENT')) return 'escalation';
    
    return null;
  }

  /**
   * Check communication rules (hub-and-spoke model)
   */
  private checkCommunicationRules(fromRole: AgentRole, toRole: AgentRole, message: string): string | null {
    const rule = this.communicationRules.find(r => 
      r.sourceRole === fromRole && r.targetRole === toRole
    );

    if (!rule) {
      // No specific rule, check if it's cross-functional
      const isCrossFunctional = fromRole !== toRole && 
        !['Project Coordinator', 'System Architect'].includes(toRole);
      
      if (isCrossFunctional) {
        return `Cross-functional communication should be routed through Project Coordinator`;
      }
    } else if (rule.requiresRouting && !rule.allowDirect) {
      return `Communication from ${fromRole} to ${toRole} must be routed through ${rule.routeThrough}`;
    }

    return null;
  }

  /**
   * Track message for anti-pattern detection
   */
  trackMessage(
    fromAgent: string,
    fromRole: AgentRole,
    toAgents: string[],
    message: string,
    threadId?: string
  ): void {
    const timestamp = new Date();
    
    // Update agent statistics
    this.updateAgentStats(fromAgent, 'sent');
    toAgents.forEach(agent => this.updateAgentStats(agent, 'received'));

    // Track message history
    const messageRecord = {
      fromAgent,
      fromRole,
      toAgents,
      message,
      timestamp,
      threadId
    };

    if (!this.messageHistory.has(fromAgent)) {
      this.messageHistory.set(fromAgent, []);
    }
    this.messageHistory.get(fromAgent)!.push(messageRecord);

    // Track thread if specified
    if (threadId) {
      if (!this.threadTracking.has(threadId)) {
        this.threadTracking.set(threadId, []);
      }
      this.threadTracking.get(threadId)!.push(messageRecord);
    }

    // Rate limiting
    this.trackRateLimit(fromAgent, timestamp);

    // Anti-pattern detection
    const antiPattern = this.detectAntiPatterns(fromAgent, toAgents, threadId);
    if (antiPattern.severity !== 'low') {
      this.emit('antiPatternDetected', {
        agentId: fromAgent,
        antiPattern,
        message: messageRecord,
        timestamp
      });
    }
  }

  /**
   * Update agent communication statistics
   */
  private updateAgentStats(agentId: string, type: 'sent' | 'received'): void {
    if (!this.agentStats.has(agentId)) {
      this.agentStats.set(agentId, {
        agentId,
        messagesSent: 0,
        messagesReceived: 0,
        templateViolations: 0,
        escalations: 0,
        lastActivity: new Date()
      });
    }

    const stats = this.agentStats.get(agentId)!;
    if (type === 'sent') {
      stats.messagesSent++;
    } else {
      stats.messagesReceived++;
    }
    stats.lastActivity = new Date();
  }

  /**
   * Track rate limiting per agent
   */
  private trackRateLimit(agentId: string, timestamp: Date): void {
    if (!this.rateLimiting.has(agentId)) {
      this.rateLimiting.set(agentId, []);
    }

    const timestamps = this.rateLimiting.get(agentId)!;
    timestamps.push(timestamp.getTime());

    // Clean old timestamps outside window
    const cutoff = timestamp.getTime() - this.RATE_LIMIT_WINDOW;
    this.rateLimiting.set(agentId, timestamps.filter(t => t > cutoff));
  }

  /**
   * Detect communication anti-patterns
   */
  private detectAntiPatterns(
    fromAgent: string,
    toAgents: string[],
    threadId?: string
  ): AntiPatternDetection {
    const detection: AntiPatternDetection = {
      broadcastStorm: false,
      meetingHell: false,
      micromanagement: false,
      endlessThread: false,
      violationType: '',
      severity: 'low'
    };

    // Broadcast storm detection
    if (toAgents.length > 2) {
      const recentBroadcasts = this.getRecentBroadcasts(fromAgent);
      if (recentBroadcasts >= this.BROADCAST_THRESHOLD) {
        detection.broadcastStorm = true;
        detection.violationType = 'Broadcasting to multiple recipients';
        detection.severity = 'high';
      }
    }

    // Endless thread detection
    if (threadId) {
      const threadMessages = this.threadTracking.get(threadId) || [];
      if (threadMessages.length > this.THREAD_LIMIT) {
        detection.endlessThread = true;
        detection.violationType = `Thread exceeded ${this.THREAD_LIMIT} exchanges`;
        detection.severity = 'medium';
      }
    }

    // Rate limit detection
    const rateLimitViolation = this.checkRateLimit(fromAgent);
    if (rateLimitViolation) {
      detection.violationType = 'Message rate limit exceeded';
      detection.severity = 'medium';
    }

    // Micromanagement detection (frequent status requests)
    const micromanagementScore = this.detectMicromanagement(fromAgent);
    if (micromanagementScore > 0.7) {
      detection.micromanagement = true;
      detection.violationType = 'Excessive micromanagement detected';
      detection.severity = 'medium';
    }

    return detection;
  }

  /**
   * Get recent broadcast count for agent
   */
  private getRecentBroadcasts(agentId: string): number {
    const messages = this.messageHistory.get(agentId) || [];
    const fiveMinutesAgo = Date.now() - this.RATE_LIMIT_WINDOW;
    
    return messages.filter(msg => 
      msg.timestamp.getTime() > fiveMinutesAgo && 
      msg.toAgents.length > 2
    ).length;
  }

  /**
   * Check if agent is exceeding rate limits
   */
  private checkRateLimit(agentId: string): boolean {
    const timestamps = this.rateLimiting.get(agentId) || [];
    return timestamps.length > this.RATE_LIMIT_MAX;
  }

  /**
   * Detect micromanagement patterns
   */
  private detectMicromanagement(agentId: string): number {
    const messages = this.messageHistory.get(agentId) || [];
    const recentMessages = messages.filter(msg => 
      Date.now() - msg.timestamp.getTime() < 2 * 60 * 60 * 1000 // 2 hours
    );

    if (recentMessages.length === 0) return 0;

    // Count status requests and check-ins
    const statusRequests = recentMessages.filter(msg =>
      msg.message.toLowerCase().includes('status') ||
      msg.message.toLowerCase().includes('progress') ||
      msg.message.toLowerCase().includes('update')
    ).length;

    return statusRequests / recentMessages.length;
  }

  /**
   * Generate formatted message template
   */
  generateTemplate(category: MessageCategory, data: Record<string, any>): string {
    const template = this.messageTemplates.get(category);
    if (!template) {
      throw new Error(`No template found for category: ${category}`);
    }

    let formattedMessage = template.format;
    
    // Replace placeholders with actual data
    for (const [key, value] of Object.entries(data)) {
      const placeholder = `[${key.toUpperCase()}]`;
      formattedMessage = formattedMessage.replace(new RegExp(placeholder, 'g'), value);
    }

    return formattedMessage;
  }

  /**
   * Suggest routing for cross-functional communication
   */
  suggestRouting(fromRole: AgentRole, toRole: AgentRole): {
    shouldRoute: boolean;
    routeThrough: AgentRole | null;
    reason: string;
  } {
    const rule = this.communicationRules.find(r => 
      r.sourceRole === fromRole && r.targetRole === toRole
    );

    if (rule && rule.requiresRouting) {
      return {
        shouldRoute: true,
        routeThrough: rule.routeThrough,
        reason: `Cross-functional communication should go through ${rule.routeThrough}`
      };
    }

    return {
      shouldRoute: false,
      routeThrough: null,
      reason: 'Direct communication allowed'
    };
  }

  /**
   * Get communication statistics
   */
  getStatistics(): {
    totalMessages: number;
    templateViolations: number;
    antiPatternDetections: number;
    agentStats: CommunicationStats[];
  } {
    const allMessages = Array.from(this.messageHistory.values()).flat();
    const templateViolations = Array.from(this.agentStats.values())
      .reduce((sum, stats) => sum + stats.templateViolations, 0);

    return {
      totalMessages: allMessages.length,
      templateViolations,
      antiPatternDetections: 0, // Would need to track this separately
      agentStats: Array.from(this.agentStats.values())
    };
  }

  /**
   * Clear old message history to prevent memory leaks
   */
  cleanupOldMessages(olderThanHours: number = 24): void {
    const cutoffTime = Date.now() - (olderThanHours * 60 * 60 * 1000);

    for (const [agentId, messages] of this.messageHistory.entries()) {
      const filteredMessages = messages.filter(msg => 
        msg.timestamp.getTime() > cutoffTime
      );
      this.messageHistory.set(agentId, filteredMessages);
    }

    // Clean thread tracking
    for (const [threadId, messages] of this.threadTracking.entries()) {
      const filteredMessages = messages.filter(msg => 
        msg.timestamp.getTime() > cutoffTime
      );
      
      if (filteredMessages.length === 0) {
        this.threadTracking.delete(threadId);
      } else {
        this.threadTracking.set(threadId, filteredMessages);
      }
    }
  }
}