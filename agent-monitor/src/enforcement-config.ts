/**
 * Enhanced Team Orchestrator Configuration
 * Includes all enforcement and quality management settings
 */

import { GitDisciplineConfig } from './git-discipline-enforcer';
import { NamingConvention } from './terminal-naming-manager';
import { QualityStandards } from './quality-gate-manager';
import { TeamConfiguration } from './team-types';

export interface EnforcementConfiguration {
  // Git discipline enforcement
  gitDiscipline: GitDisciplineConfig & {
    enabled: boolean;
    pmResponsibilities: boolean; // PM enforces git discipline
    emergencyRecoveryMode: boolean;
  };

  // Terminal naming management
  terminalNaming: NamingConvention & {
    enabled: boolean;
    autoPromptOnStartup: boolean;
    minimumConfidence: number;
    customPatterns: Record<string, RegExp[]>;
  };

  // Communication protocol enforcement
  communicationProtocol: {
    enabled: boolean;
    enforceTemplates: boolean;
    hubAndSpokeStrict: boolean;
    antiPatternDetection: boolean;
    maxExchangesBeforeEscalation: number;
    rateLimitEnabled: boolean;
    broadcastPreventionEnabled: boolean;
  };

  // Quality gate management
  qualityGates: QualityStandards & {
    enabled: boolean;
    automatedChecksEnabled: boolean;
    continuousMonitoringEnabled: boolean;
    blockingEnabled: boolean; // Block agents if gates fail
    pmVerificationRequired: boolean;
  };

  // Project lifecycle management
  projectLifecycle: {
    enabled: boolean;
    projectDiscoveryEnabled: boolean;
    autoProjectStartup: boolean;
    systematicBriefingEnabled: boolean;
    defaultProjectsPath: string;
  };

  // Anti-pattern prevention
  antiPatternPrevention: {
    enabled: boolean;
    meetingPreventionEnabled: boolean;
    micromanagementDetectionEnabled: boolean;
    escalationTimeoutEnabled: boolean;
    qualityShortcutPrevention: boolean;
  };

  // Human interaction settings
  humanInteraction: {
    pauseResumeEnabled: boolean;
    confirmationRequired: boolean;
    notificationChannels: string[];
    escalationToHuman: boolean;
  };
}

export interface EnhancedTeamConfiguration extends TeamConfiguration {
  enforcement: EnforcementConfiguration;
  qualityStandards?: QualityStandards;
  customRules?: CustomRule[];
}

export interface CustomRule {
  id: string;
  name: string;
  description: string;
  condition: string; // JavaScript condition
  action: RuleAction;
  severity: 'low' | 'medium' | 'high' | 'critical';
  enabled: boolean;
}

export interface RuleAction {
  type: 'notify' | 'block' | 'escalate' | 'auto-fix';
  parameters: Record<string, any>;
  message?: string;
}

/**
 * Default enforcement configuration
 */
export const DEFAULT_ENFORCEMENT_CONFIG: EnforcementConfiguration = {
  gitDiscipline: {
    enabled: true,
    autoCommitInterval: 30 * 60 * 1000, // 30 minutes
    maxWorkTimeWithoutCommit: 60 * 60 * 1000, // 1 hour
    enforceFeatureBranches: true,
    requireMeaningfulCommits: true,
    commitReminderEnabled: true,
    emergencyRecoveryEnabled: true,
    pmResponsibilities: true,
    emergencyRecoveryMode: false
  },

  terminalNaming: {
    enabled: true,
    agentPattern: 'Claude-{role}',
    servicePattern: '{service}-Dev',
    shellPattern: '{project}-Shell',
    autoRename: true,
    promptUser: true,
    autoPromptOnStartup: true,
    minimumConfidence: 0.6,
    customPatterns: {}
  },

  communicationProtocol: {
    enabled: true,
    enforceTemplates: true,
    hubAndSpokeStrict: true,
    antiPatternDetection: true,
    maxExchangesBeforeEscalation: 3,
    rateLimitEnabled: true,
    broadcastPreventionEnabled: true
  },

  qualityGates: {
    enabled: true,
    minTestCoverage: 80,
    maxResponseTime: 500,
    minSecurityScore: 85,
    maxTechnicalDebtRatio: 0.1,
    minDocumentationCoverage: 70,
    codeQualityThreshold: 0.8,
    automatedChecksEnabled: true,
    continuousMonitoringEnabled: true,
    blockingEnabled: true,
    pmVerificationRequired: true
  },

  projectLifecycle: {
    enabled: true,
    projectDiscoveryEnabled: true,
    autoProjectStartup: true,
    systematicBriefingEnabled: true,
    defaultProjectsPath: '~/Coding'
  },

  antiPatternPrevention: {
    enabled: true,
    meetingPreventionEnabled: true,
    micromanagementDetectionEnabled: true,
    escalationTimeoutEnabled: true,
    qualityShortcutPrevention: true
  },

  humanInteraction: {
    pauseResumeEnabled: true,
    confirmationRequired: false,
    notificationChannels: ['discord', 'console'],
    escalationToHuman: true
  }
};

