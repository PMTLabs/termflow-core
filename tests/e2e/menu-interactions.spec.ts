import { test, expect, ElectronTestUtils } from '../utils/electron-launcher';

test.describe('Menu Interactions', () => {
  test('should create new tab via menu event', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Get initial tab count
    const initialTabCount = await utils.getTabCount();
    
    // Create new tab
    await utils.createNewTab();
    
    // Verify new tab was created
    const newTabCount = await utils.getTabCount();
    expect(newTabCount).toBe(initialTabCount + 1);
    
    // Verify new tab is visible
    const tabs = page.locator('[data-testid="tab"]');
    await expect(tabs.nth(newTabCount - 1)).toBeVisible();
  });

  test('should create multiple tabs', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    const initialTabCount = await utils.getTabCount();
    
    // Create 3 new tabs
    for (let i = 0; i < 3; i++) {
      await utils.createNewTab();
      await page.waitForTimeout(500); // Small delay between creations
    }
    
    // Verify all tabs were created
    const finalTabCount = await utils.getTabCount();
    expect(finalTabCount).toBe(initialTabCount + 3);
  });

  test('should split pane horizontally', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Get initial terminal count
    const initialTerminals = await page.locator('.xterm-screen').count();
    
    // Split horizontally
    await utils.splitHorizontal();
    
    // Wait for split to complete
    await page.waitForTimeout(1000);
    
    // Verify new terminal pane was created
    const newTerminals = await page.locator('.xterm-screen').count();
    expect(newTerminals).toBeGreaterThan(initialTerminals);
  });

  test('should split pane vertically', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Get initial terminal count
    const initialTerminals = await page.locator('.xterm-screen').count();
    
    // Split vertically
    await utils.splitVertical();
    
    // Wait for split to complete
    await page.waitForTimeout(1000);
    
    // Verify new terminal pane was created
    const newTerminals = await page.locator('.xterm-screen').count();
    expect(newTerminals).toBeGreaterThan(initialTerminals);
  });

  test('should handle multiple splits', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Create multiple splits
    await utils.splitHorizontal();
    await page.waitForTimeout(500);
    
    await utils.splitVertical();
    await page.waitForTimeout(500);
    
    await utils.splitHorizontal();
    await page.waitForTimeout(500);
    
    // Verify multiple terminals exist
    const terminalCount = await page.locator('.xterm-screen').count();
    expect(terminalCount).toBeGreaterThan(3);
  });

  test('should switch between tabs', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Create a second tab
    await utils.createNewTab();
    
    // Click on first tab
    await utils.clickTab(0);
    await page.waitForTimeout(200);
    
    // Verify first tab is active
    const firstTabActive = await page.locator('[data-testid="tab"]').nth(0).getAttribute('class');
    expect(firstTabActive).toContain('active');
    
    // Click on second tab
    await utils.clickTab(1);
    await page.waitForTimeout(200);
    
    // Verify second tab is active
    const secondTabActive = await page.locator('[data-testid="tab"]').nth(1).getAttribute('class');
    expect(secondTabActive).toContain('active');
  });

  test('should handle close tab action', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Create additional tabs so we can close one
    await utils.createNewTab();
    await utils.createNewTab();
    
    const initialTabCount = await utils.getTabCount();
    expect(initialTabCount).toBeGreaterThan(1);
    
    // Close a tab (if close button exists)
    const closeButton = page.locator('[data-testid="close-tab"]').first();
    if (await closeButton.isVisible()) {
      await closeButton.click();
      await page.waitForTimeout(500);
      
      // Verify tab was closed
      const newTabCount = await utils.getTabCount();
      expect(newTabCount).toBe(initialTabCount - 1);
    }
  });

  test('should maintain state after menu interactions', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Perform various menu actions
    await utils.createNewTab();
    await utils.splitHorizontal();
    await utils.createNewTab();
    await utils.splitVertical();
    
    // Verify app is still responsive
    await utils.checkAppResponsive();
    
    // Verify terminals are still functional
    const terminals = await page.locator('.xterm-screen').all();
    for (const terminal of terminals) {
      await expect(terminal).toBeVisible();
    }
  });
});