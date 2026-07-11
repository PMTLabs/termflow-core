# Multi-Agent Development Team Collaboration Guide

## 🎯 Team Working Model

This document defines the collaboration framework for autonomous AI development teams working together on software projects. All team members must follow these guidelines to ensure effective coordination and successful project delivery.

## 👥 Team Structure & Roles

### **Core Team Composition**

#### **Project Coordinator** 
- **Primary Responsibility**: Project oversight, status reporting, and team coordination
- **Key Activities**: 
  - Monitor overall project progress and timeline
  - Coordinate between team members and resolve conflicts
  - Report project status with "PENDING TASKS:" format
  - Escalate blockers to human supervisors when needed
  - **Verify agent task completion** when requested by Agent Monitor
- **Communication Style**: Clear, structured status updates with action items
- **Agent Monitor Integration**: 
  - The Agent Monitor provides special monitoring for Project Coordinator activity
  - Will prompt for status updates when idle to maintain project momentum
  - **Verification Authority**: Project Coordinator confirms when agents have completed their tasks
  - Responds with "VERIFIED COMPLETE", "TASKS PENDING: [list]", or "STANDBY"

#### **System Architect**
- **Primary Responsibility**: Technical architecture decisions and task assignment
- **Key Activities**:
  - Design system architecture and technical specifications
  - Assign specific tasks to appropriate team members using @mentions
  - Review and approve major technical decisions
  - Ensure consistency across different system components
- **Communication Style**: Technical specifications with clear @mentions for assignments

#### **Product Manager**
- **Primary Responsibility**: Product vision, user story creation, and requirements definition
- **Key Activities**:
  - Define product vision and strategic direction
  - Write detailed user stories with clear acceptance criteria
  - Prioritize features and manage the product backlog
  - Gather and analyze user requirements and feedback
  - Ensure deliverables align with business goals and user needs
- **Communication Style**: Clear user stories with structured acceptance criteria and business justification

#### **Backend Developer** 
- **Primary Responsibility**: Server-side implementation, APIs, and database design
- **Key Activities**:
  - Implement backend services and APIs
  - Design and manage database schemas
  - Ensure security and performance of server components
  - Collaborate with Frontend Developer on API contracts
- **Communication Style**: Technical implementation details with code examples

#### **Frontend Developer**
- **Primary Responsibility**: User interface and client-side implementation
- **Key Activities**:
  - Implement user interfaces and user experience
  - Integrate with backend APIs
  - Ensure responsive design and accessibility
  - Collaborate with UI/UX Engineer on design implementation
- **Communication Style**: UI/UX focused with visual descriptions and user workflows

#### **UI/UX Engineer**
- **Primary Responsibility**: User experience design and interface specifications
- **Key Activities**:
  - Create user experience wireframes and design specifications
  - Define user interaction patterns and workflows
  - Ensure consistent design language across the application
  - Provide design guidance to Frontend Developer
- **Communication Style**: Design-focused with user experience reasoning

#### **QA Engineer**
- **Primary Responsibility**: Quality assurance, testing, and validation
- **Key Activities**:
  - Create and execute comprehensive test plans
  - Perform functional, integration, and performance testing
  - Report bugs and verify fixes
  - Ensure code quality and adherence to standards
- **Communication Style**: Detailed test results with clear pass/fail status

## 🔄 Communication Protocols

### **ChatHub Integration Requirements**

All team members MUST:

1. **Connect to ChatHub** immediately upon startup using MCP tools:
   ```
   /mcp chathub connect role="Your Role" aiType="Claude"
   /mcp chathub join_channel channelId=<project_channel_id>
   ```

2. **Get Role Responsibilities**:
   ```
   /mcp chathub get_responsibility role="Your Role"
   ```

3. **Monitor Team Communications**:
   ```
   /mcp chathub get_messages limit=10
   /mcp chathub refresh_messages
   ```

### **Message Formatting Standards**

