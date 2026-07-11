/**
 * Quality Gate Manager - Implements PM verification checklist and quality standards
 * Based on communication-enforce.md quality assurance protocols
 */

import { EventEmitter } from 'events';
import chalk from 'chalk';
import { AgentRole } from './team-types';

export interface QualityChecklist {
  codeTests: QualityCheck;
  errorHandling: QualityCheck;
  performance: QualityCheck;
  security: QualityCheck;
  documentation: QualityCheck;
  technicalDebt: QualityCheck;
}

export interface QualityCheck {
  required: boolean;
  status: QualityStatus;
  evidence: string[];
  threshold: number; // 0-1 for pass/fail
  actualValue?: number;
  notes: string;
  verifiedBy?: string;
  verifiedAt?: Date;
}

export type QualityStatus = 'pending' | 'in_progress' | 'passed' | 'failed' | 'not_applicable';

export interface QualityGate {
  id: string;
  name: string;
  phase: ProjectPhase;
  checklist: QualityChecklist;
  overallStatus: QualityStatus;
  requiredBy: AgentRole[];
  blockingFor: AgentRole[];
  createdAt: Date;
  completedAt?: Date;
}

export type ProjectPhase = 
  | 'requirements'
  | 'design'
  | 'implementation'
  | 'testing'
  | 'integration'
  | 'deployment'
  | 'maintenance';

export interface QualityMetrics {
  testCoverage: number; // percentage
  performanceScore: number; // 0-100
  securityScore: number; // 0-100
  maintainabilityIndex: number; // 0-100
  technicalDebtRatio: number; // 0-1
  documentationCoverage: number; // percentage
}

export interface QualityStandards {
  minTestCoverage: number;
  maxResponseTime: number; // milliseconds
  minSecurityScore: number;
  maxTechnicalDebtRatio: number;
  minDocumentationCoverage: number;
  codeQualityThreshold: number;
}

export class QualityGateManager extends EventEmitter {
  private qualityGates: Map<string, QualityGate> = new Map();
  private qualityStandards: QualityStandards;
  private metricsHistory: Map<string, QualityMetrics[]> = new Map();
  private automatedChecks: Map<string, NodeJS.Timeout> = new Map();

  // Default quality standards
  private readonly DEFAULT_STANDARDS: QualityStandards = {
    minTestCoverage: 80, // 80% minimum test coverage
    maxResponseTime: 500, // 500ms max response time
    minSecurityScore: 85, // 85/100 minimum security score
    maxTechnicalDebtRatio: 0.1, // 10% max technical debt ratio
    minDocumentationCoverage: 70, // 70% documentation coverage
    codeQualityThreshold: 0.8 // 80% code quality threshold
  };

  constructor(standards?: Partial<QualityStandards>) {
    super();
    this.qualityStandards = {
      ...this.DEFAULT_STANDARDS,
      ...standards
    };
  }

  /**
   * Create a new quality gate for a project phase
   */
  createQualityGate(
    id: string,
    name: string,
    phase: ProjectPhase,
    requiredBy: AgentRole[],
    blockingFor: AgentRole[] = []
  ): QualityGate {
    const gate: QualityGate = {
      id,
      name,
      phase,
      checklist: this.generatePhaseChecklist(phase),
      overallStatus: 'pending',
      requiredBy,
      blockingFor,
      createdAt: new Date()
    };

    this.qualityGates.set(id, gate);
    
    this.emit('qualityGateCreated', {
      gateId: id,
      phase,
      requiredBy,
      timestamp: new Date()
    });

    console.log(chalk.blue(`🚪 Quality gate created: ${name} (${phase})`));
    return gate;
  }

  /**
   * Generate phase-specific quality checklist
   */
  private generatePhaseChecklist(phase: ProjectPhase): QualityChecklist {
    const baseChecklist: QualityChecklist = {
      codeTests: {
        required: true,
        status: 'pending',
        evidence: [],
        threshold: this.qualityStandards.minTestCoverage / 100,
        notes: 'All code must have comprehensive test coverage'
      },
      errorHandling: {
        required: true,
        status: 'pending',
        evidence: [],
        threshold: 0.9,
        notes: 'Comprehensive error handling and graceful degradation'
      },
      performance: {
        required: true,
        status: 'pending',
        evidence: [],
        threshold: this.qualityStandards.maxResponseTime,
        notes: 'Performance must meet acceptable thresholds'
      },
      security: {
        required: true,
        status: 'pending',
        evidence: [],
        threshold: this.qualityStandards.minSecurityScore / 100,
        notes: 'Security best practices and vulnerability scanning'
      },
      documentation: {
        required: true,
        status: 'pending',
        evidence: [],
        threshold: this.qualityStandards.minDocumentationCoverage / 100,
        notes: 'Complete and up-to-date documentation'
      },
      technicalDebt: {
        required: true,
        status: 'pending',
        evidence: [],
        threshold: this.qualityStandards.maxTechnicalDebtRatio,
        notes: 'Technical debt must be within acceptable limits'
      }
    };

    // Customize checklist based on phase
    switch (phase) {
      case 'requirements':
        baseChecklist.codeTests.required = false;
        baseChecklist.performance.required = false;
        break;
      
      case 'design':
        baseChecklist.codeTests.required = false;
        break;
      
      case 'implementation':
        // All checks required
        break;
      
      case 'testing':
        baseChecklist.codeTests.threshold = 0.95; // Higher test coverage in testing phase
        break;
      
      case 'deployment':
        baseChecklist.performance.threshold = this.qualityStandards.maxResponseTime * 0.8; // Stricter performance
        break;
    }

    return baseChecklist;
  }

