const { test, expect } = require('@playwright/test');

test.describe('Terminal Height Responsiveness', () => {
  test('terminal height should change when viewport height changes', async ({ page }) => {
    console.log('Testing terminal height responsiveness...');
    
    // Set initial viewport to Full HD
    await page.setViewportSize({ width: 1920, height: 1080 });
    
    // Navigate to the application
    await page.goto('http://localhost:3000');
    
    // Handle authentication
    await page.waitForLoadState('networkidle');
    const connectButton = await page.locator('button:has-text("Connect")').first();
    if (await connectButton.isVisible()) {
      console.log('Clicking Connect button...');
      await connectButton.click();
      await page.waitForTimeout(3000);
    }
    
    // Wait for dashboard and select terminal
    await page.waitForSelector('h6:has-text("Active Terminals"), .MuiList-root, [role="button"]:has-text("Test")', { timeout: 20000 });
    const firstTerminal = await page.locator('text=Test').first();
    await firstTerminal.click();
    await page.waitForSelector('.xterm', { timeout: 10000 });
    
    // Get initial terminal height at 1080px viewport
    const terminal = await page.locator('.xterm').first();
    const initialBox = await terminal.boundingBox();
    console.log(`Initial terminal height at 1080px viewport: ${initialBox.height}px`);
    
    // Resize to smaller height (768px)
    await page.setViewportSize({ width: 1920, height: 768 });
    await page.waitForTimeout(1000); // Wait for resize to complete
    
    // Get terminal height after viewport resize
    const smallerBox = await terminal.boundingBox();
    console.log(`Terminal height after resize to 768px viewport: ${smallerBox.height}px`);
    
    // The height should have changed (reduced)
    console.log(`Height change: ${initialBox.height}px → ${smallerBox.height}px (${(smallerBox.height - initialBox.height).toFixed(1)}px difference)`);
    
    if (smallerBox.height === initialBox.height) {
      console.error('❌ ISSUE: Terminal height did not change when viewport height changed!');
      console.error('This indicates the terminal is not responsive to viewport height changes.');
    } else {
      console.log('✅ SUCCESS: Terminal height changed with viewport height');
    }
    
    // Resize to larger height (1440px)
    await page.setViewportSize({ width: 1920, height: 1440 });
    await page.waitForTimeout(1000);
    
    // Get terminal height after scaling up
    const largerBox = await terminal.boundingBox();
    console.log(`Terminal height after resize to 1440px viewport: ${largerBox.height}px`);
    
    // Check if height increased
    if (largerBox.height > smallerBox.height) {
      console.log('✅ SUCCESS: Terminal height increased with larger viewport');
    } else {
      console.error('❌ ISSUE: Terminal height did not increase with larger viewport');
    }
    
    // Check computed styles to verify no hardcoded pixel dimensions
    const computedStyle = await terminal.evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        width: style.width,
        height: style.height,
        display: style.display,
        flex: style.flex,
        flexGrow: style.flexGrow
      };
    });
    
    console.log('Terminal computed styles:', computedStyle);
    
    // Verify responsive layout
    if (computedStyle.flex && computedStyle.flex !== 'none') {
      console.log('✅ Terminal uses flex layout');
    } else {
      console.log('⚠️  Terminal may not be using optimal flex layout');
    }
    
    // Final verification - terminal should respond to container changes
    expect(smallerBox.height).not.toEqual(initialBox.height);
    expect(largerBox.height).toBeGreaterThan(smallerBox.height);
    
    console.log('✅ Terminal height responsiveness test completed');
  });
});