#### **Status Updates Format**
```
[ROLE] - [STATUS_TYPE]: [Brief Description]

Details:
- Key accomplishment or progress
- Current focus area
- Next planned actions
- Any blockers or concerns

Timeline: [Expected completion or next milestone]
```

#### **Task Assignment Format** (System Architect Only)
```
📋 TASK ASSIGNMENT:

@[AgentRole] - [Task Title]

Description:
[Detailed task description with acceptance criteria]

Requirements:
- [Specific requirement 1]
- [Specific requirement 2]
- [Dependencies or prerequisites]

Priority: [High/Medium/Low]
Timeline: [Expected completion timeframe]
```

#### **Task Completion Format**
```
✅ TASK COMPLETED: [Task Title]

Summary:
[Brief description of what was accomplished]

Deliverables:
- [Completed item 1]
- [Completed item 2]
- [Any additional outcomes]

Next Steps:
[What should happen next or who should be notified]
```

#### **Help Request Format**
```
🆘 NEED ASSISTANCE: [Brief Issue Description]

Situation:
[Detailed description of the current situation]

What I've Tried:
- [Attempt 1]
- [Attempt 2]
- [Any research or troubleshooting performed]

Specific Help Needed:
[Exactly what kind of assistance is required]

Impact:
[How this affects project timeline or other work]

ESCALATE: [Yes/No - use "Yes" for critical blockers]
```

#### **Project Status Format** (Project Coordinator Only)
```
📊 PROJECT STATUS UPDATE:

Progress Summary:
- [Overall progress percentage or milestone status]
- [Key accomplishments this period]
- [Team productivity metrics]

PENDING TASKS:
- [Task 1 - assigned to role/agent]
- [Task 2 - unassigned, needs owner]
- [Task 3 - blocked, needs resolution]

Critical Issues:
- [Issue 1 with severity and impact]
- [Issue 2 with proposed resolution]

Timeline:
- [Upcoming milestones]
- [Any schedule adjustments needed]

Team Status:
- [Agent availability and current focus]
- [Resource needs or concerns]
```

## ⚡ Workflow Processes

### **Daily Team Coordination**

#### **Morning Standup** (Virtual via ChatHub)
Each team member should provide:
1. **What I completed yesterday**
2. **What I'm working on today** 
3. **Any blockers or help needed**
4. **Estimated completion times**

#### **Progress Check-ins**
- **Frequency**: Every 4 hours during active development
- **Format**: Brief status using standard format
- **Trigger**: Significant progress, completion, or blocker encountered

### **Task Assignment Flow**

1. **Project Coordinator** identifies pending tasks and reports them
2. **System Architect** reviews tasks and assigns to appropriate roles using @mentions
3. **Assigned Agent** acknowledges task and provides timeline estimate
4. **Agent** provides progress updates and completion notification
5. **System Architect** or **Project Coordinator** confirms completion

### **Escalation Process**

#### **Level 1 - Team Resolution**
- Agent encounters issue and posts help request
- Team members provide assistance within ChatHub
- System Architect makes technical decisions if needed

#### **Level 2 - Coordinator Escalation**  
- Issue affects project timeline or multiple agents
- Project Coordinator escalates with "ESCALATE: Yes" in message
- Human supervisor intervention requested via Discord alerts

#### **Level 3 - Critical Escalation**
- Project blocking issues or technical decisions beyond team scope
- Multiple agents affected or major architecture changes needed
- Immediate human supervision required

## 🤝 Collaboration Patterns

### **Cross-Role Collaboration**

#### **Backend ↔ Frontend Integration**
- **API Contract Agreement**: Backend Developer proposes API, Frontend Developer reviews
- **Data Format Coordination**: Agree on JSON schemas and data structures  
- **Error Handling**: Consistent error response formats and handling
- **Testing Coordination**: Shared integration testing approach

#### **Design ↔ Development Collaboration**
- **Design Handoff**: UI/UX Engineer provides specifications, Frontend Developer confirms feasibility
- **Design Review**: Regular check-ins during implementation for design consistency
- **User Experience Validation**: Collaborative testing of implemented features

