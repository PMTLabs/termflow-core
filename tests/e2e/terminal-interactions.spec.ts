import { test, expect, ElectronTestUtils } from '../utils/electron-launcher';

test.describe('Terminal Interactions', () => {
  test('should accept text input in terminal', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Type a simple command
    const testCommand = 'echo "Hello Terminal"';
    await utils.typeInTerminal(testCommand);
    
    // Verify the command appears in terminal
    const terminalOutput = await utils.getTerminalOutput();
    expect(terminalOutput).toContain('echo');
  });

  test('should execute commands when Enter is pressed', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Type and execute a command
    await utils.typeInTerminal('echo "Test Output"');
    await utils.pressEnterInTerminal();
    
    // Wait for command execution
    await page.waitForTimeout(2000);
    
    // Check for some output (the exact output depends on the shell)
    const terminalOutput = await utils.getTerminalOutput();
    expect(terminalOutput.length).toBeGreaterThan(0);
  });

  test('should handle multiple commands', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Execute multiple commands
    const commands = ['dir', 'cd', 'echo "test"'];
    
    for (const command of commands) {
      await utils.typeInTerminal(command);
      await utils.pressEnterInTerminal();
      await page.waitForTimeout(1000);
    }
    
    // Verify terminal has output from multiple commands
    const terminalOutput = await utils.getTerminalOutput();
    expect(terminalOutput.length).toBeGreaterThan(50); // Should have substantial output
  });

  test('should handle keyboard shortcuts', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Focus on terminal
    await page.locator('.xterm-screen').click();
    
    // Test Ctrl+C (should not crash the app)
    await page.keyboard.press('Control+C');
    await page.waitForTimeout(500);
    
    // Verify app is still responsive
    await utils.checkAppResponsive();
    
    // Test other common shortcuts
    await page.keyboard.press('Control+L'); // Clear screen in many shells
    await page.waitForTimeout(500);
    
    await utils.checkAppResponsive();
  });

  test('should handle special characters and symbols', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Type various special characters
    const specialChars = '!@#$%^&*()_+-=[]{}|;:,.<>?';
    await utils.typeInTerminal(specialChars);
    
    // Verify characters appear in terminal
    const terminalOutput = await utils.getTerminalOutput();
    // Check that at least some special characters are handled
    expect(terminalOutput).toContain('!');
  });

  test('should handle rapid input', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Type rapidly
    const rapidText = 'rapid input test '.repeat(10);
    await utils.typeInTerminal(rapidText);
    
    // Verify terminal can handle rapid input
    const terminalOutput = await utils.getTerminalOutput();
    expect(terminalOutput).toContain('rapid');
  });

  test('should handle copy-paste operations', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Focus terminal
    await page.locator('.xterm-screen').click();
    
    // Type some text
    await utils.typeInTerminal('test copy paste');
    
    // Try to select text (this might vary by terminal implementation)
    await page.keyboard.press('Control+A');
    await page.waitForTimeout(200);
    
    // Try to copy
    await page.keyboard.press('Control+C');
    await page.waitForTimeout(200);
    
    // Clear and paste
    await page.keyboard.press('Control+L');
    await page.waitForTimeout(200);
    await page.keyboard.press('Control+V');
    
    // Verify app doesn't crash during copy-paste operations
    await utils.checkAppResponsive();
  });

  test('should handle terminal focus and blur', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Click on terminal to focus
    await page.locator('.xterm-screen').click();
    await page.waitForTimeout(200);
    
    // Click outside terminal to blur
    await page.locator('.app-header').click();
    await page.waitForTimeout(200);
    
    // Click back on terminal
    await page.locator('.xterm-screen').click();
    await page.waitForTimeout(200);
    
    // Verify terminal is still functional after focus changes
    await utils.typeInTerminal('focus test');
    const terminalOutput = await utils.getTerminalOutput();
    expect(terminalOutput).toContain('focus');
  });

  test('should handle terminal in split panes', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Create a split
    await utils.splitHorizontal();
    await page.waitForTimeout(1000);
    
    // Test input in first terminal
    await utils.typeInTerminal('first terminal', 0);
    await page.waitForTimeout(500);
    
    // Test input in second terminal
    await utils.typeInTerminal('second terminal', 1);
    await page.waitForTimeout(500);
    
    // Verify both terminals have different content
    const firstOutput = await utils.getTerminalOutput(0);
    const secondOutput = await utils.getTerminalOutput(1);
    
    expect(firstOutput).toContain('first');
    expect(secondOutput).toContain('second');
  });

  test('should handle terminal resize', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Get initial terminal size
    const initialSize = await page.locator('.xterm-screen').boundingBox();
    
    // Resize the window
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.waitForTimeout(1000);
    
    // Get new terminal size
    const newSize = await page.locator('.xterm-screen').boundingBox();
    
    // Verify terminal resized (dimensions should be different)
    expect(newSize?.width).not.toBe(initialSize?.width);
    
    // Verify terminal is still functional after resize
    await utils.typeInTerminal('resize test');
    const terminalOutput = await utils.getTerminalOutput();
    expect(terminalOutput).toContain('resize');
  });
});