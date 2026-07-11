/**
 * Terminal Naming Manager - Implements descriptive terminal naming
 * Based on communication-enforce.md startup behavior requirements
 */

import { EventEmitter } from 'events';
import chalk from 'chalk';
import { AgentRole } from './team-types';
import { AutoTerminalClient } from './api-client';

export interface NamingConvention {
  agentPattern: string; // "Claude-{role}" 
  servicePattern: string; // "{service}-Dev"
  shellPattern: string; // "{project}-Shell"
  autoRename: boolean;
  promptUser: boolean;
}

export interface TerminalAnalysis {
  terminalId: string;
  currentName: string;
  detectedPurpose: TerminalPurpose;
  suggestedName: string;
  confidence: number; // 0-1 score
  evidence: string[];
}

export type TerminalPurpose = 
  | 'claude-agent'
  | 'dev-server'
  | 'shell-utility'
  | 'service'
  | 'orchestrator'
  | 'testing'
  | 'database'
  | 'unknown';

export interface NamingRule {
  purpose: TerminalPurpose;
  detectionPatterns: RegExp[];
  namingTemplate: string;
  priority: number;
}

export class TerminalNamingManager extends EventEmitter {
  private client: AutoTerminalClient;
  private namingConvention: NamingConvention;
  private namingRules: NamingRule[];
  private terminalAnalyses: Map<string, TerminalAnalysis> = new Map();
  
  // Detection patterns for different terminal purposes
  private readonly DETECTION_PATTERNS = {
    claude: [
      /claude.*code/i,
      /npx.*claude/i,
      /claude.*cli/i,
      /claude.*assistant/i
    ],
    devServer: [
      /npm.*start/i,
      /npm.*dev/i,
      /yarn.*start/i,
      /yarn.*dev/i,
      /next.*dev/i,
      /react.*scripts.*start/i,
      /uvicorn/i,
      /flask.*run/i,
      /django.*runserver/i
    ],
    shell: [
      /^(?!.*claude).*sh$/i,
      /^(?!.*npm).*bash$/i,
      /^(?!.*yarn).*zsh$/i,
      /powershell/i,
      /cmd/i
    ],
    service: [
      /convex.*dev/i,
      /convex.*serve/i,
      /docker.*run/i,
      /docker.*compose/i,
      /kubernetes/i,
      /kubectl/i
    ],
    testing: [
      /jest/i,
      /mocha/i,
      /cypress/i,
      /playwright/i,
      /npm.*test/i,
      /yarn.*test/i
    ],
    database: [
      /mongodb/i,
      /postgres/i,
      /mysql/i,
      /redis/i,
      /sqlite/i
    ]
  };

  constructor(client: AutoTerminalClient, convention?: Partial<NamingConvention>) {
    super();
    this.client = client;
    this.namingConvention = {
      agentPattern: 'Claude-{role}',
      servicePattern: '{service}-Dev',
      shellPattern: '{project}-Shell',
      autoRename: true,
      promptUser: true,
      ...convention
    };
    
    this.initializeNamingRules();
  }

  /**
   * Initialize naming rules with detection patterns
   */
  private initializeNamingRules(): void {
    this.namingRules = [
      {
        purpose: 'claude-agent',
        detectionPatterns: this.DETECTION_PATTERNS.claude,
        namingTemplate: 'Claude-{role}',
        priority: 10
      },
      {
        purpose: 'dev-server',
        detectionPatterns: this.DETECTION_PATTERNS.devServer,
        namingTemplate: '{service}-Dev',
        priority: 9
      },
      {
        purpose: 'service',
        detectionPatterns: this.DETECTION_PATTERNS.service,
        namingTemplate: '{service}-Server',
        priority: 8
      },
      {
        purpose: 'testing',
        detectionPatterns: this.DETECTION_PATTERNS.testing,
        namingTemplate: '{project}-Tests',
        priority: 7
      },
      {
        purpose: 'database',
        detectionPatterns: this.DETECTION_PATTERNS.database,
        namingTemplate: '{database}-DB',
        priority: 6
      },
      {
        purpose: 'shell-utility',
        detectionPatterns: this.DETECTION_PATTERNS.shell,
        namingTemplate: '{project}-Shell',
        priority: 5
      },
      {
        purpose: 'orchestrator',
        detectionPatterns: [/orchestrator/i, /agent.*monitor/i],
        namingTemplate: 'Orchestrator',
        priority: 10
      }
    ];
  }

