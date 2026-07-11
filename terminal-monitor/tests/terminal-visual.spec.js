const { test, expect } = require('@playwright/test');

test.describe('Terminal Visual Display', () => {
  test('verify terminal fills full container height', async ({ page }) => {
    // Start the terminal-monitor dev server first
    await page.goto('http://localhost:3000');
    
    // Wait for authentication or login page
    await page.waitForSelector('input[type="text"], input[type="email"], .terminal-list, .MuiPaper-root', { timeout: 10000 });
    
    // Check if we're on login page
    const loginInput = await page.locator('input[type="text"], input[type="email"]').first();
    if (await loginInput.isVisible()) {
      // Fill in login (assuming default credentials)
      await loginInput.fill('admin');
      const passwordInput = await page.locator('input[type="password"]');
      if (await passwordInput.isVisible()) {
        await passwordInput.fill('password');
      }
      const loginButton = await page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign In")');
      await loginButton.click();
      
      // Wait for redirect to dashboard
      await page.waitForSelector('.terminal-list, .MuiPaper-root', { timeout: 10000 });
    }
    
    // Wait for terminal list to load
    await page.waitForSelector('[data-testid="terminal-list"], .terminal-list, .MuiList-root', { timeout: 10000 });
    
    // Click on first terminal if available, or create one
    const firstTerminal = await page.locator('[data-testid="terminal-item"], .MuiListItem-root, .terminal-item').first();
    if (await firstTerminal.isVisible()) {
      await firstTerminal.click();
      await page.waitForTimeout(2000);
    }
    
    // Wait for terminal display to load
    await page.waitForSelector('.xterm, [class*="xterm"], .terminal-display', { timeout: 10000 });
    
    // Take screenshot for visual inspection
    await page.screenshot({ 
      path: 'terminal-display-screenshot.png',
      fullPage: true 
    });
    
    // Measure container and xterm dimensions
    const containerInfo = await page.evaluate(() => {
      // Find the terminal container
      const containers = [
        document.querySelector('[data-testid="terminal-container"]'),
        document.querySelector('.terminal-container'),
        document.querySelector('[class*="TerminalInstance"]'),
        document.querySelector('.xterm')?.parentElement,
      ].filter(el => el);
      
      const xtermElements = [
        document.querySelector('.xterm'),
        document.querySelector('[class*="xterm"]'),
        document.querySelector('.terminal'),
      ].filter(el => el);
      
      if (containers.length === 0 || xtermElements.length === 0) {
        return {
          error: 'Terminal elements not found',
          containers: containers.length,
          xterms: xtermElements.length,
          allElements: Array.from(document.querySelectorAll('*')).map(el => el.className).filter(c => c.includes('term') || c.includes('xterm')).slice(0, 10)
        };
      }
      
      const container = containers[0];
      const xterm = xtermElements[0];
      
      const containerRect = container.getBoundingClientRect();
      const xtermRect = xterm.getBoundingClientRect();
      
      return {
        container: {
          width: containerRect.width,
          height: containerRect.height,
          top: containerRect.top,
          className: container.className
        },
        xterm: {
          width: xtermRect.width,
          height: xtermRect.height,
          top: xtermRect.top,
          className: xterm.className
        },
        heightRatio: xtermRect.height / containerRect.height,
        isFullHeight: xtermRect.height >= containerRect.height * 0.9, // 90% or more
        visualGap: containerRect.height - xtermRect.height
      };
    });
    
    console.log('Terminal dimensions:', JSON.stringify(containerInfo, null, 2));
    
    // Check if terminal is using full height
    if (containerInfo.error) {
      console.error('Terminal measurement error:', containerInfo.error);
      throw new Error(`Terminal elements not found: ${containerInfo.error}`);
    }
    
    // Visual verification
    expect(containerInfo.heightRatio).toBeGreaterThan(0.8); // Should use at least 80% of container height
    expect(containerInfo.visualGap).toBeLessThan(50); // Should have less than 50px gap
    
    console.log(`Terminal height ratio: ${(containerInfo.heightRatio * 100).toFixed(1)}%`);
    console.log(`Visual gap: ${containerInfo.visualGap}px`);
    
    if (containerInfo.visualGap > 50) {
      console.warn('🚨 ISSUE DETECTED: Terminal has significant visual gap!');
      console.warn(`Container: ${containerInfo.container.height}px, Terminal: ${containerInfo.xterm.height}px`);
    }
  });
});