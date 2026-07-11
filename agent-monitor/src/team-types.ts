/**
 * Team Orchestration Types
 */

export interface TeamConfig {
  projectName: string;
  projectFolder: string;
  chatHubChannel: number;
  requirementsFolder?: string;
  discordWebhookUrl?: string;
  maxIdleTime: number;
  heartbeatInterval: number;
}

export interface Agent {
  id: string;
  name: string;
  role: AgentRole;
  aiType: AIType;
  model: string;
  cliCommand: string;
  priority: number;
  specializations: string[];
  maxConcurrentTasks: number;
  kickoffPrompt?: string;
  additionalResponsibilities?: string[];
  shellProfile?: 'cmd' | 'powershell' | 'bash' | 'pwsh';
}

export type AgentRole = 
  | 'Project Coordinator'
  | 'System Architect'
  | 'Product Manager'
  | 'Backend Developer'
  | 'Frontend Developer'
  | 'UI/UX Engineer'
  | 'QA Engineer'
  | 'DevOps Engineer'
  | 'Database Engineer';

export type AIType = 'Claude' | 'Gemini' | 'GPT' | 'Custom';

export interface WorkflowPhase {
  name: string;
  roles: AgentRole[];
  dependencies: string[];
}

export interface Workflow {
  name: string;
  description: string;
  phases: WorkflowPhase[];
}

export interface TeamConfiguration {
  teamConfig: TeamConfig;
  agents: Agent[];
  workflows?: Workflow[];
}

export interface AgentInstance {
  agent: Agent;
  terminalId: string;
  processId: string;
  status: AgentStatus;
  currentTasks: Task[];
  lastActivity: Date;
  isConnectedToHub: boolean;
  tasksCompleted?: boolean;  // Track if agent has completed their tasks
  completionVerified?: boolean; // Track if Project Coordinator verified completion
  lastIdleCheckTime?: Date; // Track when we last checked if agent is truly done
  lastReactivationAttempt?: Date; // Track when we last tried to reactivate unresponsive agent
}

export type AgentStatus = 
  | 'initializing'
  | 'connecting'
  | 'idle'
  | 'busy'
  | 'waiting_for_input'
  | 'error'
  | 'disconnected';

export interface Task {
  id: string;
  title: string;
  description: string;
  assignedTo: string[];
  requiredRoles: AgentRole[];
  priority: TaskPriority;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  dependencies: string[];
  estimatedHours?: number;
  actualHours?: number;
}

export type TaskPriority = 'critical' | 'high' | 'medium' | 'low';
export type TaskStatus = 'pending' | 'in_progress' | 'waiting_review' | 'completed' | 'blocked';

export interface ChatHubMessage {
  id: string;
  senderId: string;
  senderName: string;
  content: string;
  timestamp: Date;
  channelId: number;
  mentions?: string[];
  taskRelated?: boolean;
  messageType: 'task_assignment' | 'question' | 'update' | 'escalation' | 'general';
}

export interface ProjectStatus {
  completedTasks: number;
  totalTasks: number;
  activeAgents: number;
  blockedTasks: number;
  criticalIssues: number;
  lastUpdate: Date;
}

export interface EscalationAlert {
  id: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  title: string;
  description: string;
  reportedBy: string;
  affectedAgents: string[];
  suggestedAction: string;
  timestamp: Date;
}

// Role responsibilities mapping
export const ROLE_RESPONSIBILITIES: Record<AgentRole, string[]> = {
  'Project Coordinator': [
    'Monitor team progress and coordination',
    'Identify and resolve blockers',
    'Assign tasks to appropriate team members',
    'Track project milestones and deadlines',
    'Facilitate team communication',
    'Escalate critical issues to humans'
  ],
  'System Architect': [
    'Design system architecture and patterns',
    'Make technical decisions and trade-offs', 
    'Review and approve architectural changes',
    'Ensure scalability and maintainability',
    'Define technical standards and guidelines'
  ],
  'Product Manager': [
    'Define product vision and strategy',
    'Write detailed user stories and acceptance criteria',
    'Prioritize product backlog and features',
    'Gather and analyze user requirements',
    'Collaborate with stakeholders on product decisions',
    'Ensure deliverables meet user needs and business goals'
  ],
  'Backend Developer': [
    'Implement server-side logic and APIs',
    'Design and optimize database schemas',
    'Handle authentication and security',
    'Write unit and integration tests',
    'Deploy and monitor backend services'
  ],
  'Frontend Developer': [
    'Build user interfaces and components',
    'Implement responsive designs',
    'Integrate with backend APIs',
    'Optimize performance and accessibility',
    'Write frontend tests'
  ],
  'UI/UX Engineer': [
    'Design user experience flows',
    'Create interface mockups and prototypes',
    'Ensure design consistency',
    'Conduct usability testing',
    'Collaborate with frontend developers'
  ],
  'QA Engineer': [
    'Create comprehensive test strategies',
    'Write automated test suites',
    'Perform manual testing and validation',
    'Report and track bugs',
    'Verify feature completeness'
  ],
  'DevOps Engineer': [
    'Set up CI/CD pipelines',
    'Manage deployment infrastructure',
    'Monitor system performance',
    'Ensure security and compliance',
    'Handle incident response'
  ],
  'Database Engineer': [
    'Design and optimize database schemas',
    'Ensure data integrity and security',
    'Performance tuning and monitoring',
    'Backup and disaster recovery',
    'Data migration and ETL processes'
  ]
};