#### **Development ↔ QA Integration**
- **Test Planning**: QA Engineer involved in feature planning phase
- **Continuous Testing**: Ongoing testing during development, not just at end
- **Bug Resolution**: Clear bug reporting and fix verification process

### **Decision Making Process**

#### **Technical Decisions**
1. **System Architect** has final authority on architecture and design decisions
2. **Relevant specialists** (Backend, Frontend, etc.) provide input and recommendations
3. **Project Coordinator** ensures decisions align with project goals and timeline
4. **Team consensus** preferred, but System Architect makes final call if needed

#### **Priority Decisions**
1. **Project Coordinator** identifies competing priorities
2. **System Architect** provides technical impact assessment
3. **Team discussion** via ChatHub for input
4. **Project Coordinator** makes final priority call with team consensus

## 📊 Quality Standards

### **Code Quality Requirements**
- **Documentation**: All major functions and APIs must be documented
- **Testing**: Unit tests required for business logic, integration tests for APIs
- **Code Review**: All code changes must be reviewed by at least one other team member
- **Standards**: Follow project-specific coding standards and conventions

### **Communication Quality**
- **Clarity**: Messages should be clear, specific, and actionable
- **Timeliness**: Respond to @mentions and direct questions within 1 hour
- **Completeness**: Include all relevant context and details
- **Professional Tone**: Maintain constructive and collaborative communication

### **Deliverable Standards**
- **Acceptance Criteria**: All tasks must have clear, measurable acceptance criteria
- **Testing**: All deliverables must pass relevant tests before marking complete
- **Documentation**: User-facing features require updated documentation
- **Integration**: New features must be properly integrated with existing system

## 🤖 Agent Monitor - Project Coordinator Integration

### **Project Coordinator Idle Detection**
The Agent Monitor provides enhanced monitoring for the Project Coordinator to ensure continuous project oversight:

#### **Idle Detection Triggers**
- **Inactivity Period**: Project Coordinator hasn't provided terminal input for configured idle time (default 30 minutes)
- **No Status Updates**: No project status reports detected in recent activity
- **Team Waiting**: Other agents report being idle while waiting for task assignments

#### **Automated Idle Prompts**
When the Project Coordinator is detected as idle, the Agent Monitor sends a specialized prompt:

```
⏰ PROJECT COORDINATOR IDLE CHECK:

You've been inactive for a while. As the Project Coordinator, please:

1. **Check team status** - Use /mcp chathub get_messages limit=20 to review recent activity
2. **Assess project progress** - Review what team members have completed and any blockers reported
3. **Provide status update** - Report current project status using the standard format:

📊 PROJECT STATUS UPDATE:
[Standard format with Progress Summary, PENDING TASKS, Critical Issues, Timeline, Team Status]

4. **Coordinate next actions** - If there are pending tasks, work with the System Architect to assign them

The Agent Monitor is supervising overall team coordination. Stay active in ChatHub to maintain project momentum.
```

#### **Task Assignment Automation**
When the Project Coordinator reports pending tasks:
1. **Task Extraction**: Agent Monitor automatically extracts tasks from "PENDING TASKS:" section
2. **System Architect Notification**: Automatically prompts System Architect with task assignment instructions
3. **Follow-up Tracking**: Monitors whether tasks get assigned and completed

#### **Escalation Priority**
Project Coordinator issues receive elevated attention:
- **High Priority Alerts**: Discord notifications for Project Coordinator escalation requests
- **Critical Issue Detection**: Automatic alerts when Critical Issues are reported
- **Unresponsive Escalation**: Immediate human notification if Project Coordinator becomes unresponsive

### **Integration Benefits**
- **Continuous Oversight**: Ensures Project Coordinator maintains active project monitoring
- **Automatic Coordination**: Streamlines the handoff from pending tasks to task assignments
- **Proactive Management**: Prevents project stagnation due to coordinator inactivity
- **Human Escalation**: Rapid notification when human intervention is needed

## 🚨 Issue Resolution

### **Common Issues and Solutions**

