#!/usr/bin/env node

/**
 * Enhanced Features Validation Script
 * Tests all communication enforcement and quality management features
 */

const chalk = require('chalk');
const fs = require('fs');
const path = require('path');

// Import test modules (after build)
async function runEnhancedFeatureTests() {
    try {
        console.log(chalk.cyan('🧪 Enhanced Agent Monitor Feature Validation'));
        console.log(chalk.gray('================================================\n'));

        let passed = 0;
        let failed = 0;

        // Test 1: Configuration Loading
        console.log(chalk.blue('1. Testing Configuration Loading...'));
        try {
            const { ConfigurationValidator, ConfigurationUtils } = require('./dist/enforcement-config');
            
            // Test loading enhanced config
            if (fs.existsSync('./enhanced-team-config.json')) {
                const config = ConfigurationUtils.importConfiguration(
                    fs.readFileSync('./enhanced-team-config.json', 'utf-8')
                );
                
                const validation = ConfigurationValidator.validateTeamConfiguration(config);
                if (validation.isValid) {
                    console.log(chalk.green('   ✅ Enhanced configuration loaded and validated'));
                    passed++;
                } else {
                    console.log(chalk.red('   ❌ Configuration validation failed'));
                    validation.errors.forEach(error => console.log(chalk.red(`      • ${error}`)));
                    failed++;
                }
            } else {
                console.log(chalk.yellow('   ⚠️  Enhanced config file not found'));
                failed++;
            }
        } catch (error) {
            console.log(chalk.red(`   ❌ Configuration test failed: ${error.message}`));
            failed++;
        }

        // Test 2: Git Discipline Enforcer
        console.log(chalk.blue('\n2. Testing Git Discipline Enforcer...'));
        try {
            const { GitDisciplineEnforcer } = require('./dist/git-discipline-enforcer');
            
            const enforcer = new GitDisciplineEnforcer({
                autoCommitInterval: 30 * 60 * 1000,
                enforceFeatureBranches: true,
                requireMeaningfulCommits: true
            });

            // Test commit message validation
            const goodCommit = enforcer.validateCommitMessage('Add user authentication with JWT tokens');
            const badCommit = enforcer.validateCommitMessage('fixes');

            if (goodCommit.isMeaningful && !badCommit.isMeaningful) {
                console.log(chalk.green('   ✅ Commit message validation working correctly'));
                passed++;
            } else {
                console.log(chalk.red('   ❌ Commit message validation failed'));
                failed++;
            }
        } catch (error) {
            console.log(chalk.red(`   ❌ Git discipline test failed: ${error.message}`));
            failed++;
        }

        // Test 3: Communication Protocol Enforcer
        console.log(chalk.blue('\n3. Testing Communication Protocol Enforcer...'));
        try {
            const { CommunicationProtocolEnforcer } = require('./dist/communication-protocol-enforcer');
            
            const protocolEnforcer = new CommunicationProtocolEnforcer();

            // Test STATUS message validation
            const statusMessage = `STATUS [Jordan Backend] [2024-01-15 14:30]
Completed:
- Implemented user authentication API endpoints
- Added JWT token validation middleware
Current: Working on password reset functionality
Blocked: None
ETA: Password reset completion by 16:00`;

            const validation = protocolEnforcer.validateMessage(
                'backend-001',
                'Backend Developer',
                'coordinator-001',
                'Project Coordinator',
                statusMessage
            );

            if (validation.isValid) {
                console.log(chalk.green('   ✅ Communication protocol validation working'));
                passed++;
            } else {
                console.log(chalk.red('   ❌ Communication protocol validation failed'));
                console.log(chalk.red(`      Issues: ${validation.suggestions.join(', ')}`));
                failed++;
            }
        } catch (error) {
            console.log(chalk.red(`   ❌ Communication protocol test failed: ${error.message}`));
            failed++;
        }

        // Test 4: Terminal Naming Manager
        console.log(chalk.blue('\n4. Testing Terminal Naming Manager...'));
        try {
            const { TerminalNamingManager } = require('./dist/terminal-naming-manager');
            
            // Mock client for testing
            const mockClient = {
                getTerminals: async () => ([
                    { id: 'term-1', name: 'Terminal 1' },
                    { id: 'term-2', name: 'Terminal 2' }
                ]),
                getTerminalOutput: async (id) => 'npx claude-code --model sonnet'
            };

            const namingManager = new TerminalNamingManager(mockClient, {
                agentPattern: 'Claude-{role}',
                servicePattern: '{service}-Dev',
                autoRename: true,
                promptUser: false
            });

            // Test naming examples generation
            const examples = namingManager.generateNamingExamples();
            if (examples && examples['Claude Agents'] && examples['Claude Agents'].length > 0) {
                console.log(chalk.green('   ✅ Terminal naming manager initialized correctly'));
                passed++;
            } else {
                console.log(chalk.red('   ❌ Terminal naming manager failed'));
                failed++;
            }
        } catch (error) {
            console.log(chalk.red(`   ❌ Terminal naming test failed: ${error.message}`));
            failed++;
        }

        // Test 5: Quality Gate Manager
        console.log(chalk.blue('\n5. Testing Quality Gate Manager...'));
        try {
            const { QualityGateManager } = require('./dist/quality-gate-manager');
            
            const qualityGates = new QualityGateManager({
                minTestCoverage: 80,
                maxResponseTime: 500,
                minSecurityScore: 85
            });

            // Create test quality gate
            const gate = qualityGates.createQualityGate(
                'test-gate',
                'Test Quality Gate',
                'testing',
                ['Project Coordinator', 'QA Engineer']
            );

            if (gate && gate.id === 'test-gate') {
                console.log(chalk.green('   ✅ Quality gate manager working correctly'));
                passed++;
            } else {
                console.log(chalk.red('   ❌ Quality gate manager failed'));
                failed++;
            }
        } catch (error) {
            console.log(chalk.red(`   ❌ Quality gate test failed: ${error.message}`));
            failed++;
        }

        // Test 6: Enhanced Team Orchestrator Integration
        console.log(chalk.blue('\n6. Testing Enhanced Team Orchestrator Integration...'));
        try {
            const { EnhancedTeamOrchestrator } = require('./dist/enhanced-team-orchestrator');
            console.log(chalk.green('   ✅ Enhanced Team Orchestrator class loaded successfully'));
            passed++;
        } catch (error) {
            console.log(chalk.red(`   ❌ Enhanced orchestrator integration failed: ${error.message}`));
            failed++;
        }

        // Summary
        console.log(chalk.cyan('\n📊 Test Results Summary:'));
        console.log(chalk.white('┌─────────────────────────────────────┬─────────┐'));
        console.log(chalk.white('│ Test Category                       │ Status  │'));
        console.log(chalk.white('├─────────────────────────────────────┼─────────┤'));

        const testResults = [
            ['Configuration Loading', passed >= 1],
            ['Git Discipline Enforcer', passed >= 2],
            ['Communication Protocol Enforcer', passed >= 3],
            ['Terminal Naming Manager', passed >= 4],
            ['Quality Gate Manager', passed >= 5],
            ['Enhanced Orchestrator Integration', passed >= 6]
        ];

        testResults.forEach(([test, pass]) => {
            const status = pass ? chalk.green('✅ PASS') : chalk.red('❌ FAIL');
            console.log(`│ ${test.padEnd(35)} │ ${status} │`);
        });

        console.log(chalk.white('└─────────────────────────────────────┴─────────┘'));
        console.log(chalk.cyan(`\n🎯 Overall: ${passed}/${passed + failed} tests passed`));

        if (failed === 0) {
            console.log(chalk.green('🎉 All enhanced features are working correctly!'));
            return true;
        } else {
            console.log(chalk.red(`❌ ${failed} test(s) failed. Please check the implementation.`));
            return false;
        }

    } catch (error) {
        console.error(chalk.red(`💥 Test suite failed: ${error.message}`));
        console.error(chalk.gray(error.stack));
        return false;
    }
}