  /**
   * Prompt user for terminal renaming preference
   */
  async promptForRenaming(): Promise<boolean> {
    if (!this.namingConvention.promptUser) {
      return this.namingConvention.autoRename;
    }

    console.log(chalk.cyan('\n🏷️  Terminal Organization'));
    console.log(chalk.white('Would you like me to rename all terminals with descriptive names for better organization?'));
    console.log(chalk.gray('This will analyze each terminal\'s content and suggest meaningful names like:'));
    console.log(chalk.gray('  • Claude-Frontend, Claude-Backend, Claude-QA'));
    console.log(chalk.gray('  • NextJS-Dev, API-Server, Tests-Runner'));
    console.log(chalk.gray('  • Project-Shell, Database-Shell'));

    // For now, default to true. In a real implementation, you'd use readline or similar
    // to get user input. Since this is running in the agent monitor context,
    // we'll emit an event for the orchestrator to handle.
    
    this.emit('renamingPromptRequired', {
      message: 'Would you like me to rename all terminals with descriptive names?',
      options: ['yes', 'no'],
      defaultChoice: 'yes'
    });

    // Return default for now - this should be made interactive
    return true;
  }

  /**
   * Analyze all terminals and suggest names
   */
  async analyzeAllTerminals(): Promise<TerminalAnalysis[]> {
    try {
      console.log(chalk.blue('🔍 Analyzing terminals for naming opportunities...'));
      
      const terminals = await this.client.getTerminals();
      const analyses: TerminalAnalysis[] = [];

      for (const terminal of terminals) {
        const analysis = await this.analyzeTerminal(terminal.id, terminal.name);
        if (analysis) {
          analyses.push(analysis);
          this.terminalAnalyses.set(terminal.id, analysis);
        }
      }

      console.log(chalk.green(`✅ Analyzed ${analyses.length} terminals`));
      return analyses;
      
    } catch (error) {
      console.error(chalk.red(`❌ Failed to analyze terminals: ${error}`));
      return [];
    }
  }

  /**
   * Analyze individual terminal for naming
   */
  async analyzeTerminal(terminalId: string, currentName?: string): Promise<TerminalAnalysis | null> {
    try {
      // Get terminal output to analyze content
      const output = await this.client.getTerminalOutput(terminalId);
      const terminalInfo = await this.getTerminalInfo(terminalId);
      
      const analysis: TerminalAnalysis = {
        terminalId,
        currentName: currentName || terminalInfo?.name || 'Unknown',
        detectedPurpose: 'unknown',
        suggestedName: '',
        confidence: 0,
        evidence: []
      };

      // Analyze output for patterns
      const detectionResult = this.detectTerminalPurpose(output);
      analysis.detectedPurpose = detectionResult.purpose;
      analysis.confidence = detectionResult.confidence;
      analysis.evidence = detectionResult.evidence;

      // Generate suggested name
      analysis.suggestedName = this.generateSuggestedName(
        analysis.detectedPurpose,
        detectionResult.metadata
      );

      return analysis;

    } catch (error) {
      console.error(chalk.red(`❌ Failed to analyze terminal ${terminalId}: ${error}`));
      return null;
    }
  }

  /**
   * Detect terminal purpose from output content
   */
  private detectTerminalPurpose(output: string): {
    purpose: TerminalPurpose;
    confidence: number;
    evidence: string[];
    metadata: Record<string, string>;
  } {
    let bestMatch: {
      purpose: TerminalPurpose;
      confidence: number;
      evidence: string[];
      metadata: Record<string, string>;
    } = {
      purpose: 'unknown',
      confidence: 0,
      evidence: [],
      metadata: {}
    };

    // Check each naming rule
    for (const rule of this.namingRules) {
      const matchResult = this.checkRuleMatch(rule, output);
      if (matchResult.confidence > bestMatch.confidence) {
        bestMatch = {
          purpose: rule.purpose,
          confidence: matchResult.confidence,
          evidence: matchResult.evidence,
          metadata: matchResult.metadata
        };
      }
    }

    return bestMatch;
  }

