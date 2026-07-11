#!/usr/bin/env node

/**
 * Enhanced Configuration Validation Script
 * Validates enhanced team configuration files and provides recommendations
 */

const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

// Configuration validation functions
function validateEnhancedConfig(configPath) {
    console.log(chalk.blue(`📋 Validating Enhanced Configuration: ${configPath}`));
    
    if (!fs.existsSync(configPath)) {
        console.log(chalk.red(`❌ Configuration file not found: ${configPath}`));
        return false;
    }

    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        
        // Basic structure validation
        const requiredSections = ['teamConfig', 'agents', 'enforcement'];
        const missingSections = requiredSections.filter(section => !config[section]);
        
        if (missingSections.length > 0) {
            console.log(chalk.red(`❌ Missing required sections: ${missingSections.join(', ')}`));
            return false;
        }

        console.log(chalk.green('✅ Basic structure validation passed'));

        // Validate team configuration
        validateTeamConfig(config.teamConfig);

        // Validate agents
        validateAgents(config.agents);

        // Validate enforcement configuration
        validateEnforcementConfig(config.enforcement);

        // Validate workflows if present
        if (config.workflows) {
            validateWorkflows(config.workflows);
        }

        console.log(chalk.green('✅ Enhanced configuration validation completed successfully'));
        return true;

    } catch (error) {
        console.log(chalk.red(`❌ Configuration parsing failed: ${error.message}`));
        return false;
    }
}

function validateTeamConfig(teamConfig) {
    console.log(chalk.blue('\n📋 Validating Team Configuration...'));
    
    const requiredFields = ['projectName', 'projectFolder', 'chatHubChannel'];
    const missingFields = requiredFields.filter(field => !teamConfig[field]);
    
    if (missingFields.length > 0) {
        console.log(chalk.red(`❌ Missing team config fields: ${missingFields.join(', ')}`));
        return false;
    }

    // Validate project folder exists (if it's a real path)
    if (teamConfig.projectFolder && !teamConfig.projectFolder.includes('{') && fs.existsSync(teamConfig.projectFolder)) {
        console.log(chalk.green(`✅ Project folder exists: ${teamConfig.projectFolder}`));
    } else if (teamConfig.projectFolder && !teamConfig.projectFolder.includes('{')) {
        console.log(chalk.yellow(`⚠️  Project folder not found: ${teamConfig.projectFolder}`));
    }

    // Validate numeric fields
    if (typeof teamConfig.chatHubChannel !== 'number' || teamConfig.chatHubChannel < 1) {
        console.log(chalk.red('❌ Invalid chatHubChannel: must be a positive number'));
        return false;
    }

    console.log(chalk.green('✅ Team configuration valid'));
    return true;
}