/**
 * Validation functions for configuration
 */
export class ConfigurationValidator {
  static validateEnforcementConfig(config: EnforcementConfiguration): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Git discipline validation
    if (config.gitDiscipline.enabled) {
      if (config.gitDiscipline.autoCommitInterval < 5 * 60 * 1000) {
        warnings.push('Git auto-commit interval is very short (< 5 minutes)');
      }
      if (config.gitDiscipline.maxWorkTimeWithoutCommit > 2 * 60 * 60 * 1000) {
        warnings.push('Max work time without commit is very long (> 2 hours)');
      }
    }

    // Quality gates validation
    if (config.qualityGates.enabled) {
      if (config.qualityGates.minTestCoverage > 100) {
        errors.push('Minimum test coverage cannot exceed 100%');
      }
      if (config.qualityGates.minSecurityScore > 100) {
        errors.push('Minimum security score cannot exceed 100');
      }
    }

    // Communication protocol validation
    if (config.communicationProtocol.enabled) {
      if (config.communicationProtocol.maxExchangesBeforeEscalation < 1) {
        errors.push('Max exchanges before escalation must be at least 1');
      }
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }

  static validateTeamConfiguration(config: EnhancedTeamConfiguration): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Basic team configuration validation
    if (!config.teamConfig.projectName) {
      errors.push('Project name is required');
    }
    if (!config.teamConfig.projectFolder) {
      errors.push('Project folder is required');
    }
    if (config.agents.length === 0) {
      errors.push('At least one agent is required');
    }

    // Agent validation
    for (const agent of config.agents) {
      if (!agent.id || !agent.name || !agent.role) {
        errors.push(`Agent ${agent.id || 'unknown'} is missing required fields`);
      }
    }

    // Enforcement configuration validation
    if (config.enforcement) {
      const enforcementValidation = this.validateEnforcementConfig(config.enforcement);
      errors.push(...enforcementValidation.errors);
      warnings.push(...enforcementValidation.warnings);
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}

/**
 * Configuration utilities
 */
export class ConfigurationUtils {
  /**
   * Merge configuration with defaults
   */
  static mergeWithDefaults(
    config: Partial<EnforcementConfiguration>
  ): EnforcementConfiguration {
    return {
      gitDiscipline: {
        ...DEFAULT_ENFORCEMENT_CONFIG.gitDiscipline,
        ...config.gitDiscipline
      },
      terminalNaming: {
        ...DEFAULT_ENFORCEMENT_CONFIG.terminalNaming,
        ...config.terminalNaming
      },
      communicationProtocol: {
        ...DEFAULT_ENFORCEMENT_CONFIG.communicationProtocol,
        ...config.communicationProtocol
      },
      qualityGates: {
        ...DEFAULT_ENFORCEMENT_CONFIG.qualityGates,
        ...config.qualityGates
      },
      projectLifecycle: {
        ...DEFAULT_ENFORCEMENT_CONFIG.projectLifecycle,
        ...config.projectLifecycle
      },
      antiPatternPrevention: {
        ...DEFAULT_ENFORCEMENT_CONFIG.antiPatternPrevention,
        ...config.antiPatternPrevention
      },
      humanInteraction: {
        ...DEFAULT_ENFORCEMENT_CONFIG.humanInteraction,
        ...config.humanInteraction
      }
    };
  }

  /**
   * Generate configuration template
   */
  static generateConfigTemplate(): EnhancedTeamConfiguration {
    return {
      teamConfig: {
        projectName: 'My Project',
        projectFolder: '/path/to/project',
        chatHubChannel: 1,
        requirementsFolder: '/docs',
        maxIdleTime: 300,
        heartbeatInterval: 120
      },
      agents: [
        {
          id: 'coordinator-001',
          name: 'Project Coordinator',
          role: 'Project Coordinator',
          aiType: 'Claude',
          model: 'sonnet',
          cliCommand: 'npx claude-code',
          priority: 1,
          specializations: ['Project Management', 'Team Coordination'],
          maxConcurrentTasks: 5,
          kickoffPrompt: 'You are the Project Coordinator responsible for team coordination and quality assurance.'
        }
      ],
      enforcement: DEFAULT_ENFORCEMENT_CONFIG
    };
  }

  /**
   * Export configuration as JSON
   */
  static exportConfiguration(config: EnhancedTeamConfiguration): string {
    return JSON.stringify(config, null, 2);
  }

  /**
   * Import configuration from JSON
   */
  static importConfiguration(jsonString: string): EnhancedTeamConfiguration {
    const config = JSON.parse(jsonString) as EnhancedTeamConfiguration;
    
    // Ensure enforcement config has defaults
    if (!config.enforcement) {
      config.enforcement = DEFAULT_ENFORCEMENT_CONFIG;
    } else {
      config.enforcement = this.mergeWithDefaults(config.enforcement);
    }

    return config;
  }
}