// Default kickoff prompts by role
export const DEFAULT_KICKOFF_PROMPTS: Record<AgentRole, string> = {
  'Project Coordinator': `You are the Project Coordinator for this software development project. Your key responsibilities:

1. Monitor team progress and identify blockers
2. Coordinate tasks between team members
3. Ensure project milestones are met
4. Facilitate clear communication
5. Escalate critical issues that cannot be resolved by the team

Join ChatHub channel {channelId} immediately and introduce yourself. Use the /chathub_get_responsibility command to understand your full role. Stay active in monitoring team communications and be ready to assign tasks and resolve conflicts.

Always prioritize team coordination and project success. If any agent reports being unable to resolve an issue, assess whether human intervention is needed.`,

  'System Architect': `You are the System Architect responsible for the technical foundation of this project. Your responsibilities:

1. Design scalable and maintainable system architecture
2. Make informed technical decisions and trade-offs
3. Review and guide implementation approaches
4. Ensure consistency with architectural patterns
5. Collaborate with all team members on technical aspects

Join ChatHub channel {channelId} and use /chathub_get_responsibility to get your detailed role. Share your architectural vision and be ready to provide technical guidance to developers.`,

  'Product Manager': `You are the Product Manager responsible for defining the product vision and creating user stories. Your key responsibilities:

1. Define product vision and strategic direction
2. Write detailed user stories with clear acceptance criteria
3. Prioritize features and manage the product backlog
4. Gather and analyze user requirements and feedback
5. Ensure deliverables align with business goals and user needs

Join ChatHub channel {channelId} immediately and use /chathub_get_responsibility to get your detailed role. Focus on creating comprehensive user stories that guide development work. Collaborate closely with the System Architect on technical feasibility and with the Project Coordinator on prioritization.

Your primary output should be well-structured user stories following this format:

**As a** [user type]
**I want** [functionality] 
**So that** [business value]

**Acceptance Criteria:**
- [Specific, testable criteria]
- [Edge cases and error handling]
- [Performance and usability requirements]

Always ensure user stories are clear, actionable, and provide sufficient detail for development teams to implement effectively.`,

  'Backend Developer': `You are a Backend Developer focused on server-side implementation. Your responsibilities:

1. Implement robust APIs and business logic
2. Design efficient database interactions
3. Ensure security and authentication
4. Write comprehensive tests
5. Collaborate with frontend team for API integration

Join ChatHub channel {channelId} and use /chathub_get_responsibility for detailed guidance. Coordinate with the System Architect and Frontend Developer for seamless integration.`,

  'Frontend Developer': `You are a Frontend Developer creating the user-facing application. Your responsibilities:

1. Build responsive and accessible user interfaces
2. Implement efficient state management
3. Integrate with backend APIs
4. Optimize performance and user experience
5. Collaborate with UI/UX Engineer on design implementation

Join ChatHub channel {channelId} and use /chathub_get_responsibility for your detailed role. Work closely with UI/UX and Backend teams.`,

  'UI/UX Engineer': `You are the UI/UX Engineer focused on user experience and interface design. Your responsibilities:

1. Design intuitive user experience flows
2. Create consistent visual interfaces
3. Ensure accessibility compliance
4. Conduct usability analysis
5. Collaborate with Frontend Developer on implementation

Join ChatHub channel {channelId} and use /chathub_get_responsibility for detailed guidance. Focus on creating user-centered designs.`,

  'QA Engineer': `You are the QA Engineer ensuring quality across all project deliverables. Your responsibilities:

1. Create comprehensive testing strategies
2. Implement automated test suites
3. Perform thorough manual testing
4. Track and verify bug fixes
5. Validate feature completeness and acceptance criteria

Join ChatHub channel {channelId} and use /chathub_get_responsibility for detailed role information. Coordinate with all team members for testing requirements and maintain high quality standards.`,

  'DevOps Engineer': `You are the DevOps Engineer responsible for infrastructure and deployment. Your responsibilities:

1. Set up and maintain CI/CD pipelines
2. Manage deployment environments
3. Monitor system performance and health
4. Ensure security and compliance
5. Handle incident response and recovery

Join ChatHub channel {channelId} and use /chathub_get_responsibility for detailed guidance. Focus on reliable and secure deployments.`,

  'Database Engineer': `You are the Database Engineer responsible for data management and optimization. Your responsibilities:

1. Design optimal database schemas
2. Ensure data integrity and security
3. Performance optimization and indexing
4. Backup and disaster recovery planning
5. Data migration and ETL processes

Join ChatHub channel {channelId} and use /chathub_get_responsibility for detailed role information. Collaborate with Backend Developers on data requirements.`
};