  /**
   * Update quality check status with evidence
   */
  updateQualityCheck(
    gateId: string,
    checkType: keyof QualityChecklist,
    status: QualityStatus,
    evidence: string[],
    actualValue?: number,
    verifiedBy?: string
  ): boolean {
    const gate = this.qualityGates.get(gateId);
    if (!gate) {
      console.error(chalk.red(`❌ Quality gate not found: ${gateId}`));
      return false;
    }

    const check = gate.checklist[checkType];
    check.status = status;
    check.evidence.push(...evidence);
    check.actualValue = actualValue;
    check.verifiedBy = verifiedBy;
    check.verifiedAt = new Date();

    // Validate against threshold
    if (actualValue !== undefined && status === 'passed') {
      const meetsThreshold = this.validateThreshold(checkType, actualValue, check.threshold);
      if (!meetsThreshold) {
        check.status = 'failed';
        check.notes += ` | Failed threshold: ${actualValue} vs required ${check.threshold}`;
      }
    }

    // Update overall gate status
    this.updateGateStatus(gateId);

    this.emit('qualityCheckUpdated', {
      gateId,
      checkType,
      status,
      actualValue,
      verifiedBy,
      timestamp: new Date()
    });

    console.log(chalk.green(`✅ Quality check updated: ${checkType} = ${status}`));
    return true;
  }

  /**
   * Validate if actual value meets threshold requirements
   */
  private validateThreshold(checkType: keyof QualityChecklist, actualValue: number, threshold: number): boolean {
    switch (checkType) {
      case 'codeTests':
      case 'documentation':
      case 'security':
        return actualValue >= threshold; // Higher is better
      
      case 'performance':
        return actualValue <= threshold; // Lower is better (response time)
      
      case 'technicalDebt':
        return actualValue <= threshold; // Lower is better (debt ratio)
      
      case 'errorHandling':
        return actualValue >= threshold; // Higher is better (coverage)
      
      default:
        return true;
    }
  }

  /**
   * Update overall quality gate status
   */
  private updateGateStatus(gateId: string): void {
    const gate = this.qualityGates.get(gateId);
    if (!gate) return;

    const checks = Object.values(gate.checklist);
    const requiredChecks = checks.filter(check => check.required);
    
    if (requiredChecks.every(check => check.status === 'passed')) {
      gate.overallStatus = 'passed';
      gate.completedAt = new Date();
      
      this.emit('qualityGatePassed', {
        gateId,
        phase: gate.phase,
        completedAt: gate.completedAt,
        timestamp: new Date()
      });
      
      console.log(chalk.green(`🎉 Quality gate PASSED: ${gate.name}`));
      
    } else if (requiredChecks.some(check => check.status === 'failed')) {
      gate.overallStatus = 'failed';
      
      this.emit('qualityGateFailed', {
        gateId,
        phase: gate.phase,
        failedChecks: this.getFailedChecks(gate),
        timestamp: new Date()
      });
      
      console.log(chalk.red(`❌ Quality gate FAILED: ${gate.name}`));
      
    } else if (requiredChecks.some(check => check.status === 'in_progress')) {
      gate.overallStatus = 'in_progress';
    }
  }

  /**
   * Get failed quality checks for a gate
   */
  private getFailedChecks(gate: QualityGate): Array<{type: keyof QualityChecklist, reason: string}> {
    return Object.entries(gate.checklist)
      .filter(([_, check]) => check.required && check.status === 'failed')
      .map(([type, check]) => ({
        type: type as keyof QualityChecklist,
        reason: check.notes
      }));
  }