function validateAgents(agents) {
    console.log(chalk.blue('\n🤖 Validating Agent Configuration...'));
    
    if (!Array.isArray(agents) || agents.length === 0) {
        console.log(chalk.red('❌ No agents configured'));
        return false;
    }

    const requiredAgentFields = ['id', 'name', 'role', 'aiType', 'cliCommand'];
    const validRoles = [
        'Project Coordinator',
        'System Architect', 
        'Backend Developer',
        'Frontend Developer',
        'QA Engineer',
        'DevOps Engineer'
    ];

    let hasCoordinator = false;
    const agentIds = new Set();

    agents.forEach((agent, index) => {
        console.log(chalk.gray(`   Validating agent ${index + 1}: ${agent.name || 'unnamed'}`));
        
        // Check required fields
        const missingFields = requiredAgentFields.filter(field => !agent[field]);
        if (missingFields.length > 0) {
            console.log(chalk.red(`   ❌ Agent ${index + 1} missing fields: ${missingFields.join(', ')}`));
            return false;
        }

        // Check for duplicate IDs
        if (agentIds.has(agent.id)) {
            console.log(chalk.red(`   ❌ Duplicate agent ID: ${agent.id}`));
            return false;
        }
        agentIds.add(agent.id);

        // Check valid role
        if (!validRoles.includes(agent.role)) {
            console.log(chalk.yellow(`   ⚠️  Unknown role: ${agent.role}`));
        }

        // Check for Project Coordinator
        if (agent.role === 'Project Coordinator') {
            hasCoordinator = true;
        }

        // Validate specializations
        if (agent.specializations && !Array.isArray(agent.specializations)) {
            console.log(chalk.red(`   ❌ Agent ${agent.id} specializations must be an array`));
            return false;
        }

        // Validate maxConcurrentTasks
        if (agent.maxConcurrentTasks && (typeof agent.maxConcurrentTasks !== 'number' || agent.maxConcurrentTasks < 1)) {
            console.log(chalk.red(`   ❌ Agent ${agent.id} maxConcurrentTasks must be a positive number`));
            return false;
        }

        console.log(chalk.green(`   ✅ Agent ${agent.id} valid`));
    });

    if (!hasCoordinator) {
        console.log(chalk.red('❌ No Project Coordinator found. At least one is required for communication enforcement.'));
        return false;
    }

    console.log(chalk.green(`✅ All ${agents.length} agents validated successfully`));
    return true;
}

function validateEnforcementConfig(enforcement) {
    console.log(chalk.blue('\n🛡️  Validating Enforcement Configuration...'));
    
    const requiredSections = [
        'gitDiscipline',
        'terminalNaming', 
        'communicationProtocol',
        'qualityGates',
        'projectLifecycle',
        'antiPatternPrevention',
        'humanInteraction'
    ];

    const missingSections = requiredSections.filter(section => !enforcement[section]);
    if (missingSections.length > 0) {
        console.log(chalk.red(`❌ Missing enforcement sections: ${missingSections.join(', ')}`));
        return false;
    }

    // Validate Git Discipline
    validateGitDisciplineConfig(enforcement.gitDiscipline);

    // Validate Terminal Naming
    validateTerminalNamingConfig(enforcement.terminalNaming);

    // Validate Communication Protocol
    validateCommunicationProtocolConfig(enforcement.communicationProtocol);

    // Validate Quality Gates
    validateQualityGatesConfig(enforcement.qualityGates);

    console.log(chalk.green('✅ Enforcement configuration validated'));
    return true;
}

function validateGitDisciplineConfig(gitConfig) {
    console.log(chalk.gray('   📝 Git Discipline Configuration...'));
    
    // Validate intervals
    if (gitConfig.autoCommitInterval && gitConfig.autoCommitInterval < 5 * 60 * 1000) {
        console.log(chalk.yellow('   ⚠️  Auto-commit interval is very short (< 5 minutes)'));
    }

    if (gitConfig.maxWorkTimeWithoutCommit && gitConfig.maxWorkTimeWithoutCommit > 2 * 60 * 60 * 1000) {
        console.log(chalk.yellow('   ⚠️  Max work time without commit is very long (> 2 hours)'));
    }

    // Validate boolean fields
    const booleanFields = ['enabled', 'enforceFeatureBranches', 'requireMeaningfulCommits', 'commitReminderEnabled'];
    booleanFields.forEach(field => {
        if (gitConfig[field] !== undefined && typeof gitConfig[field] !== 'boolean') {
            console.log(chalk.red(`   ❌ ${field} must be boolean`));
            return false;
        }
    });

    console.log(chalk.green('   ✅ Git discipline config valid'));
    return true;
}

