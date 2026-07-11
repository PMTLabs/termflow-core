/**
 * Intelligent Task Routing and Agent Activation System
 * 
 * This module handles intelligent assignment of tasks to the most appropriate agents
 * based on their roles, current workload, specializations, and task dependencies.
 */

import { EventEmitter } from 'events';
import chalk from 'chalk';
import {
  Task,
  AgentInstance,
  AgentRole,
  TaskPriority
} from './team-types';

export interface TaskAssignment {
  taskId: string;
  agentId: string;
  assignedAt: Date;
  estimatedCompletion: Date;
  confidence: number; // 0-1, how confident we are in this assignment
}

export interface AgentWorkload {
  agentId: string;
  currentTasks: number;
  maxTasks: number;
  utilizationRate: number; // 0-1
  averageTaskTime: number; // in milliseconds
  successRate: number; // 0-1
  specializations: string[];
}

export interface TaskAnalysis {
  complexity: number; // 1-10
  estimatedHours: number;
  requiredSkills: string[];
  dependencies: string[];
  priority: TaskPriority;
  canBeParallelized: boolean;
}

export class TaskRouter extends EventEmitter {
  private agents: Map<string, AgentInstance> = new Map();
  private activeTasks: Map<string, Task> = new Map();
  private taskAssignments: Map<string, TaskAssignment> = new Map();
  private workloadHistory: Map<string, number[]> = new Map(); // Track agent performance
  private skillMatrix: Map<AgentRole, string[]> = new Map();

  constructor() {
    super();
    this.initializeSkillMatrix();
  }

  /**
   * Initialize skill matrix based on role responsibilities
   */
  private initializeSkillMatrix(): void {
    this.skillMatrix.set('Project Coordinator', [
      'project management', 'coordination', 'planning', 'communication',
      'risk management', 'stakeholder management', 'timeline management'
    ]);
    
    this.skillMatrix.set('System Architect', [
      'system design', 'architecture patterns', 'scalability', 'security',
      'performance optimization', 'technical leadership', 'design patterns'
    ]);
    
    this.skillMatrix.set('Backend Developer', [
      'server-side development', 'APIs', 'databases', 'security',
      'authentication', 'performance tuning', 'deployment'
    ]);
    
    this.skillMatrix.set('Frontend Developer', [
      'user interfaces', 'React', 'TypeScript', 'CSS', 'responsive design',
      'state management', 'performance optimization', 'accessibility'
    ]);
    
    this.skillMatrix.set('UI/UX Engineer', [
      'user experience', 'interface design', 'usability', 'accessibility',
      'design systems', 'prototyping', 'user research'
    ]);
    
    this.skillMatrix.set('QA Engineer', [
      'testing strategies', 'test automation', 'quality assurance',
      'bug tracking', 'performance testing', 'regression testing'
    ]);
    
    this.skillMatrix.set('DevOps Engineer', [
      'CI/CD', 'deployment', 'infrastructure', 'monitoring',
      'security', 'containerization', 'cloud platforms'
    ]);
    
    this.skillMatrix.set('Database Engineer', [
      'database design', 'optimization', 'data modeling',
      'performance tuning', 'backup strategies', 'data integrity'
    ]);
  }

  /**
   * Register an agent with the router
   */
  registerAgent(agent: AgentInstance): void {
    this.agents.set(agent.agent.id, agent);
    this.workloadHistory.set(agent.agent.id, []);
    
    console.log(chalk.green(`🎯 Registered agent: ${agent.agent.name} (${agent.agent.role})`));
  }

  /**
   * Analyze a task to determine complexity and requirements
   */
  analyzeTask(task: Task): TaskAnalysis {
    const analysis: TaskAnalysis = {
      complexity: this.calculateComplexity(task),
      estimatedHours: this.estimateHours(task),
      requiredSkills: this.extractRequiredSkills(task),
      dependencies: task.dependencies || [],
      priority: task.priority,
      canBeParallelized: this.canBeParallelized(task)
    };

    console.log(chalk.cyan(`📊 Task Analysis for "${task.title}":`));
    console.log(chalk.gray(`  Complexity: ${analysis.complexity}/10`));
    console.log(chalk.gray(`  Estimated: ${analysis.estimatedHours}h`));
    console.log(chalk.gray(`  Skills: ${analysis.requiredSkills.join(', ')}`));
    console.log(chalk.gray(`  Parallelizable: ${analysis.canBeParallelized ? 'Yes' : 'No'}`));

    return analysis;
  }