  /**
   * Run automated quality checks
   */
  async runAutomatedChecks(gateId: string, projectPath: string): Promise<QualityMetrics> {
    console.log(chalk.blue(`🔍 Running automated quality checks for gate: ${gateId}`));
    
    const metrics: QualityMetrics = {
      testCoverage: 0,
      performanceScore: 0,
      securityScore: 0,
      maintainabilityIndex: 0,
      technicalDebtRatio: 0,
      documentationCoverage: 0
    };

    try {
      // Test coverage check
      metrics.testCoverage = await this.checkTestCoverage(projectPath);
      this.updateQualityCheck(gateId, 'codeTests', 
        metrics.testCoverage >= this.qualityStandards.minTestCoverage ? 'passed' : 'failed',
        [`Test coverage: ${metrics.testCoverage}%`],
        metrics.testCoverage,
        'AutomatedChecker'
      );

      // Performance check
      metrics.performanceScore = await this.checkPerformance(projectPath);
      this.updateQualityCheck(gateId, 'performance',
        metrics.performanceScore <= this.qualityStandards.maxResponseTime ? 'passed' : 'failed',
        [`Average response time: ${metrics.performanceScore}ms`],
        metrics.performanceScore,
        'AutomatedChecker'
      );

      // Security check
      metrics.securityScore = await this.checkSecurity(projectPath);
      this.updateQualityCheck(gateId, 'security',
        metrics.securityScore >= this.qualityStandards.minSecurityScore ? 'passed' : 'failed',
        [`Security score: ${metrics.securityScore}/100`],
        metrics.securityScore,
        'AutomatedChecker'
      );

      // Documentation coverage
      metrics.documentationCoverage = await this.checkDocumentation(projectPath);
      this.updateQualityCheck(gateId, 'documentation',
        metrics.documentationCoverage >= this.qualityStandards.minDocumentationCoverage ? 'passed' : 'failed',
        [`Documentation coverage: ${metrics.documentationCoverage}%`],
        metrics.documentationCoverage,
        'AutomatedChecker'
      );

      // Technical debt analysis
      metrics.technicalDebtRatio = await this.analyzeTechnicalDebt(projectPath);
      this.updateQualityCheck(gateId, 'technicalDebt',
        metrics.technicalDebtRatio <= this.qualityStandards.maxTechnicalDebtRatio ? 'passed' : 'failed',
        [`Technical debt ratio: ${(metrics.technicalDebtRatio * 100).toFixed(1)}%`],
        metrics.technicalDebtRatio,
        'AutomatedChecker'
      );

      // Store metrics history
      if (!this.metricsHistory.has(gateId)) {
        this.metricsHistory.set(gateId, []);
      }
      this.metricsHistory.get(gateId)!.push(metrics);

      console.log(chalk.green(`📊 Automated checks completed for gate: ${gateId}`));
      return metrics;

    } catch (error) {
      console.error(chalk.red(`❌ Automated checks failed: ${error}`));
      throw error;
    }
  }

  /**
   * Check test coverage (mock implementation)
   */
  private async checkTestCoverage(projectPath: string): Promise<number> {
    // In a real implementation, this would run test coverage tools like Jest, nyc, etc.
    // For now, return a mock value
    return Math.random() * 40 + 60; // 60-100% range
  }

  /**
   * Check performance metrics (mock implementation)
   */
  private async checkPerformance(projectPath: string): Promise<number> {
    // In a real implementation, this would run performance benchmarks
    return Math.random() * 300 + 200; // 200-500ms range
  }

  /**
   * Check security score (mock implementation)
   */
  private async checkSecurity(projectPath: string): Promise<number> {
    // In a real implementation, this would run security scanners like npm audit, Snyk, etc.
    return Math.random() * 20 + 80; // 80-100 range
  }

  /**
   * Check documentation coverage (mock implementation)
   */
  private async checkDocumentation(projectPath: string): Promise<number> {
    // In a real implementation, this would analyze code comments, README files, etc.
    return Math.random() * 30 + 70; // 70-100% range
  }

  /**
   * Analyze technical debt (mock implementation)
   */
  private async analyzeTechnicalDebt(projectPath: string): Promise<number> {
    // In a real implementation, this would run code quality tools like SonarQube, CodeClimate
    return Math.random() * 0.15; // 0-15% range
  }

