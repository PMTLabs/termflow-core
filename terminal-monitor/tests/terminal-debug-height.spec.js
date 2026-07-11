const { test, expect } = require('@playwright/test');

test.describe('Terminal Height Debug', () => {
  test('debug terminal height calculation and rendering', async ({ page }) => {
    console.log('Debugging terminal height issues...');
    
    // Enable console logging to see our debug messages
    page.on('console', msg => {
      if (msg.type() === 'log' || msg.type() === 'warn' || msg.type() === 'error') {
        console.log(`[Browser] ${msg.text()}`);
      }
    });
    
    // Set viewport to Full HD
    await page.setViewportSize({ width: 1920, height: 1080 });
    
    // Navigate and authenticate
    await page.goto('http://localhost:3000');
    await page.waitForLoadState('networkidle');
    
    // Handle webpack overlay if present
    try {
      await page.locator('#webpack-dev-server-client-overlay').evaluate(el => el.remove());
    } catch (e) {
      // No overlay
    }
    
    // Authenticate
    const connectButton = await page.locator('button:has-text("Connect")').first();
    if (await connectButton.isVisible({ timeout: 5000 })) {
      await connectButton.click({ force: true });
      await page.waitForTimeout(3000);
    }
    
    // Wait for terminal list and select first terminal
    await page.waitForSelector('text=Test', { timeout: 15000 });
    await page.locator('text=Test').first().click();
    
    // Wait for xterm to load
    await page.waitForSelector('.xterm', { timeout: 10000 });
    await page.waitForTimeout(2000); // Give terminal time to fully render
    
    // Get terminal dimensions
    const terminalInfo = await page.evaluate(() => {
      const terminal = document.querySelector('.xterm');
      const viewport = document.querySelector('.xterm-viewport');
      const screen = document.querySelector('.xterm-screen');
      const canvas = document.querySelector('.xterm canvas');
      
      // Get container that holds the terminal
      const container = terminal?.closest('[class*="MuiBox-root"]');
      
      return {
        terminal: terminal ? {
          width: terminal.offsetWidth,
          height: terminal.offsetHeight,
          computedHeight: window.getComputedStyle(terminal).height,
          computedFlex: window.getComputedStyle(terminal).flex,
          boundingBox: terminal.getBoundingClientRect()
        } : null,
        viewport: viewport ? {
          width: viewport.offsetWidth,
          height: viewport.offsetHeight,
          computedHeight: window.getComputedStyle(viewport).height
        } : null,
        screen: screen ? {
          width: screen.offsetWidth,
          height: screen.offsetHeight,
          computedHeight: window.getComputedStyle(screen).height
        } : null,
        canvas: canvas ? {
          width: canvas.offsetWidth,
          height: canvas.offsetHeight,
          computedHeight: window.getComputedStyle(canvas).height
        } : null,
        container: container ? {
          width: container.offsetWidth,
          height: container.offsetHeight,
          computedHeight: window.getComputedStyle(container).height,
          computedFlex: window.getComputedStyle(container).flex
        } : null,
        viewportHeight: window.innerHeight
      };
    });
    
    console.log('\n=== Terminal Debug Info ===');
    console.log('Viewport height:', terminalInfo.viewportHeight);
    
    if (terminalInfo.container) {
      console.log('\nContainer:', {
        dimensions: `${terminalInfo.container.width}x${terminalInfo.container.height}`,
        computedHeight: terminalInfo.container.computedHeight,
        flex: terminalInfo.container.computedFlex
      });
    }
    
    if (terminalInfo.terminal) {
      console.log('\nTerminal element:', {
        dimensions: `${terminalInfo.terminal.width}x${terminalInfo.terminal.height}`,
        computedHeight: terminalInfo.terminal.computedHeight,
        flex: terminalInfo.terminal.computedFlex,
        boundingBox: terminalInfo.terminal.boundingBox
      });
      
      // Check if terminal is using full container height
      if (terminalInfo.container) {
        const utilizationPct = (terminalInfo.terminal.height / terminalInfo.container.height * 100).toFixed(1);
        console.log(`Terminal utilization: ${utilizationPct}% of container height`);
      }
    }
    
    if (terminalInfo.canvas) {
      console.log('\nCanvas element:', {
        dimensions: `${terminalInfo.canvas.width}x${terminalInfo.canvas.height}`,
        computedHeight: terminalInfo.canvas.computedHeight
      });
    }
    
    // Take a screenshot for visual verification
    await page.screenshot({ 
      path: 'D:/sources/demo/auto-terminal/terminal-monitor/debug-height-test.png',
      fullPage: false 
    });
    console.log('\n✅ Screenshot saved as debug-height-test.png');
    
    // Wait a bit to see console logs
    await page.waitForTimeout(2000);
    
    console.log('\n=== End Debug Info ===\n');
  });
});