// Additional validation functions
function validateBuildArtifacts() {
    console.log(chalk.blue('\n🔍 Validating Build Artifacts...'));
    
    const requiredFiles = [
        './dist/git-discipline-enforcer.js',
        './dist/communication-protocol-enforcer.js',
        './dist/terminal-naming-manager.js',
        './dist/quality-gate-manager.js',
        './dist/enforcement-config.js',
        './dist/enhanced-team-orchestrator.js'
    ];

    let allPresent = true;
    requiredFiles.forEach(file => {
        if (fs.existsSync(file)) {
            console.log(chalk.green(`   ✅ ${file}`));
        } else {
            console.log(chalk.red(`   ❌ ${file} - Missing`));
            allPresent = false;
        }
    });

    if (!allPresent) {
        console.log(chalk.yellow('\n💡 Run "npm run build" to compile TypeScript files'));
    }

    return allPresent;
}

function validateConfigurationFiles() {
    console.log(chalk.blue('\n📝 Validating Configuration Files...'));
    
    const configFiles = [
        { path: './enhanced-team-config.json', required: true },
        { path: './team-config.json', required: false },
        { path: './start-enhanced-team.js', required: true }
    ];

    let allValid = true;
    configFiles.forEach(({ path, required }) => {
        if (fs.existsSync(path)) {
            try {
                if (path.endsWith('.json')) {
                    JSON.parse(fs.readFileSync(path, 'utf-8'));
                }
                console.log(chalk.green(`   ✅ ${path} - Valid`));
            } catch (error) {
                console.log(chalk.red(`   ❌ ${path} - Invalid JSON: ${error.message}`));
                allValid = false;
            }
        } else if (required) {
            console.log(chalk.red(`   ❌ ${path} - Missing (required)`));
            allValid = false;
        } else {
            console.log(chalk.yellow(`   ⚠️  ${path} - Missing (optional)`));
        }
    });

    return allValid;
}

