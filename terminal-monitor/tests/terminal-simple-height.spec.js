const { test, expect } = require('@playwright/test');

test.describe('Terminal Simple Height Test', () => {
  test('check basic terminal height at 1920x1080', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('http://localhost:3000');
    
    // Login
    await page.waitForSelector('input[type="text"], .terminal-list', { timeout: 15000 });
    
    try {
      const loginInput = await page.locator('input[type="text"], input[type="email"]').first();
      if (await loginInput.isVisible()) {
        await loginInput.fill('admin');
        const passwordInput = await page.locator('input[type="password"]');
        if (await passwordInput.isVisible()) {
          await passwordInput.fill('password');
        }
        const loginButton = await page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign In")');
        await loginButton.click();
        await page.waitForTimeout(2000);
      }
    } catch (e) {
      console.log('Login not required or already logged in');
    }
    
    // Select terminal
    await page.waitForSelector('.MuiListItem-root, .terminal-item', { timeout: 10000 });
    const firstTerminal = await page.locator('.MuiListItem-root, .terminal-item').first();
    await firstTerminal.click();
    await page.waitForTimeout(5000); // Wait longer for terminal to load
    
    // Check if terminal loaded
    const terminalExists = await page.locator('.xterm').count();
    console.log(`Terminal elements found: ${terminalExists}`);
    
    if (terminalExists > 0) {
      const heightInfo = await page.evaluate(() => {
        const xterm = document.querySelector('.xterm');
        const container = xterm ? xterm.closest('.MuiPaper-root') : null;
        const viewport = { width: window.innerWidth, height: window.innerHeight };
        
        if (!xterm || !container) return { error: 'Elements not found' };
        
        const xtermRect = xterm.getBoundingClientRect();
        const containerRect = container.getBoundingClientRect();
        
        return {
          viewport,
          container: { width: containerRect.width, height: containerRect.height },
          xterm: { width: xtermRect.width, height: xtermRect.height },
          utilization: xtermRect.height / viewport.height
        };
      });
      
      console.log('SIMPLE HEIGHT CHECK:', JSON.stringify(heightInfo, null, 2));
      console.log(`Terminal height: ${heightInfo.xterm.height}px`);
      console.log(`Viewport utilization: ${(heightInfo.utilization * 100).toFixed(1)}%`);
      
      // Take screenshot
      await page.screenshot({ path: 'terminal-simple-height.png', fullPage: false });
      
      // Basic expectation - terminal should use at least 35% of viewport height
      expect(heightInfo.utilization).toBeGreaterThan(0.35);
    } else {
      console.log('No terminal found - taking screenshot for debugging');
      await page.screenshot({ path: 'terminal-not-found.png', fullPage: false });
      throw new Error('Terminal did not load properly');
    }
    
    await context.close();
  });
});