module.exports = {
  // Use ts-jest preset for TypeScript support
  preset: 'ts-jest',
  
  // Test environment
  testEnvironment: 'node',
  
  // Setup files
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  
  // Test file patterns
  testMatch: [
    '**/__tests__/**/*.+(ts|tsx|js)',
    '**/?(*.)+(spec|test).+(ts|tsx|js)'
  ],
  
  // Module paths
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^@api/(.*)$': '<rootDir>/src/api/$1',
    '^@shell/(.*)$': '<rootDir>/src/shell/$1',
    '^@main/(.*)$': '<rootDir>/src/main/$1',
    '^@renderer/(.*)$': '<rootDir>/src/renderer/$1'
  },
  
  // Transform settings
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', {
      tsconfig: {
        jsx: 'react',
        esModuleInterop: true
      }
    }]
  },
  
  // Coverage configuration
  collectCoverageFrom: [
    'src/**/*.{ts,tsx}',
    '!src/**/*.d.ts',
    '!src/test/**/*',
    '!src/**/__tests__/**/*',
    '!src/**/index.ts'
  ],
  
  // Coverage thresholds
  coverageThreshold: {
    global: {
      branches: 80,
      functions: 80,
      lines: 80,
      statements: 80
    }
  },
  
  // Coverage reporters
  coverageReporters: ['text', 'lcov', 'html'],
  
  // Git worktrees live in `<project>/.claude/` by project convention, which puts a
  // second full copy of the repo INSIDE the repo. Without this, jest builds one
  // module map across both copies, every package.json name collides, and suites fail
  // in the MAIN tree as well — reporting failures that have nothing to do with the
  // code under test. modulePathIgnorePatterns (not just testPathIgnorePatterns) is
  // the one that keeps the copy out of the module map.
  modulePathIgnorePatterns: ['<rootDir>/.claude/'],

  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/\\.claude/',  // worktrees — see modulePathIgnorePatterns above
    '/dist/',
    '/build/',
    '/tests/e2e/',
    '/terminal-monitor/',
    '/mcp-server/',  // MCP sidecar owns its own runner (`bun test`)
    '/packages/',  // Workspace packages own their own jest config (jsdom env)
    '\\.spec\\.(js|ts)$'  // Exclude Playwright spec files
  ],
  
  // Module file extensions
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],

  // Timeouts
  testTimeout: 10000,
  
  // Verbose output
  verbose: true
};