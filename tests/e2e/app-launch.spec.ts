import { test, expect, ElectronTestUtils } from '../utils/electron-launcher';

test.describe('App Launch Tests', () => {
  test('should launch the app successfully', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    // Wait for app to be ready
    await utils.waitForAppReady();
    
    // Verify app launched with correct window title
    const title = await utils.getWindowTitle();
    expect(title).toContain('auto-terminal');
    
    // Verify main UI components are visible
    await utils.checkAppResponsive();
  });

  test('should create initial tab on startup', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Check that at least one tab is created
    const tabCount = await utils.getTabCount();
    expect(tabCount).toBeGreaterThan(0);
    
    // Check tab title
    const tabTitle = await utils.getActiveTabTitle();
    expect(tabTitle).toContain('Terminal');
  });

  test('should display terminal in initial tab', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Verify terminal display is present
    await expect(page.locator('.xterm-screen')).toBeVisible({ timeout: 10000 });
    
    // Verify terminal is interactive (can receive focus)
    await page.locator('.xterm-screen').click();
    const focused = await page.locator('.xterm-screen').evaluate(el => 
      el === document.activeElement || el.contains(document.activeElement)
    );
    expect(focused).toBe(true);
  });

  test('should show status bar', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Verify status bar is visible
    await expect(page.locator('.app-footer')).toBeVisible();
  });

  test('should handle window resize', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Get initial size
    const initialSize = await page.viewportSize();
    
    // Resize window
    await page.setViewportSize({ width: 1200, height: 800 });
    
    // Verify app still responsive after resize
    await utils.checkAppResponsive();
    
    // Verify terminal adapts to new size
    await expect(page.locator('.xterm-screen')).toBeVisible();
  });

  test('should handle app close gracefully', async ({ electronApp, page }) => {
    const utils = new ElectronTestUtils(page, electronApp);
    
    await utils.waitForAppReady();
    
    // Verify app is running
    expect(electronApp).toBeTruthy();
    
    // The app will be closed automatically by the fixture
    // This test ensures no crashes occur during normal shutdown
  });
});