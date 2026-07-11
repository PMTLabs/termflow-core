const { test, expect } = require('@playwright/test');

test.describe('Terminal Simple Implementation Test', () => {
  test('verify simplified terminal fills container properly', async ({ page }) => {
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
    
    // Check terminal dimensions
    const dimensions = await page.evaluate(() => {
      const terminal = document.querySelector('.xterm');
      const viewport = window.innerHeight;
      const header = document.querySelector('header');
      const headerHeight = header ? header.offsetHeight : 0;
      
      return {
        viewport: viewport,
        headerHeight: headerHeight,
        availableHeight: viewport - headerHeight,
        terminal: terminal ? {
          height: terminal.offsetHeight,
          parentHeight: terminal.parentElement?.offsetHeight
        } : null
      };
    });
    
    console.log('Terminal dimensions:', dimensions);
    
    // Take screenshots at different sizes
    await page.screenshot({ 
      path: 'terminal-simple-1080.png',
      fullPage: false 
    });
    
    // Test smaller viewport
    await page.setViewportSize({ width: 1920, height: 600 });
    await page.waitForTimeout(1000);
    
    const smallDimensions = await page.evaluate(() => {
      const terminal = document.querySelector('.xterm');
      return terminal ? terminal.offsetHeight : 0;
    });
    console.log('Small viewport terminal height:', smallDimensions);
    
    await page.screenshot({ 
      path: 'terminal-simple-600.png',
      fullPage: false 
    });
    
    // Test larger viewport
    await page.setViewportSize({ width: 1920, height: 1440 });
    await page.waitForTimeout(1000);
    
    const largeDimensions = await page.evaluate(() => {
      const terminal = document.querySelector('.xterm');
      return terminal ? terminal.offsetHeight : 0;
    });
    console.log('Large viewport terminal height:', largeDimensions);
    
    await page.screenshot({ 
      path: 'terminal-simple-1440.png',
      fullPage: false 
    });
    
    console.log('✅ Screenshots saved for visual verification');
    
    // Verify terminal scales with viewport
    expect(smallDimensions).toBeLessThan(largeDimensions);
  });
});