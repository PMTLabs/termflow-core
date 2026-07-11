// Test setup file for Jest
import { jest } from '@jest/globals';

// Mock node-pty which requires native compilation
const mockNodePty = {
  spawn: jest.fn(() => ({
    pid: 12345,
    write: jest.fn(),
    resize: jest.fn(),
    kill: jest.fn(),
    on: jest.fn(),
    removeAllListeners: jest.fn()
  }))
};

// Apply mocks
jest.mock('@homebridge/node-pty-prebuilt-multiarch', () => mockNodePty);

// Global test utilities
global.mockConsole = () => {
  const originalConsole = global.console;
  beforeEach(() => {
    global.console = {
      ...originalConsole,
      log: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      info: jest.fn()
    } as any;
  });

  afterEach(() => {
    global.console = originalConsole;
  });
};

// Test timeout configuration
jest.setTimeout(10000);