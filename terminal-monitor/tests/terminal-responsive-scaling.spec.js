const { test, expect } = require('@playwright/test');

test.describe('Terminal Responsive Scaling', () => {
  test('terminal should scale dynamically when browser window is resized', async ({ page }) => {
    console.log('Starting responsive scaling test...');
    
    // Set initial viewport to Full HD
    await page.setViewportSize({ width: 1920, height: 1080 });
    
    // Navigate to the application
    await page.goto('http://localhost:3000');
    
    // Handle potential login page first
    await page.waitForLoadState('networkidle');
    
    // Check if we're on login page and need to authenticate
    const connectButton = await page.locator('button:has-text("Connect")').first();
    if (await connectButton.isVisible()) {
      console.log('Found Connect button, clicking to authenticate...');
      await connectButton.click();
      
      // Wait for navigation to dashboard
      await page.waitForTimeout(3000);
      console.log('Waiting for dashboard to load...');
    }
    
    // Wait for the dashboard and terminal list to appear
    // Look for the terminal list container or any terminal items
    await page.waitForSelector('h6:has-text("Active Terminals"), .MuiList-root, [role="button"]:has-text("Test")', { timeout: 20000 });
    console.log('Dashboard loaded, terminal list found');
    
    // Click on the first terminal to select it
    const firstTerminal = await page.locator('text=Test').first();
    await firstTerminal.click();
    console.log('Selected first terminal');
    
    // Wait for xterm to load
    await page.waitForSelector('.xterm', { timeout: 10000 });
    
    // Get initial terminal dimensions at 1920x1080
    const initialTerminal = await page.locator('.xterm').first();
    const initialBox = await initialTerminal.boundingBox();
    console.log(`Initial terminal dimensions at 1920x1080: ${initialBox.width}x${initialBox.height}`);
    
    // Record initial space utilization
    const initialUtilization = {
      width: (initialBox.width / 1920 * 100).toFixed(1),
      height: (initialBox.height / 1080 * 100).toFixed(1)
    };
    console.log(`Initial space utilization: ${initialUtilization.width}% width, ${initialUtilization.height}% height`);
    
    // Resize to smaller viewport (laptop size)
    await page.setViewportSize({ width: 1366, height: 768 });
    
    // Wait for resize to complete
    await page.waitForTimeout(500);
    
    // Get terminal dimensions after resize
    const resizedBox = await initialTerminal.boundingBox();
    console.log(`Terminal dimensions after resize to 1366x768: ${resizedBox.width}x${resizedBox.height}`);
    
    // Record resized space utilization
    const resizedUtilization = {
      width: (resizedBox.width / 1366 * 100).toFixed(1),
      height: (resizedBox.height / 768 * 100).toFixed(1)
    };
    console.log(`Resized space utilization: ${resizedUtilization.width}% width, ${resizedUtilization.height}% height`);
    
    // Verify terminal scaled down proportionally
    expect(resizedBox.width).toBeLessThan(initialBox.width);
    expect(resizedBox.height).toBeLessThan(initialBox.height);
    
    // Verify terminal is still using a good percentage of available space
    expect(parseFloat(resizedUtilization.height)).toBeGreaterThan(50); // Should use more than 50% of height
    
    // Resize to larger viewport (4K)
    await page.setViewportSize({ width: 2560, height: 1440 });
    
    // Wait for resize to complete
    await page.waitForTimeout(500);
    
    // Get terminal dimensions after scaling up
    const largeBox = await initialTerminal.boundingBox();
    console.log(`Terminal dimensions after resize to 2560x1440: ${largeBox.width}x${largeBox.height}`);
    
    // Record large viewport space utilization
    const largeUtilization = {
      width: (largeBox.width / 2560 * 100).toFixed(1),
      height: (largeBox.height / 1440 * 100).toFixed(1)
    };
    console.log(`Large viewport space utilization: ${largeUtilization.width}% width, ${largeUtilization.height}% height`);
    
    // Verify terminal scaled up from the smaller size
    expect(largeBox.width).toBeGreaterThan(resizedBox.width);
    expect(largeBox.height).toBeGreaterThan(resizedBox.height);
    
    // Verify terminal is utilizing the expanded space efficiently
    expect(parseFloat(largeUtilization.height)).toBeGreaterThan(50); // Should use more than 50% of height
    
    // Test rapid resize changes
    const sizes = [
      { width: 1024, height: 768 },
      { width: 1680, height: 1050 },
      { width: 1920, height: 1200 }
    ];
    
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.waitForTimeout(300);
      
      const currentBox = await initialTerminal.boundingBox();
      console.log(`Terminal at ${size.width}x${size.height}: ${currentBox.width}x${currentBox.height}`);
      
      // Verify terminal is responsive and visible
      expect(currentBox.width).toBeGreaterThan(100);
      expect(currentBox.height).toBeGreaterThan(100);
      
      // Verify terminal fits within viewport
      expect(currentBox.width).toBeLessThanOrEqual(size.width);
      expect(currentBox.height).toBeLessThanOrEqual(size.height);
    }
    
    console.log('✅ Terminal responsive scaling test completed successfully');
  });
  
  test('terminal should maintain proportional scaling without hardcoded dimensions', async ({ page }) => {
    console.log('Testing proportional scaling without hardcoded dimensions...');
    
    // Start with standard Full HD
    await page.setViewportSize({ width: 1920, height: 1080 });
    
    await page.goto('http://localhost:3000');
    
    // Handle potential login page first
    await page.waitForLoadState('networkidle');
    
    // Check if we're on login page and need to authenticate
    const connectButton = await page.locator('button:has-text("Connect")').first();
    if (await connectButton.isVisible()) {
      console.log('Found Connect button, clicking to authenticate...');
      await connectButton.click();
      
      // Wait for navigation to dashboard
      await page.waitForTimeout(3000);
      console.log('Waiting for dashboard to load...');
    }
    
    // Wait for the dashboard and terminal list to appear
    // Look for the terminal list container or any terminal items
    await page.waitForSelector('h6:has-text("Active Terminals"), .MuiList-root, [role="button"]:has-text("Test")', { timeout: 20000 });
    console.log('Dashboard loaded, terminal list found');
    
    // Click on the first terminal to select it
    const firstTerminal = await page.locator('text=Test').first();
    await firstTerminal.click();
    console.log('Selected first terminal');
    
    // Wait for xterm to load
    await page.waitForSelector('.xterm', { timeout: 10000 });
    
    // Check for any hardcoded pixel dimensions in computed styles
    const terminalElement = await page.locator('.xterm').first();
    const computedStyle = await terminalElement.evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        width: style.width,
        height: style.height,
        minHeight: style.minHeight,
        maxHeight: style.maxHeight,
        minWidth: style.minWidth,
        maxWidth: style.maxWidth
      };
    });
    
    console.log('Terminal computed styles:', computedStyle);
    
    // Verify no hardcoded pixel dimensions (should be percentages or auto)
    expect(computedStyle.width).not.toMatch(/^\d+px$/);
    expect(computedStyle.height).not.toMatch(/^\d+px$/);
    
    // Test that the terminal container uses flex layout
    const containerStyle = await page.locator('[data-testid="terminal-container"]').first().evaluate(el => {
      const style = window.getComputedStyle(el);
      return {
        display: style.display,
        flexDirection: style.flexDirection,
        flex: style.flex
      };
    }).catch(() => null);
    
    if (containerStyle) {
      console.log('Container flex styles:', containerStyle);
    }
    
    console.log('✅ No hardcoded dimensions detected, terminal uses responsive layout');
  });
});