function validateTerminalNamingConfig(namingConfig) {
    console.log(chalk.gray('   🏷️  Terminal Naming Configuration...'));
    
    // Check patterns
    const requiredPatterns = ['agentPattern', 'servicePattern', 'shellPattern'];
    const missingPatterns = requiredPatterns.filter(pattern => !namingConfig[pattern]);
    
    if (missingPatterns.length > 0) {
        console.log(chalk.yellow(`   ⚠️  Missing naming patterns: ${missingPatterns.join(', ')}`));
    }

    // Validate confidence threshold
    if (namingConfig.minimumConfidence !== undefined) {
        if (typeof namingConfig.minimumConfidence !== 'number' || 
            namingConfig.minimumConfidence < 0 || 
            namingConfig.minimumConfidence > 1) {
            console.log(chalk.red('   ❌ minimumConfidence must be a number between 0 and 1'));
            return false;
        }
    }

    console.log(chalk.green('   ✅ Terminal naming config valid'));
    return true;
}

function validateCommunicationProtocolConfig(commConfig) {
    console.log(chalk.gray('   💬 Communication Protocol Configuration...'));
    
    // Validate maxExchangesBeforeEscalation
    if (commConfig.maxExchangesBeforeEscalation !== undefined) {
        if (typeof commConfig.maxExchangesBeforeEscalation !== 'number' || 
            commConfig.maxExchangesBeforeEscalation < 1) {
            console.log(chalk.red('   ❌ maxExchangesBeforeEscalation must be a positive number'));
            return false;
        }
    }

    console.log(chalk.green('   ✅ Communication protocol config valid'));
    return true;
}

function validateQualityGatesConfig(qualityConfig) {
    console.log(chalk.gray('   🚪 Quality Gates Configuration...'));
    
    // Validate percentage values
    const percentageFields = ['minTestCoverage', 'minSecurityScore', 'minDocumentationCoverage'];
    percentageFields.forEach(field => {
        if (qualityConfig[field] !== undefined) {
            if (typeof qualityConfig[field] !== 'number' || 
                qualityConfig[field] < 0 || 
                qualityConfig[field] > 100) {
                console.log(chalk.red(`   ❌ ${field} must be a number between 0 and 100`));
                return false;
            }
        }
    });

    // Validate response time
    if (qualityConfig.maxResponseTime !== undefined) {
        if (typeof qualityConfig.maxResponseTime !== 'number' || qualityConfig.maxResponseTime <= 0) {
            console.log(chalk.red('   ❌ maxResponseTime must be a positive number'));
            return false;
        }
    }

    // Validate technical debt ratio
    if (qualityConfig.maxTechnicalDebtRatio !== undefined) {
        if (typeof qualityConfig.maxTechnicalDebtRatio !== 'number' || 
            qualityConfig.maxTechnicalDebtRatio < 0 || 
            qualityConfig.maxTechnicalDebtRatio > 1) {
            console.log(chalk.red('   ❌ maxTechnicalDebtRatio must be a number between 0 and 1'));
            return false;
        }
    }

    console.log(chalk.green('   ✅ Quality gates config valid'));
    return true;
}

function validateWorkflows(workflows) {
    console.log(chalk.blue('\n🔄 Validating Workflows...'));
    
    if (!Array.isArray(workflows) || workflows.length === 0) {
        console.log(chalk.yellow('⚠️  No workflows defined'));
        return true;
    }

    workflows.forEach((workflow, index) => {
        console.log(chalk.gray(`   Validating workflow ${index + 1}: ${workflow.name || 'unnamed'}`));
        
        if (!workflow.name || !workflow.phases) {
            console.log(chalk.red(`   ❌ Workflow ${index + 1} missing name or phases`));
            return false;
        }

        if (!Array.isArray(workflow.phases)) {
            console.log(chalk.red(`   ❌ Workflow ${workflow.name} phases must be an array`));
            return false;
        }

        workflow.phases.forEach((phase, phaseIndex) => {
            if (!phase.name || !phase.roles) {
                console.log(chalk.red(`   ❌ Phase ${phaseIndex + 1} in ${workflow.name} missing name or roles`));
                return false;
            }
        });

        console.log(chalk.green(`   ✅ Workflow ${workflow.name} valid`));
    });

    console.log(chalk.green('✅ All workflows validated'));
    return true;
}

