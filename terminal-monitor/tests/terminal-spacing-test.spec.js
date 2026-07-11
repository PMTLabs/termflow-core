const { test, expect } = require('@playwright/test');

test.describe('Terminal Layout Spacing Test', () => {
  test('verify proper spacing and terminal height', async ({ page }) => {
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
    
    // Check spacing and dimensions
    const layoutInfo = await page.evaluate(() => {
      const header = document.querySelector('header');
      const mainContent = header?.nextElementSibling;
      const terminal = document.querySelector('.xterm');
      
      return {
        header: header ? {
          height: header.offsetHeight,
          bottom: header.getBoundingClientRect().bottom
        } : null,
        mainContent: mainContent ? {
          top: mainContent.getBoundingClientRect().top,
          paddingTop: window.getComputedStyle(mainContent).paddingTop
        } : null,
        terminal: terminal ? {
          height: terminal.offsetHeight
        } : null,
        spacing: header && mainContent ? 
          mainContent.getBoundingClientRect().top - header.getBoundingClientRect().bottom : 0
      };
    });
    
    console.log('Layout info:', layoutInfo);
    console.log(`Spacing between header and content: ${layoutInfo.spacing}px`);
    console.log(`Terminal height: ${layoutInfo.terminal?.height}px`);
    
    // Take screenshot
    await page.screenshot({ 
      path: 'terminal-spacing-test.png',
      fullPage: false 
    });
    
    // Verify spacing exists
    expect(layoutInfo.spacing).toBeGreaterThan(0);
    
    // Verify terminal still has good height
    expect(layoutInfo.terminal?.height).toBeGreaterThan(400);
  });
});