  /**
   * Find the best agent(s) for a task
   */
  findBestAgents(task: Task, analysis: TaskAnalysis): AgentInstance[] {
    const candidates: { agent: AgentInstance; score: number; reasons: string[] }[] = [];

    for (const agent of this.agents.values()) {
      const score = this.calculateAgentScore(agent, task, analysis);
      const reasons = this.getAssignmentReasons(agent, task, analysis);
      
      if (score > 0) {
        candidates.push({ agent, score, reasons });
      }
    }

    // Sort by score (highest first)
    candidates.sort((a, b) => b.score - a.score);

    console.log(chalk.yellow(`🎯 Agent candidates for "${task.title}":`));
    candidates.slice(0, 3).forEach((candidate, index) => {
      console.log(chalk.gray(`  ${index + 1}. ${candidate.agent.agent.name} (Score: ${candidate.score.toFixed(2)})`));
      console.log(chalk.gray(`     Reasons: ${candidate.reasons.join(', ')}`));
    });

    return candidates.map(c => c.agent);
  }

  /**
   * Assign a task to the most appropriate agent(s)
   */
  async assignTask(task: Task): Promise<TaskAssignment[]> {
    console.log(chalk.blue(`📋 Assigning task: "${task.title}" (Priority: ${task.priority})`));

    // Analyze the task
    const analysis = this.analyzeTask(task);

    // Find best agents
    const candidateAgents = this.findBestAgents(task, analysis);

    if (candidateAgents.length === 0) {
      console.log(chalk.red(`❌ No suitable agents found for task: ${task.title}`));
      this.emit('taskUnassignable', { task, reason: 'No suitable agents available' });
      return [];
    }

    const assignments: TaskAssignment[] = [];

    // Determine how many agents to assign
    const maxAgents = analysis.canBeParallelized ? Math.min(candidateAgents.length, 3) : 1;
    
    for (let i = 0; i < maxAgents; i++) {
      const agent = candidateAgents[i];
      
      // Check if agent is available
      if (!this.isAgentAvailable(agent)) {
        console.log(chalk.yellow(`⏳ ${agent.agent.name} is busy, skipping`));
        continue;
      }

      const assignment: TaskAssignment = {
        taskId: task.id,
        agentId: agent.agent.id,
        assignedAt: new Date(),
        estimatedCompletion: new Date(Date.now() + analysis.estimatedHours * 60 * 60 * 1000),
        confidence: this.calculateAssignmentConfidence(agent, analysis)
      };

      assignments.push(assignment);
      this.taskAssignments.set(`${task.id}-${agent.agent.id}`, assignment);
      
      // Update agent status
      agent.status = 'busy';
      agent.currentTasks.push(task);

      console.log(chalk.green(`✅ Assigned "${task.title}" to ${agent.agent.name}`));
      
      // Emit assignment event
      this.emit('taskAssigned', { task, agent, assignment });

      // If this is a high-priority task or the agent is primary, break
      if (task.priority === 'critical' || task.priority === 'high' || i === 0) {
        break;
      }
    }

    // Update task status
    task.status = 'in_progress';
    task.assignedTo = assignments.map(a => a.agentId);
    this.activeTasks.set(task.id, task);

    return assignments;
  }

  /**
   * Handle task completion
   */
  async completeTask(taskId: string, agentId: string, result: any): Promise<void> {
    const task = this.activeTasks.get(taskId);
    const agent = this.agents.get(agentId);
    const assignmentKey = `${taskId}-${agentId}`;
    const assignment = this.taskAssignments.get(assignmentKey);

    if (!task || !agent || !assignment) {
      console.log(chalk.red(`❌ Task completion error: Task/Agent/Assignment not found`));
      return;
    }

    console.log(chalk.green(`✅ Task completed: "${task.title}" by ${agent.agent.name}`));

    // Update task
    task.status = 'completed';
    task.actualHours = (Date.now() - assignment.assignedAt.getTime()) / (1000 * 60 * 60);

    // Update agent
    agent.status = 'idle';
    agent.currentTasks = agent.currentTasks.filter(t => t.id !== taskId);

    // Record performance
    this.recordAgentPerformance(assignment.agentId, assignment);

    // Clean up assignment
    this.taskAssignments.delete(assignmentKey);

    // Check if all assignees completed the task
    const allAssignments = Array.from(this.taskAssignments.values())
      .filter(a => a.taskId === taskId);

    if (allAssignments.length === 0) {
      this.activeTasks.delete(taskId);
      this.emit('taskFullyCompleted', { task, result });
      
      // Check for dependent tasks
      await this.checkDependentTasks(taskId);
    }
  }