function generateConfigurationReport(configPath) {
    console.log(chalk.cyan('\n📊 Configuration Analysis Report\n'));
    
    try {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        
        // Project summary
        console.log(chalk.white('Project Information:'));
        console.log(`  • Name: ${config.teamConfig.projectName}`);
        console.log(`  • Folder: ${config.teamConfig.projectFolder}`);
        console.log(`  • ChatHub Channel: ${config.teamConfig.chatHubChannel}`);
        
        // Team composition
        console.log(chalk.white('\nTeam Composition:'));
        console.log(`  • Total Agents: ${config.agents.length}`);
        
        const roleCount = config.agents.reduce((acc, agent) => {
            acc[agent.role] = (acc[agent.role] || 0) + 1;
            return acc;
        }, {});
        
        Object.entries(roleCount).forEach(([role, count]) => {
            console.log(`  • ${role}: ${count}`);
        });

        // Enhancement features
        console.log(chalk.white('\nEnhancement Features:'));
        const features = [
            ['Git Discipline', config.enforcement.gitDiscipline.enabled],
            ['Terminal Naming', config.enforcement.terminalNaming.enabled],
            ['Communication Protocol', config.enforcement.communicationProtocol.enabled],
            ['Quality Gates', config.enforcement.qualityGates.enabled],
            ['Project Lifecycle', config.enforcement.projectLifecycle.enabled],
            ['Anti-Pattern Prevention', config.enforcement.antiPatternPrevention.enabled]
        ];

        features.forEach(([feature, enabled]) => {
            const status = enabled ? chalk.green('✅ Enabled') : chalk.red('❌ Disabled');
            console.log(`  • ${feature}: ${status}`);
        });

        // Quality standards
        if (config.enforcement.qualityGates.enabled) {
            console.log(chalk.white('\nQuality Standards:'));
            console.log(`  • Min Test Coverage: ${config.enforcement.qualityGates.minTestCoverage}%`);
            console.log(`  • Max Response Time: ${config.enforcement.qualityGates.maxResponseTime}ms`);
            console.log(`  • Min Security Score: ${config.enforcement.qualityGates.minSecurityScore}/100`);
            console.log(`  • Max Technical Debt: ${(config.enforcement.qualityGates.maxTechnicalDebtRatio * 100).toFixed(1)}%`);
        }

        // Workflows
        if (config.workflows && config.workflows.length > 0) {
            console.log(chalk.white('\nWorkflows:'));
            config.workflows.forEach(workflow => {
                console.log(`  • ${workflow.name} (${workflow.phases.length} phases)`);
            });
        }

    } catch (error) {
        console.log(chalk.red(`❌ Failed to generate report: ${error.message}`));
    }
}

// Main execution
function main() {
    const configPath = process.argv[2] || './enhanced-team-config.json';
    
    console.log(chalk.magenta('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.magenta('║          Enhanced Team Configuration Validator              ║'));
    console.log(chalk.magenta('╚══════════════════════════════════════════════════════════════╝\n'));

    console.log(chalk.cyan(`🔍 Validating configuration file: ${configPath}\n`));

    const isValid = validateEnhancedConfig(configPath);
    
    if (isValid) {
        generateConfigurationReport(configPath);
        console.log(chalk.green('\n🎉 Configuration validation successful!'));
        console.log(chalk.cyan('Your enhanced team configuration is ready to use.'));
        process.exit(0);
    } else {
        console.log(chalk.red('\n❌ Configuration validation failed!'));
        console.log(chalk.yellow('Please fix the issues above before using the enhanced team orchestrator.'));
        process.exit(1);
    }
}

// Run if executed directly
if (require.main === module) {
    main();
}

module.exports = {
    validateEnhancedConfig,
    validateTeamConfig,
    validateAgents,
    validateEnforcementConfig,
    generateConfigurationReport
};