  /**
   * Generate quality gate report
   */
  generateQateReport(gateId: string): string {
    const gate = this.qualityGates.get(gateId);
    if (!gate) {
      return `Quality gate not found: ${gateId}`;
    }

    const report = `
# Quality Gate Report: ${gate.name}

**Phase:** ${gate.phase}
**Status:** ${gate.overallStatus.toUpperCase()}
**Created:** ${gate.createdAt.toISOString()}
${gate.completedAt ? `**Completed:** ${gate.completedAt.toISOString()}` : ''}

## Quality Checklist

${Object.entries(gate.checklist).map(([type, check]) => `
### ${type.charAt(0).toUpperCase() + type.slice(1).replace(/([A-Z])/g, ' $1')}
- **Status:** ${check.status}
- **Required:** ${check.required ? 'Yes' : 'No'}
- **Threshold:** ${check.threshold}
${check.actualValue !== undefined ? `- **Actual Value:** ${check.actualValue}` : ''}
${check.verifiedBy ? `- **Verified By:** ${check.verifiedBy}` : ''}
${check.verifiedAt ? `- **Verified At:** ${check.verifiedAt.toISOString()}` : ''}
- **Evidence:**
${check.evidence.map(e => `  - ${e}`).join('\n')}
- **Notes:** ${check.notes}
`).join('\n')}

## Standards Applied
- **Min Test Coverage:** ${this.qualityStandards.minTestCoverage}%
- **Max Response Time:** ${this.qualityStandards.maxResponseTime}ms
- **Min Security Score:** ${this.qualityStandards.minSecurityScore}/100
- **Max Technical Debt:** ${(this.qualityStandards.maxTechnicalDebtRatio * 100).toFixed(1)}%
- **Min Documentation:** ${this.qualityStandards.minDocumentationCoverage}%
`;

    return report.trim();
  }

  /**
   * Get blocking information for agents
   */
  getBlockingGates(agentRole: AgentRole): QualityGate[] {
    return Array.from(this.qualityGates.values())
      .filter(gate => 
        gate.blockingFor.includes(agentRole) && 
        gate.overallStatus !== 'passed'
      );
  }

  /**
   * Check if agent can proceed past quality gates
   */
  canAgentProceed(agentRole: AgentRole, phase: ProjectPhase): {
    canProceed: boolean;
    blockingGates: QualityGate[];
    reason?: string;
  } {
    const blockingGates = this.getBlockingGates(agentRole);
    const phaseBlockers = blockingGates.filter(gate => gate.phase === phase);

    if (phaseBlockers.length > 0) {
      return {
        canProceed: false,
        blockingGates: phaseBlockers,
        reason: `Blocked by ${phaseBlockers.length} quality gate(s) in ${phase} phase`
      };
    }

    return {
      canProceed: true,
      blockingGates: []
    };
  }

  /**
   * Get quality statistics
   */
  getQualityStatistics(): {
    totalGates: number;
    passedGates: number;
    failedGates: number;
    averagePassRate: number;
    phaseBreakdown: Record<ProjectPhase, number>;
  } {
    const gates = Array.from(this.qualityGates.values());
    const passedGates = gates.filter(g => g.overallStatus === 'passed').length;
    const failedGates = gates.filter(g => g.overallStatus === 'failed').length;
    
    const phaseBreakdown = gates.reduce((acc, gate) => {
      acc[gate.phase] = (acc[gate.phase] || 0) + 1;
      return acc;
    }, {} as Record<ProjectPhase, number>);

    return {
      totalGates: gates.length,
      passedGates,
      failedGates,
      averagePassRate: gates.length > 0 ? passedGates / gates.length : 0,
      phaseBreakdown
    };
  }

  /**
   * Schedule continuous quality monitoring
   */
  startContinuousMonitoring(gateId: string, intervalMinutes: number = 30): void {
    const interval = setInterval(async () => {
      const gate = this.qualityGates.get(gateId);
      if (!gate || gate.overallStatus === 'passed') {
        this.stopContinuousMonitoring(gateId);
        return;
      }

      try {
        await this.runAutomatedChecks(gateId, ''); // Would need project path
        console.log(chalk.blue(`🔄 Continuous monitoring check completed for gate: ${gateId}`));
      } catch (error) {
        console.error(chalk.red(`❌ Continuous monitoring failed for gate ${gateId}: ${error}`));
      }
    }, intervalMinutes * 60 * 1000);

    this.automatedChecks.set(gateId, interval);
    console.log(chalk.green(`📡 Started continuous monitoring for gate: ${gateId} (${intervalMinutes}min intervals)`));
  }

  /**
   * Stop continuous quality monitoring
   */
  stopContinuousMonitoring(gateId: string): void {
    const interval = this.automatedChecks.get(gateId);
    if (interval) {
      clearInterval(interval);
      this.automatedChecks.delete(gateId);
      console.log(chalk.yellow(`⏹️  Stopped continuous monitoring for gate: ${gateId}`));
    }
  }

  /**
   * Cleanup - stop all monitoring
   */
  cleanup(): void {
    for (const [gateId, interval] of this.automatedChecks.entries()) {
      clearInterval(interval);
    }
    this.automatedChecks.clear();
    console.log(chalk.blue('🧹 Quality gate monitoring cleanup completed'));
  }
}