  /**
   * Get current workload for all agents
   */
  getAgentWorkloads(): Map<string, AgentWorkload> {
    const workloads = new Map<string, AgentWorkload>();

    for (const agent of this.agents.values()) {
      const agentId = agent.agent.id;
      const history = this.workloadHistory.get(agentId) || [];
      
      const workload: AgentWorkload = {
        agentId,
        currentTasks: agent.currentTasks.length,
        maxTasks: agent.agent.maxConcurrentTasks,
        utilizationRate: agent.currentTasks.length / agent.agent.maxConcurrentTasks,
        averageTaskTime: this.calculateAverageTaskTime(history),
        successRate: this.calculateSuccessRate(agentId),
        specializations: agent.agent.specializations
      };

      workloads.set(agentId, workload);
    }

    return workloads;
  }

  /**
   * Rebalance workload if needed
   */
  async rebalanceWorkload(): Promise<void> {
    const workloads = this.getAgentWorkloads();
    const overloadedAgents = Array.from(workloads.values())
      .filter(w => w.utilizationRate > 0.8);
    const underutilizedAgents = Array.from(workloads.values())
      .filter(w => w.utilizationRate < 0.4);

    if (overloadedAgents.length > 0 && underutilizedAgents.length > 0) {
      console.log(chalk.yellow(`⚖️  Rebalancing workload: ${overloadedAgents.length} overloaded, ${underutilizedAgents.length} underutilized`));
      
      // Logic for reassigning tasks would go here
      this.emit('workloadRebalanced', { overloadedAgents, underutilizedAgents });
    }
  }

  /**
   * Get recommendations for task priority adjustments
   */
  getTaskPriorityRecommendations(): string[] {
    const recommendations: string[] = [];
    const workloads = this.getAgentWorkloads();

    // Check for bottlenecks
    const criticalRoles = ['Project Coordinator', 'System Architect'];
    for (const role of criticalRoles) {
      const agent = Array.from(this.agents.values()).find(a => a.agent.role === role);
      if (agent) {
        const workload = workloads.get(agent.agent.id);
        if (workload && workload.utilizationRate > 0.9) {
          recommendations.push(`Consider reducing workload for ${role} (${agent.agent.name}) - currently at ${Math.round(workload.utilizationRate * 100)}% capacity`);
        }
      }
    }

    // Check for idle agents
    const idleAgents = Array.from(workloads.values()).filter(w => w.utilizationRate === 0);
    if (idleAgents.length > 0) {
      recommendations.push(`${idleAgents.length} agents are idle - consider assigning more tasks or reviewing task distribution`);
    }

    return recommendations;
  }

  // Private helper methods

  private calculateComplexity(task: Task): number {
    let complexity = 5; // Base complexity

    // Adjust based on description keywords
    const description = task.description.toLowerCase();
    const complexKeywords = ['architecture', 'system', 'integration', 'migration', 'optimization'];
    const simpleKeywords = ['fix', 'update', 'style', 'text', 'format'];

    complexKeywords.forEach(keyword => {
      if (description.includes(keyword)) complexity += 1;
    });

    simpleKeywords.forEach(keyword => {
      if (description.includes(keyword)) complexity -= 1;
    });

    // Adjust based on dependencies
    if (task.dependencies && task.dependencies.length > 0) {
      complexity += task.dependencies.length * 0.5;
    }

    return Math.max(1, Math.min(10, Math.round(complexity)));
  }

  private estimateHours(task: Task): number {
    if (task.estimatedHours) return task.estimatedHours;

    const complexity = this.calculateComplexity(task);
    const baseHours = {
      low: 2,
      medium: 8, 
      high: 16,
      critical: 24
    };

    return (baseHours[task.priority] || 8) * (complexity / 5);
  }

  private extractRequiredSkills(task: Task): string[] {
    const skills: string[] = [];
    const description = task.description.toLowerCase();

    // Extract skills based on keywords
    for (const roleSkills of this.skillMatrix.values()) {
      for (const skill of roleSkills) {
        if (description.includes(skill.toLowerCase())) {
          skills.push(skill);
        }
      }
    }

    return [...new Set(skills)]; // Remove duplicates
  }

  private canBeParallelized(task: Task): boolean {
    const parallelKeywords = ['test', 'review', 'document', 'research'];
    const description = task.description.toLowerCase();
    
    return parallelKeywords.some(keyword => description.includes(keyword));
  }