  /**
   * Check if terminal output matches a naming rule
   */
  private checkRuleMatch(rule: NamingRule, output: string): {
    confidence: number;
    evidence: string[];
    metadata: Record<string, string>;
  } {
    const result = {
      confidence: 0,
      evidence: [],
      metadata: {}
    };

    let matchCount = 0;
    const outputLines = output.split('\n').slice(-50); // Check last 50 lines
    
    for (const pattern of rule.detectionPatterns) {
      for (const line of outputLines) {
        if (pattern.test(line)) {
          matchCount++;
          result.evidence.push(`Matched pattern: ${pattern.source} in "${line.trim()}"`);
          
          // Extract metadata based on the match
          this.extractMetadata(rule.purpose, line, result.metadata);
          break; // Only count each pattern once
        }
      }
    }

    // Calculate confidence based on matches and rule priority
    if (matchCount > 0) {
      result.confidence = Math.min(0.9, (matchCount / rule.detectionPatterns.length) * (rule.priority / 10));
    }

    return result;
  }

  /**
   * Extract metadata from matched lines
   */
  private extractMetadata(purpose: TerminalPurpose, line: string, metadata: Record<string, string>): void {
    switch (purpose) {
      case 'claude-agent':
        // Try to extract agent type or role
        if (line.includes('frontend')) metadata.role = 'Frontend';
        else if (line.includes('backend')) metadata.role = 'Backend';
        else if (line.includes('qa')) metadata.role = 'QA';
        else if (line.includes('architect')) metadata.role = 'Architect';
        else metadata.role = 'Agent';
        break;

      case 'dev-server':
        // Extract service type
        if (line.includes('next')) metadata.service = 'NextJS';
        else if (line.includes('react')) metadata.service = 'React';
        else if (line.includes('uvicorn')) metadata.service = 'API';
        else if (line.includes('flask')) metadata.service = 'Flask';
        else if (line.includes('django')) metadata.service = 'Django';
        else metadata.service = 'Dev';
        break;

      case 'service':
        // Extract service name
        if (line.includes('convex')) metadata.service = 'Convex';
        else if (line.includes('docker')) metadata.service = 'Docker';
        else metadata.service = 'Service';
        break;

      case 'database':
        // Extract database type
        if (line.includes('mongodb')) metadata.database = 'MongoDB';
        else if (line.includes('postgres')) metadata.database = 'PostgreSQL';
        else if (line.includes('mysql')) metadata.database = 'MySQL';
        else if (line.includes('redis')) metadata.database = 'Redis';
        else metadata.database = 'Database';
        break;

      case 'testing':
        // Extract test framework
        if (line.includes('jest')) metadata.framework = 'Jest';
        else if (line.includes('cypress')) metadata.framework = 'Cypress';
        else if (line.includes('playwright')) metadata.framework = 'Playwright';
        else metadata.framework = 'Tests';
        break;
    }
  }

  /**
   * Generate suggested name based on detected purpose
   */
  private generateSuggestedName(purpose: TerminalPurpose, metadata: Record<string, string>): string {
    const rule = this.namingRules.find(r => r.purpose === purpose);
    if (!rule) return 'Terminal';

    let template = rule.namingTemplate;
    
    // Replace template variables
    template = template.replace('{role}', metadata.role || 'Agent');
    template = template.replace('{service}', metadata.service || 'Service');
    template = template.replace('{project}', metadata.project || 'Project');
    template = template.replace('{database}', metadata.database || 'DB');
    template = template.replace('{framework}', metadata.framework || 'Tests');

    return template;
  }

