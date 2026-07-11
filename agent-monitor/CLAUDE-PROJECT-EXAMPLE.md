# CLAUDE.md - Project Team Collaboration Configuration

## Project Overview
This is an example CLAUDE.md file for a target project that would include reference to the teamwork collaboration model.

## Team Collaboration Framework
@include teamwork.md

## Project-Specific Guidelines

### Project Context
- **Project Name**: E-Commerce Platform
- **Technology Stack**: React, Node.js, PostgreSQL
- **Development Approach**: Agile with 2-week sprints
- **ChatHub Channel**: Channel #15

### Role Assignments
- **Project Coordinator**: Alex Coordinator
- **System Architect**: Morgan Architect  
- **Backend Developer**: Jordan Backend
- **Frontend Developer**: Casey Frontend
- **UI/UX Engineer**: Riley Designer
- **QA Engineer**: Sam QA

### Project-Specific Communication Protocols

#### Code Review Requirements
All code changes must be reviewed by:
- **Backend changes**: System Architect + Frontend Developer (for API contracts)
- **Frontend changes**: UI/UX Engineer + Backend Developer (for integration)
- **Database changes**: System Architect + Backend Developer
- **UI/UX changes**: Frontend Developer + QA Engineer

#### Testing Standards
- **Unit Tests**: Minimum 80% coverage required
- **Integration Tests**: All API endpoints must have integration tests
- **E2E Tests**: Critical user journeys must be covered
- **Performance Tests**: Load testing for API endpoints under expected traffic

#### Deployment Process
1. **Development**: Feature branches with pull requests
2. **Testing**: QA Engineer validates in staging environment
3. **Review**: System Architect approves for production deployment
4. **Deployment**: Backend Developer handles production deployment

### Project-Specific Templates

#### Feature Implementation Template
```
🚀 FEATURE IMPLEMENTATION: [Feature Name]

User Story:
As a [user type], I want [goal] so that [benefit]

Acceptance Criteria:
- [ ] [Specific criteria 1]
- [ ] [Specific criteria 2] 
- [ ] [Specific criteria 3]

Technical Requirements:
- Backend: [API requirements]
- Frontend: [UI requirements]
- Database: [Schema changes needed]
- Testing: [Test coverage requirements]

Definition of Done:
- [ ] Code implemented and reviewed
- [ ] Unit tests written and passing
- [ ] Integration tests passing
- [ ] UI/UX approved
- [ ] Documentation updated
- [ ] QA testing completed
```

#### Bug Report Template
```
🐛 BUG REPORT: [Bug Title]

Environment:
- Browser/Platform: [Details]
- Version: [App version]
- User Account: [If relevant]

Steps to Reproduce:
1. [Step 1]
2. [Step 2]
3. [Step 3]

Expected Behavior:
[What should happen]

Actual Behavior:  
[What actually happens]

Impact:
- Severity: [Critical/High/Medium/Low]
- Affected Users: [Who is affected]
- Workaround: [If available]

Technical Details:
- Error Messages: [If any]
- Browser Console: [Error logs]
- Network Issues: [If relevant]
```

### Integration with Agent Monitor

The Agent Monitor system will supervise this project with the following configuration:

#### Monitoring Rules
- **Idle Detection**: 30-minute inactivity threshold
- **Task Assignment Monitoring**: Track @mentions from System Architect
- **Progress Tracking**: Monitor "✅ TASK COMPLETED" messages
- **Escalation Triggers**: "NEED ASSISTANCE" or "ESCALATE: Yes" messages

#### Discord Alert Configuration
Critical alerts will be sent to Discord for:
- Agent unresponsive for > 2 hours
- Project Coordinator reports critical blockers
- Multiple agents report the same issue
- Production deployment issues

### Success Criteria

#### Sprint Goals
Each 2-week sprint should deliver:
- **Functional Features**: Complete user stories with acceptance criteria met
- **Quality Metrics**: All tests passing, code review completed
- **Documentation**: Updated API docs and user guides
- **Team Health**: All agents actively participating and collaborating

#### Project Milestones
- **Week 2**: User authentication and basic product catalog
- **Week 4**: Shopping cart and checkout flow
- **Week 6**: Payment processing and order management  
- **Week 8**: User dashboard and order history
- **Week 10**: Admin panel and analytics
- **Week 12**: Production deployment and performance optimization

This configuration ensures all team members understand both the general collaboration framework from teamwork.md and the specific requirements for this e-commerce platform project.