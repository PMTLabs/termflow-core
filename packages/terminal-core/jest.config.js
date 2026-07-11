/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'jsdom',
  roots: ['<rootDir>/src'],
  testMatch: [
    '**/__tests__/**/*.+(ts|tsx)',
    '**/?(*.)+(spec|test).+(ts|tsx)',
  ],
  // xterm touches DOM/canvas — mock the xterm packages so jsdom never loads real xterm.
  moduleNameMapper: {
    '^@xterm/xterm$': '<rootDir>/src/__mocks__/xterm.ts',
    '^@xterm/addon-fit$': '<rootDir>/src/__mocks__/addon-fit.ts',
    '^@xterm/addon-web-links$': '<rootDir>/src/__mocks__/addon-web-links.ts',
    '^@xterm/addon-unicode11$': '<rootDir>/src/__mocks__/addon-unicode11.ts',
    '^@xterm/addon-webgl$': '<rootDir>/src/__mocks__/addon-webgl.ts',
    '^@xterm/addon-search$': '<rootDir>/src/__mocks__/addon-search.ts',
  },
  transform: {
    '^.+\\.(ts|tsx)$': 'ts-jest',
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  testTimeout: 10000,
  verbose: true,
};