  private calculateAgentScore(agent: AgentInstance, task: Task, analysis: TaskAnalysis): number {
    let score = 0;

    // Role match (most important factor)
    if (task.requiredRoles.includes(agent.agent.role)) {
      score += 50;
    }

    // Skill match
    const agentSkills = this.skillMatrix.get(agent.agent.role) || [];
    const skillMatches = analysis.requiredSkills.filter(skill => 
      agentSkills.some(agentSkill => agentSkill.toLowerCase().includes(skill.toLowerCase()))
    );
    score += skillMatches.length * 10;

    // Specialization match
    const specializationMatches = agent.agent.specializations.filter(spec =>
      analysis.requiredSkills.some(skill => skill.toLowerCase().includes(spec.toLowerCase()))
    );
    score += specializationMatches.length * 15;

    // Availability (current workload)
    const utilizationRate = agent.currentTasks.length / agent.agent.maxConcurrentTasks;
    score += (1 - utilizationRate) * 20;

    // Priority bonus for Project Coordinator on high-priority tasks
    if (agent.agent.role === 'Project Coordinator' && 
        (task.priority === 'critical' || task.priority === 'high')) {
      score += 25;
    }

    // Recent performance (if available)
    const performanceBonus = this.getPerformanceBonus(agent.agent.id);
    score += performanceBonus;

    return Math.max(0, score);
  }

  private getAssignmentReasons(agent: AgentInstance, task: Task, analysis: TaskAnalysis): string[] {
    const reasons: string[] = [];

    if (task.requiredRoles.includes(agent.agent.role)) {
      reasons.push('Role match');
    }

    const agentSkills = this.skillMatrix.get(agent.agent.role) || [];
    const skillMatches = analysis.requiredSkills.filter(skill => 
      agentSkills.some(agentSkill => agentSkill.toLowerCase().includes(skill.toLowerCase()))
    );
    if (skillMatches.length > 0) {
      reasons.push(`Skills: ${skillMatches.join(', ')}`);
    }

    const utilizationRate = agent.currentTasks.length / agent.agent.maxConcurrentTasks;
    if (utilizationRate < 0.5) {
      reasons.push('Available');
    } else if (utilizationRate < 0.8) {
      reasons.push('Moderate load');
    }

    if (agent.agent.priority <= 2) {
      reasons.push('High priority agent');
    }

    return reasons;
  }

  private isAgentAvailable(agent: AgentInstance): boolean {
    return agent.status === 'idle' && 
           agent.currentTasks.length < agent.agent.maxConcurrentTasks;
  }

  private calculateAssignmentConfidence(agent: AgentInstance, analysis: TaskAnalysis): number {
    let confidence = 0.5; // Base confidence

    // Increase confidence based on skill match
    const agentSkills = this.skillMatrix.get(agent.agent.role) || [];
    const skillMatchRate = analysis.requiredSkills.filter(skill => 
      agentSkills.some(agentSkill => agentSkill.toLowerCase().includes(skill.toLowerCase()))
    ).length / Math.max(analysis.requiredSkills.length, 1);

    confidence += skillMatchRate * 0.3;

    // Adjust based on workload
    const utilizationRate = agent.currentTasks.length / agent.agent.maxConcurrentTasks;
    confidence += (1 - utilizationRate) * 0.2;

    return Math.min(1, confidence);
  }

  private recordAgentPerformance(agentId: string, assignment: TaskAssignment): void {
    const history = this.workloadHistory.get(agentId) || [];
    const actualTime = Date.now() - assignment.assignedAt.getTime();
    
    history.push(actualTime);
    
    // Keep only last 20 records
    if (history.length > 20) {
      history.shift();
    }
    
    this.workloadHistory.set(agentId, history);
  }

  private calculateAverageTaskTime(history: number[]): number {
    if (history.length === 0) return 0;
    return history.reduce((sum, time) => sum + time, 0) / history.length;
  }

  private calculateSuccessRate(_agentId: string): number {
    // This would be based on completed vs failed tasks
    // For now, return a default value
    return 0.9;
  }

  private getPerformanceBonus(agentId: string): number {
    const successRate = this.calculateSuccessRate(agentId);
    return (successRate - 0.5) * 20; // -10 to +10 bonus
  }

  private async checkDependentTasks(completedTaskId: string): Promise<void> {
    // Find tasks that depend on the completed task
    const dependentTasks = Array.from(this.activeTasks.values())
      .filter(task => task.dependencies.includes(completedTaskId) && task.status === 'pending');

    for (const task of dependentTasks) {
      // Check if all dependencies are completed
      const allDepsCompleted = task.dependencies.every(depId => 
        !this.activeTasks.has(depId) // Not in active tasks means completed
      );

      if (allDepsCompleted) {
        console.log(chalk.blue(`🔓 Dependencies met for task: ${task.title}`));
        await this.assignTask(task);
      }
    }
  }
}