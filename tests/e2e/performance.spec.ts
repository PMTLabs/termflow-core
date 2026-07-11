import { test, expect, ElectronTestUtils } from '../utils/electron-launcher';

test.describe('Performance Tests', () => {
  test('should launch app within reasonable time', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    const startTime = Date.now();
    await utils.waitForAppReady();
    const launchTime = Date.now() - startTime;
    
    // App should launch within 10 seconds
    expect(launchTime).toBeLessThan(10000);
    
    console.log(`App launch time: ${launchTime}ms`);
  });

  test('should create tabs quickly', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    const startTime = Date.now();
    
    // Create 5 tabs
    for (let i = 0; i < 5; i++) {
      await utils.createNewTab();
    }
    
    const totalTime = Date.now() - startTime;
    const avgTimePerTab = totalTime / 5;
    
    // Each tab should be created within 1 second on average
    expect(avgTimePerTab).toBeLessThan(1000);
    
    console.log(`Average tab creation time: ${avgTimePerTab}ms`);
  });

  test('should handle rapid input without significant delay', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    const startTime = Date.now();
    
    // Type a long string rapidly
    const longText = 'a'.repeat(100);
    await utils.typeInTerminal(longText);
    
    const inputTime = Date.now() - startTime;
    
    // Should handle 100 characters within 2 seconds
    expect(inputTime).toBeLessThan(2000);
    
    console.log(`Rapid input time for 100 chars: ${inputTime}ms`);
  });

  test('should handle multiple splits without significant performance degradation', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    const startTime = Date.now();
    
    // Create multiple splits
    for (let i = 0; i < 4; i++) {
      await utils.splitHorizontal();
      await page.waitForTimeout(200);
    }
    
    const splitTime = Date.now() - startTime;
    
    // Multiple splits should complete within 5 seconds
    expect(splitTime).toBeLessThan(5000);
    
    // Verify all terminals are responsive
    const terminalCount = await page.locator('.xterm-screen').count();
    expect(terminalCount).toBeGreaterThanOrEqual(4);
    
    console.log(`Multiple splits time: ${splitTime}ms, terminals: ${terminalCount}`);
  });

  test('should maintain responsiveness under load', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Create multiple tabs and splits
    await utils.createNewTab();
    await utils.createNewTab();
    await utils.splitHorizontal();
    await utils.splitVertical();
    
    // Test responsiveness by checking UI interactions
    const startTime = Date.now();
    
    // Click between tabs
    await utils.clickTab(0);
    await utils.clickTab(1);
    await utils.clickTab(0);
    
    // Type in terminal
    await utils.typeInTerminal('performance test');
    
    const interactionTime = Date.now() - startTime;
    
    // UI interactions should remain fast even with multiple elements
    expect(interactionTime).toBeLessThan(1000);
    
    console.log(`UI interaction time under load: ${interactionTime}ms`);
  });

  test('should not consume excessive memory', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Get initial memory usage (this is basic check)
    const initialMetrics = await page.evaluate(() => ({
      memory: (performance as any).memory?.usedJSHeapSize || 0,
      timing: performance.timing.loadEventEnd - performance.timing.navigationStart
    }));
    
    // Create some load
    for (let i = 0; i < 3; i++) {
      await utils.createNewTab();
      await utils.splitHorizontal();
      await utils.typeInTerminal(`test command ${i}`);
    }
    
    // Check memory after load
    const finalMetrics = await page.evaluate(() => ({
      memory: (performance as any).memory?.usedJSHeapSize || 0
    }));
    
    // Memory growth should be reasonable (less than 50MB for this test)
    const memoryGrowth = finalMetrics.memory - initialMetrics.memory;
    expect(memoryGrowth).toBeLessThan(50 * 1024 * 1024); // 50MB
    
    console.log(`Memory growth: ${Math.round(memoryGrowth / 1024 / 1024)}MB`);
    console.log(`Initial load time: ${initialMetrics.timing}ms`);
  });

  test('should handle window resize efficiently', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    const sizes = [
      { width: 800, height: 600 },
      { width: 1200, height: 800 },
      { width: 1600, height: 1000 },
      { width: 1000, height: 700 }
    ];
    
    const startTime = Date.now();
    
    for (const size of sizes) {
      await page.setViewportSize(size);
      await page.waitForTimeout(100); // Small delay for resize
      await utils.checkAppResponsive();
    }
    
    const resizeTime = Date.now() - startTime;
    
    // All resizes should complete within 2 seconds
    expect(resizeTime).toBeLessThan(2000);
    
    console.log(`Window resize cycle time: ${resizeTime}ms`);
  });
});