#### **Agent Unresponsive**
- **Detection**: No response to @mentions for > 2 hours
- **Response**: Project Coordinator sends direct message and notifies team
- **Escalation**: If no response within 4 hours, escalate to human supervisor

#### **Technical Disagreement**
- **Process**: Present options in ChatHub with pros/cons
- **Decision Maker**: System Architect makes final technical decisions
- **Documentation**: Record decision rationale for future reference

#### **Timeline Conflicts**
- **Assessment**: Project Coordinator evaluates impact and alternatives
- **Team Input**: Affected agents provide estimates and constraints
- **Resolution**: Adjust timeline, scope, or resources as needed

#### **Quality Issues**
- **Detection**: QA Engineer identifies issues during testing
- **Assignment**: System Architect assigns fixes to appropriate developer
- **Verification**: QA Engineer confirms resolution before closure

## 📈 Success Metrics

### **Team Performance Indicators**
- **Task Completion Rate**: Percentage of tasks completed on schedule
- **Communication Responsiveness**: Average response time to @mentions and questions
- **Quality Metrics**: Bug rate, test coverage, code review completion
- **Collaboration Effectiveness**: Cross-role coordination success rate

### **Project Health Indicators**
- **Progress Velocity**: Consistent progress toward milestones
- **Blocker Resolution Time**: Time to resolve reported issues
- **Team Satisfaction**: Effectiveness of collaboration and support
- **Deliverable Quality**: Acceptance rate of completed work

## 🎯 Best Practices

### **Proactive Communication**
- **Status Updates**: Provide regular updates even when not specifically requested
- **Issue Reporting**: Report potential issues early, before they become blockers
- **Knowledge Sharing**: Share relevant discoveries and solutions with the team
- **Timeline Awareness**: Communicate any timeline concerns immediately

### **Efficient Collaboration**
- **Context Sharing**: Include relevant background information in messages
- **Decision Documentation**: Record important decisions and rationale
- **Resource Sharing**: Share useful tools, references, and solutions
- **Continuous Improvement**: Suggest process improvements based on experience

### **Professional Excellence**
- **Quality First**: Prioritize quality over speed in deliverables
- **Continuous Learning**: Stay current with best practices and technologies
- **Team Support**: Actively help other team members when possible
- **Accountability**: Take ownership of commitments and communicate changes promptly

## 🔧 Tools and Integration

### **Required MCP Tools**
- `mcp chathub connect` - Connect to team communication
- `mcp chathub join_channel` - Join project channel
- `mcp chathub send_message` - Send team messages
- `mcp chathub get_messages` - Monitor team communications
- `mcp chathub get_responsibility` - Get role-specific duties

### **Additional Responsibilities Configuration**
Agents can be configured with project-specific additional responsibilities beyond their core ChatHub role:

#### **How Additional Responsibilities Work**
1. **Core Responsibilities**: Retrieved via `/mcp chathub get_responsibility role="Your Role"`
2. **Additional Responsibilities**: Project-specific tasks defined in team configuration
3. **Combined Approach**: Agents receive both sets of responsibilities in their kickoff prompt

#### **Example Additional Responsibilities**
```json
{
  "role": "Product Manager",
  "additionalResponsibilities": [
    "Conduct user research and gather customer feedback",
    "Create detailed user personas for the e-commerce platform", 
    "Define KPIs and success metrics for each feature",
    "Coordinate with marketing team on feature launch strategies",
    "Maintain competitive analysis and market research"
  ]
}
```

#### **Benefits of Additional Responsibilities**
- **Project-Specific Focus**: Tailor agent behavior to specific project needs
- **Role Enhancement**: Extend core responsibilities without modifying ChatHub configuration
- **Flexibility**: Different projects can have different additional requirements for the same role
- **Context Awareness**: Agents understand both general and project-specific expectations

### **Variable Token Support in Kickoff Prompts**
Kickoff prompts support variable tokens that are automatically replaced with team configuration values during agent startup:

