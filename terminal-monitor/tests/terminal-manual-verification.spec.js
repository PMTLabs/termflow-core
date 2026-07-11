const { test, expect } = require('@playwright/test');

test.describe('Terminal Manual Verification', () => {
  test('take screenshots at different viewport sizes for manual verification', async ({ page }) => {
    console.log('Taking screenshots for manual verification...');
    
    // Navigate and authenticate  
    await page.goto('http://localhost:3000');
    await page.waitForLoadState('networkidle');
    
    // Handle any webpack overlay
    try {
      await page.locator('#webpack-dev-server-client-overlay').waitFor({ timeout: 1000 });
      await page.locator('#webpack-dev-server-client-overlay').evaluate(el => el.remove());
    } catch (e) {
      // No overlay, continue
    }
    
    // Authenticate
    try {
      const connectButton = await page.locator('button:has-text("Connect")').first();
      if (await connectButton.isVisible({ timeout: 5000 })) {
        await connectButton.click({ force: true });
        await page.waitForTimeout(3000);
      }
    } catch (e) {
      console.log('Connect button not found or already connected');
    }
    
    // Wait for dashboard
    await page.waitForSelector('text=Test', { timeout: 15000 });
    await page.locator('text=Test').first().click();
    await page.waitForSelector('.xterm', { timeout: 10000 });
    
    // Take screenshot at Full HD (1920x1080)
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.waitForTimeout(1000);
    await page.screenshot({ 
      path: 'D:/sources/demo/auto-terminal/terminal-monitor/responsive-test-1920x1080.png',
      fullPage: false 
    });
    console.log('✅ Screenshot taken at 1920x1080');
    
    // Take screenshot at smaller height (1920x768)  
    await page.setViewportSize({ width: 1920, height: 768 });
    await page.waitForTimeout(1000);
    await page.screenshot({ 
      path: 'D:/sources/demo/auto-terminal/terminal-monitor/responsive-test-1920x768.png',
      fullPage: false 
    });
    console.log('✅ Screenshot taken at 1920x768');
    
    // Take screenshot at larger height (1920x1440)
    await page.setViewportSize({ width: 1920, height: 1440 });
    await page.waitForTimeout(1000);
    await page.screenshot({ 
      path: 'D:/sources/demo/auto-terminal/terminal-monitor/responsive-test-1920x1440.png',
      fullPage: false 
    });
    console.log('✅ Screenshot taken at 1920x1440');
    
    // Get terminal dimensions for verification
    const terminal = await page.locator('.xterm').first();
    const finalBox = await terminal.boundingBox();
    console.log(`Final terminal dimensions: ${finalBox.width}x${finalBox.height}`);
    
    // Get computed styles
    const computedStyle = await terminal.evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        width: style.width,
        height: style.height,
        display: style.display,
        flex: style.flex
      };
    });
    console.log('Final computed styles:', computedStyle);
    
    console.log('✅ Manual verification screenshots completed');
    console.log('Check the generated PNG files to see if terminal height is responsive');
  });
});