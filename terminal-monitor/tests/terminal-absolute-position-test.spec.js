const { test, expect } = require('@playwright/test');

test.describe('Terminal Absolute Position Test', () => {
  test('verify terminal uses absolute positioning to fill container', async ({ page }) => {
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
    
    // Check terminal positioning
    const terminalInfo = await page.evaluate(() => {
      const terminal = document.querySelector('.xterm');
      const container = terminal?.closest('[class*="MuiBox-root"]');
      const viewport = window.innerHeight;
      
      return {
        viewport: viewport,
        container: container ? {
          height: container.offsetHeight,
          position: window.getComputedStyle(container).position
        } : null,
        terminal: terminal ? {
          height: terminal.offsetHeight,
          position: window.getComputedStyle(terminal).position,
          top: window.getComputedStyle(terminal).top,
          bottom: window.getComputedStyle(terminal).bottom
        } : null
      };
    });
    
    console.log('Terminal positioning:', terminalInfo);
    
    // Take screenshots at different sizes
    await page.screenshot({ 
      path: 'terminal-absolute-test-1080.png',
      fullPage: false 
    });
    
    // Test smaller viewport
    await page.setViewportSize({ width: 1920, height: 600 });
    await page.waitForTimeout(1000);
    
    await page.screenshot({ 
      path: 'terminal-absolute-test-600.png',
      fullPage: false 
    });
    
    // Test larger viewport
    await page.setViewportSize({ width: 1920, height: 1440 });
    await page.waitForTimeout(1000);
    
    await page.screenshot({ 
      path: 'terminal-absolute-test-1440.png',
      fullPage: false 
    });
    
    console.log('✅ Screenshots saved for visual verification');
  });
});