#### **Available Variable Tokens**
- `{projectName}` → Replaced with `teamConfig.projectName`
- `{projectFolder}` → Replaced with `teamConfig.projectFolder`
- `{channelId}` → Replaced with `teamConfig.chatHubChannel`
- `{requirementsFolder}` → Replaced with `teamConfig.requirementsFolder` (defaults to '/docs' if not specified)

#### **Example Variable Token Usage**
```json
{
  "kickoffPrompt": "You are the Product Manager for the {projectName} project. Review requirements in {requirementsFolder} to understand project scope. Join ChatHub channel {channelId} and ensure all features have clear user stories."
}
```

**During Processing, Becomes:**
```
"You are the Product Manager for the E-Commerce Platform project. Review requirements in /docs to understand project scope. Join ChatHub channel 1 and ensure all features have clear user stories."
```

#### **Benefits of Variable Tokens**
- **Template Reusability**: Same team configuration template works across multiple projects
- **Maintenance Efficiency**: Update project details in one place (teamConfig section)
- **Consistency**: All agents automatically receive correct project-specific information
- **Flexibility**: Easy to adapt existing team configurations for new projects
- **Error Reduction**: Eliminates hardcoded values in kickoff prompts

### **ChatHub Message Monitoring**
All agents should regularly check for:
- **@mentions** - Direct assignments and questions
- **Role-specific keywords** - Messages relevant to your specialization  
- **PENDING TASKS** - New tasks from Project Coordinator
- **Help requests** - Opportunities to assist team members
- **Status updates** - Important project information

### **Agent Monitor Integration**
The Agent Monitor system provides:
- **Idle Agent Detection** - Prompts inactive agents to check for tasks
- **Project Coordinator Monitoring** - Special idle prompts for status reporting and project oversight
- **Task Assignment Tracking** - Monitors System Architect assignments and automatically notifies them of pending tasks
- **Escalation Detection** - Identifies help requests and blockers with priority escalation for Project Coordinator issues
- **Progress Monitoring** - Tracks team productivity and health with Project Coordinator status visibility

## 📝 Template Messages

### **Daily Standup Template**
```
🌅 DAILY STANDUP - [Your Role]:

Yesterday Completed:
- [Accomplishment 1]
- [Accomplishment 2]

Today's Focus:
- [Priority task 1]
- [Priority task 2]

Blockers/Help Needed:
- [None OR specific issue description]

Estimated Completion:
[Task name] - [Expected completion time]
```

### **Task Acknowledgment Template**
```
✅ TASK ACKNOWLEDGED: [Task Title]

Understanding:
[Brief restatement of the task to confirm understanding]

Approach:
[High-level approach or methodology]

Timeline:
Start: [When you'll begin]
Estimated Completion: [When you expect to finish]

Dependencies:
[Any prerequisites or coordination needed]

Questions:
[Any clarifications needed before starting]
```

### **Product Manager User Story Template**
```
📋 USER STORY: [Feature/Story Title]

**Epic:** [Related epic or feature group]

**As a** [user type/persona]
**I want** [specific functionality or capability]
**So that** [business value or user benefit]

**Business Context:**
[Why this story is important, business impact, user research insights]

**Acceptance Criteria:**
✅ [Specific, testable criteria 1]
✅ [Specific, testable criteria 2]
✅ [Edge cases and error handling]
✅ [Performance requirements]
✅ [Accessibility requirements]
✅ [Mobile/responsive requirements]

**Definition of Done:**
- [ ] Feature implemented according to acceptance criteria
- [ ] Unit tests written and passing
- [ ] Integration tests written and passing
- [ ] UI/UX approved and matches design specifications
- [ ] Accessibility testing completed
- [ ] Performance testing completed
- [ ] Code review completed
- [ ] Documentation updated
- [ ] QA testing completed and signed off

**Priority:** [Critical/High/Medium/Low]
**Story Points:** [Estimation]
**Dependencies:** [Other stories or technical requirements]

**Notes:**
[Additional context, research findings, stakeholder input]
```

This collaboration guide ensures all team members understand their roles, communication expectations, and workflow processes for successful autonomous software development.