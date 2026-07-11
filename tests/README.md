# Auto-Terminal E2E Testing Suite

## Overview
Comprehensive end-to-end testing suite for the Auto-Terminal application using Playwright for Electron automation.

## Features
- **App Launch Testing**: Verifies application startup and initial state
- **Menu Interaction Testing**: Tests all menu actions and UI navigation
- **Terminal Input/Output Testing**: Validates terminal functionality and command execution
- **Performance Testing**: Monitors app responsiveness and resource usage
- **Cross-Platform Support**: Runs on Windows, macOS, and Linux

## Setup

### Prerequisites
- Node.js 18+
- npm or yarn
- Built application (`npm run build`)

### Installation
```bash
# Install dependencies (already done if you ran npm install)
npm install

# Install Playwright browsers
npx playwright install
```

## Running Tests

### All E2E Tests
```bash
npm run test:e2e
```

### With Browser Visible (Headed Mode)
```bash
npm run test:e2e:headed
```

### Debug Mode (Step Through Tests)
```bash
npm run test:e2e:debug
```

### Specific Test File
```bash
npx playwright test app-launch.spec.ts
npx playwright test menu-interactions.spec.ts
npx playwright test terminal-interactions.spec.ts
npx playwright test performance.spec.ts
```

### All Tests (Unit + E2E)
```bash
npm run test:all
```

## Test Structure

### Test Files
- `app-launch.spec.ts` - Application startup and initialization tests
- `menu-interactions.spec.ts` - Menu actions, tab management, pane splitting
- `terminal-interactions.spec.ts` - Terminal input, command execution, keyboard handling
- `performance.spec.ts` - Performance benchmarks and resource monitoring

### Utilities
- `utils/electron-launcher.ts` - Electron app launcher and helper utilities
- `ElectronTestUtils` class provides reusable methods for common operations

## Test Categories

### 1. App Launch Tests
- Application startup verification
- Initial UI component visibility
- Window management
- Graceful shutdown

### 2. Menu Interaction Tests
- Tab creation and management
- Pane splitting (horizontal/vertical)
- Tab switching and navigation
- Menu event handling

### 3. Terminal Interaction Tests
- Text input and command execution
- Keyboard shortcuts and special characters
- Copy-paste operations
- Multi-terminal (split pane) interactions
- Focus and blur handling

### 4. Performance Tests
- Launch time measurements
- Tab creation performance
- Input responsiveness
- Memory usage monitoring
- UI responsiveness under load

## Automation Capabilities

### What Gets Automated
1. **Application Launch**
   - Starts Electron app from built files
   - Waits for UI to be ready
   - Verifies core components

2. **UI Interactions**
   - Clicking buttons and menu items
   - Typing text into terminals
   - Keyboard shortcuts
   - Window resizing

3. **Terminal Operations**
   - Command input simulation
   - Output verification
   - Multi-terminal scenarios
   - Special character handling

4. **System Integration**
   - Cross-platform testing
   - Real terminal process interaction
   - File system operations (via terminal)

### Test Data Selectors
Tests use `data-testid` attributes for reliable element selection:
- `[data-testid="tab"]` - Tab elements
- `[data-testid="tab-title"]` - Tab titles
- `[data-testid="close-tab"]` - Tab close buttons
- `.xterm-screen` - Terminal display areas

## CI/CD Integration

### GitHub Actions
- Automated testing on push/PR
- Cross-platform test execution
- Test result artifacts
- Performance monitoring

### Local Development
```bash
# Quick smoke test
npx playwright test app-launch.spec.ts

# Full test suite before commit
npm run test:all

# Debug specific failure
npm run test:e2e:debug -- --grep "should create new tab"
```

## Configuration

### Playwright Config
- `playwright.config.ts` - Main configuration
- Test timeout: 30 seconds per test
- Retry policy: 2 retries on CI
- Reporters: HTML, List, JUnit

### Test Environment
- Headless by default (can run headed with `--headed`)
- Screenshots on failure
- Video recording on failure
- Trace collection for debugging

## Troubleshooting

### Common Issues

1. **App Fails to Launch**
   ```bash
   # Ensure app is built
   npm run build
   
   # Check Electron path
   ls -la dist/main/main.js
   ```

2. **Timeout Errors**
   - Increase timeout in test files
   - Check for app startup issues
   - Verify system resources

3. **Element Not Found**
   - Verify `data-testid` attributes exist
   - Check UI component rendering
   - Add explicit waits

### Debugging
```bash
# Run with debug info
DEBUG=pw:api npm run test:e2e

# Step through test
npm run test:e2e:debug

# Generate trace
npx playwright test --trace on
```

## Performance Benchmarks

### Target Metrics
- App launch: < 10 seconds
- Tab creation: < 1 second per tab
- Input responsiveness: < 100ms
- Memory growth: < 50MB per hour

### Monitoring
Tests automatically log performance metrics and fail if targets are exceeded.

## Best Practices

### Writing Tests
1. Use descriptive test names
2. Add proper waits for async operations
3. Clean up resources in test hooks
4. Use page object patterns for complex interactions

### Maintenance
1. Update selectors when UI changes
2. Add new tests for new features
3. Monitor test execution time
4. Keep test data realistic but minimal

## Contributing

### Adding New Tests
1. Create test file in `tests/e2e/`
2. Import utilities from `../utils/electron-launcher`
3. Follow existing patterns and naming
4. Add performance assertions where relevant
5. Update this README if adding new test categories