// Main execution
async function main() {
    console.log(chalk.magenta('╔══════════════════════════════════════════════════════════════╗'));
    console.log(chalk.magenta('║            Enhanced Agent Monitor Validation Suite          ║'));
    console.log(chalk.magenta('╚══════════════════════════════════════════════════════════════╝\n'));

    // Step 1: Validate build artifacts
    const buildValid = validateBuildArtifacts();
    if (!buildValid) {
        console.log(chalk.red('\n❌ Build validation failed. Please run "npm run build" first.'));
        process.exit(1);
    }

    // Step 2: Validate configuration files
    const configValid = validateConfigurationFiles();
    if (!configValid) {
        console.log(chalk.red('\n❌ Configuration validation failed.'));
        process.exit(1);
    }

    // Step 3: Run feature tests
    const testsPass = await runEnhancedFeatureTests();
    
    if (testsPass) {
        console.log(chalk.green('\n🚀 Enhanced Agent Monitor is ready for use!'));
        console.log(chalk.cyan('Next steps:'));
        console.log(chalk.white('  1. Start Auto-Terminal with API enabled'));
        console.log(chalk.white('  2. Set your API_TOKEN environment variable'));
        console.log(chalk.white('  3. Run: npm run team:enhanced'));
        process.exit(0);
    } else {
        console.log(chalk.red('\n❌ Some tests failed. Please fix the issues before using.'));
        process.exit(1);
    }
}

// Run if executed directly
if (require.main === module) {
    main().catch(error => {
        console.error(chalk.red(`💥 Validation failed: ${error.message}`));
        process.exit(1);
    });
}

module.exports = { runEnhancedFeatureTests, validateBuildArtifacts, validateConfigurationFiles };