  /**
   * Apply naming suggestions to terminals
   */
  async applyNamingSuggestions(analyses: TerminalAnalysis[], minConfidence: number = 0.6): Promise<void> {
    console.log(chalk.blue('🏷️  Applying terminal naming suggestions...'));
    
    let renamed = 0;
    let skipped = 0;

    for (const analysis of analyses) {
      if (analysis.confidence >= minConfidence && 
          analysis.suggestedName !== analysis.currentName) {
        
        try {
          await this.renameTerminal(analysis.terminalId, analysis.suggestedName);
          console.log(chalk.green(`✅ Renamed "${analysis.currentName}" → "${analysis.suggestedName}"`));
          renamed++;
          
          this.emit('terminalRenamed', {
            terminalId: analysis.terminalId,
            oldName: analysis.currentName,
            newName: analysis.suggestedName,
            confidence: analysis.confidence,
            purpose: analysis.detectedPurpose
          });
          
        } catch (error) {
          console.error(chalk.red(`❌ Failed to rename terminal ${analysis.terminalId}: ${error}`));
          skipped++;
        }
      } else {
        console.log(chalk.gray(`⏭️  Skipped "${analysis.currentName}" (confidence: ${analysis.confidence.toFixed(2)})`));
        skipped++;
      }
    }

    console.log(chalk.cyan(`\n📊 Naming Summary: ${renamed} renamed, ${skipped} skipped`));
  }

  /**
   * Rename a terminal through the API
   */
  private async renameTerminal(terminalId: string, newName: string): Promise<void> {
    // Note: This would need to be implemented in the Auto-Terminal API
    // For now, we'll emit an event that the orchestrator can handle
    this.emit('renameRequest', {
      terminalId,
      newName,
      timestamp: new Date()
    });
  }

  /**
   * Get terminal information
   */
  private async getTerminalInfo(terminalId: string): Promise<any> {
    try {
      const terminals = await this.client.getTerminals();
      return terminals.find(t => t.id === terminalId);
    } catch (error) {
      return null;
    }
  }

  /**
   * Generate naming convention examples
   */
  generateNamingExamples(): Record<string, string[]> {
    return {
      'Claude Agents': [
        'Claude-Frontend',
        'Claude-Backend', 
        'Claude-QA',
        'Claude-Architect',
        'Claude-DevOps'
      ],
      'Development Servers': [
        'NextJS-Dev',
        'React-Dev',
        'API-Server',
        'Flask-Dev',
        'Django-Dev'
      ],
      'Services': [
        'Convex-Server',
        'Docker-Container',
        'Database-Server',
        'Redis-Cache'
      ],
      'Utilities': [
        'Frontend-Shell',
        'Backend-Shell',
        'Project-Shell',
        'Testing-Shell'
      ],
      'Testing': [
        'Jest-Tests',
        'Cypress-E2E',
        'Playwright-Tests',
        'Unit-Tests'
      ]
    };
  }

  /**
   * Get naming statistics
   */
  getStatistics(): {
    totalAnalyzed: number;
    successfulDetections: number;
    averageConfidence: number;
    purposeBreakdown: Record<TerminalPurpose, number>;
  } {
    const analyses = Array.from(this.terminalAnalyses.values());
    const successfulDetections = analyses.filter(a => a.confidence >= 0.6).length;
    const averageConfidence = analyses.length > 0 
      ? analyses.reduce((sum, a) => sum + a.confidence, 0) / analyses.length
      : 0;

    const purposeBreakdown = analyses.reduce((acc, analysis) => {
      acc[analysis.detectedPurpose] = (acc[analysis.detectedPurpose] || 0) + 1;
      return acc;
    }, {} as Record<TerminalPurpose, number>);

    return {
      totalAnalyzed: analyses.length,
      successfulDetections,
      averageConfidence,
      purposeBreakdown
    };
  }

  /**
   * Export naming analysis for review
   */
  exportAnalysis(): {
    timestamp: Date;
    convention: NamingConvention;
    analyses: TerminalAnalysis[];
    statistics: any;
  } {
    return {
      timestamp: new Date(),
      convention: this.namingConvention,
      analyses: Array.from(this.terminalAnalyses.values()),
      statistics: this.getStatistics()
    };
  }
}