const { test, expect } = require('@playwright/test');

test.describe('Terminal Rows Investigation', () => {
  test('check actual terminal rows vs expected', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Wait for authentication or login page
    await page.waitForSelector('input[type="text"], input[type="email"], .terminal-list, .MuiPaper-root', { timeout: 10000 });
    
    // Handle login if needed
    const loginInput = await page.locator('input[type="text"], input[type="email"]').first();
    if (await loginInput.isVisible()) {
      await loginInput.fill('admin');
      const passwordInput = await page.locator('input[type="password"]');
      if (await passwordInput.isVisible()) {
        await passwordInput.fill('password');
      }
      const loginButton = await page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign In")');
      await loginButton.click();
      await page.waitForSelector('.terminal-list, .MuiPaper-root', { timeout: 10000 });
    }
    
    // Wait for terminal list and click first terminal
    await page.waitForSelector('[data-testid="terminal-list"], .terminal-list, .MuiList-root', { timeout: 10000 });
    const firstTerminal = await page.locator('[data-testid="terminal-item"], .MuiListItem-root, .terminal-item').first();
    if (await firstTerminal.isVisible()) {
      await firstTerminal.click();
      await page.waitForTimeout(3000); // Wait for terminal to fully initialize
    }
    
    // Wait for terminal display
    await page.waitForSelector('.xterm, [class*="xterm"]', { timeout: 10000 });
    
    // Get detailed terminal information
    const terminalInfo = await page.evaluate(() => {
      const xterm = document.querySelector('.xterm');
      if (!xterm) return { error: 'No xterm element found' };
      
      // Get the actual terminal instance if possible
      const xtermInstance = window._xtermInstance; // We might need to expose this
      
      // Count visible rows in the DOM
      const rows = xterm.querySelectorAll('.xterm-rows > *');
      const viewport = xterm.querySelector('.xterm-viewport');
      const screen = xterm.querySelector('.xterm-screen');
      
      // Get container dimensions
      const container = xterm.parentElement;
      const containerRect = container.getBoundingClientRect();
      const xtermRect = xterm.getBoundingClientRect();
      const viewportRect = viewport ? viewport.getBoundingClientRect() : null;
      const screenRect = screen ? screen.getBoundingClientRect() : null;
      
      // Calculate expected rows based on container height
      const charHeight = 14.4; // From our code
      const padding = 16; // 8px on each side
      const availableHeight = containerRect.height - padding;
      const expectedRows = Math.floor(availableHeight / charHeight);
      
      return {
        container: {
          width: containerRect.width,
          height: containerRect.height
        },
        xterm: {
          width: xtermRect.width,
          height: xtermRect.height
        },
        viewport: viewportRect ? {
          width: viewportRect.width,
          height: viewportRect.height
        } : null,
        screen: screenRect ? {
          width: screenRect.width, 
          height: screenRect.height
        } : null,
        domRows: rows.length,
        expectedRows: expectedRows,
        availableHeight: availableHeight,
        charHeight: charHeight,
        actualRowElements: Array.from(rows).slice(0, 5).map(row => ({
          height: row.getBoundingClientRect().height,
          visible: row.style.display !== 'none',
          content: row.textContent?.slice(0, 50) || 'empty'
        }))
      };
    });
    
    console.log('Terminal Investigation:', JSON.stringify(terminalInfo, null, 2));
    
    if (terminalInfo.error) {
      throw new Error(terminalInfo.error);
    }
    
    // Expected vs actual analysis
    const heightRatio = terminalInfo.expectedRows > 0 ? terminalInfo.domRows / terminalInfo.expectedRows : 0;
    console.log(`Expected rows: ${terminalInfo.expectedRows}`);
    console.log(`Actual DOM rows: ${terminalInfo.domRows}`);
    console.log(`Row utilization: ${(heightRatio * 100).toFixed(1)}%`);
    
    if (heightRatio < 0.5) {
      console.warn('🚨 MAJOR ISSUE: Terminal using less than 50% of expected rows!');
      console.warn(`Container height: ${terminalInfo.container.height}px`);
      console.warn(`Expected rows: ${terminalInfo.expectedRows}, Actual: ${terminalInfo.domRows}`);
    }
    
    // Check if viewport is the issue
    if (terminalInfo.viewport && terminalInfo.screen) {
      console.log(`Viewport height: ${terminalInfo.viewport.height}px`);
      console.log(`Screen height: ${terminalInfo.screen.height}px`);
      
      if (terminalInfo.viewport.height < terminalInfo.container.height * 0.8) {
        console.warn('🚨 VIEWPORT ISSUE: Viewport much smaller than container!');
      }
    }
  });
});