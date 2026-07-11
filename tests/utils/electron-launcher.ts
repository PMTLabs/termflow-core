import { test as base, expect, ElectronApplication, Page, _electron as electron } from '@playwright/test';
import path from 'path';

// Extend basic test by providing "electronApp" and "page" fixtures
export const test = base.extend<{
  electronApp: ElectronApplication;
  page: Page;
}>({
  electronApp: async ({}, use) => {
    // Launch Electron app
    const electronApp = await electron.launch({
      args: [path.join(__dirname, '../../dist/main/main.js')],
      // Enable debugging if needed
      // executablePath: require('electron'), // for development
    });

    // Wait for the first window to open
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    
    // Use the app
    await use(electronApp);
    
    // Close app
    await electronApp.close();
  },
  
  page: async ({ electronApp }, use) => {
    // Get the first window (main window)
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    
    // Use the page
    await use(page);
  }
});

export { expect } from '@playwright/test';

// Helper functions for common Electron app interactions
export class ElectronTestUtils {
  constructor(public page: Page, public app: ElectronApplication) {}

  /**
   * Wait for the app to be fully loaded
   */
  async waitForAppReady() {
    // Wait for the app container to be visible
    await this.page.waitForSelector('.app', { state: 'visible' });
    
    // Wait for initial tab to be created
    await this.page.waitForSelector('[data-testid="tab"]', { timeout: 10000 });
  }

  /**
   * Create a new tab via menu
   */
  async createNewTab() {
    // Trigger the menu action for new tab
    await this.page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('menu:newTab'));
    });
    
    // Wait for new tab to appear
    await this.page.waitForSelector('[data-testid="tab"]:last-child');
  }

  /**
   * Close a tab
   */
  async closeTab(tabIndex: number = 0) {
    const tabs = await this.page.locator('[data-testid="tab"]').all();
    if (tabs[tabIndex]) {
      await tabs[tabIndex].locator('[data-testid="close-tab"]').click();
    }
  }

  /**
   * Split pane horizontally
   */
  async splitHorizontal() {
    await this.page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('menu:splitHorizontal'));
    });
  }

  /**
   * Split pane vertically
   */
  async splitVertical() {
    await this.page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('menu:splitVertical'));
    });
  }

  /**
   * Type text into terminal
   */
  async typeInTerminal(text: string, terminalIndex: number = 0) {
    const terminal = this.page.locator('.xterm-screen').nth(terminalIndex);
    await terminal.click();
    await this.page.keyboard.type(text);
  }

  /**
   * Press Enter in terminal
   */
  async pressEnterInTerminal(terminalIndex: number = 0) {
    const terminal = this.page.locator('.xterm-screen').nth(terminalIndex);
    await terminal.click();
    await this.page.keyboard.press('Enter');
  }

  /**
   * Get terminal output text
   */
  async getTerminalOutput(terminalIndex: number = 0): Promise<string> {
    const terminal = this.page.locator('.xterm-screen').nth(terminalIndex);
    return await terminal.textContent() || '';
  }

  /**
   * Wait for text to appear in terminal
   */
  async waitForTerminalText(text: string, terminalIndex: number = 0, timeout: number = 5000) {
    const terminal = this.page.locator('.xterm-screen').nth(terminalIndex);
    await expect(terminal).toContainText(text, { timeout });
  }

  /**
   * Take a screenshot for debugging
   */
  async takeScreenshot(name: string) {
    await this.page.screenshot({ path: `test-results/${name}-${Date.now()}.png` });
  }

  /**
   * Get window title
   */
  async getWindowTitle(): Promise<string> {
    return await this.page.title();
  }

  /**
   * Check if app is responsive
   */
  async checkAppResponsive() {
    // Check if main elements are visible and responsive
    await expect(this.page.locator('.app')).toBeVisible();
    await expect(this.page.locator('.app-header')).toBeVisible();
    await expect(this.page.locator('.app-body')).toBeVisible();
    await expect(this.page.locator('.app-footer')).toBeVisible();
  }

  /**
   * Get tab count
   */
  async getTabCount(): Promise<number> {
    return await this.page.locator('[data-testid="tab"]').count();
  }

  /**
   * Get active tab title
   */
  async getActiveTabTitle(): Promise<string> {
    const activeTab = this.page.locator('[data-testid="tab"].active');
    return await activeTab.locator('[data-testid="tab-title"]').textContent() || '';
  }

  /**
   * Click on a specific tab
   */
  async clickTab(tabIndex: number) {
    const tabs = await this.page.locator('[data-testid="tab"]').all();
    if (tabs[tabIndex]) {
      await tabs[tabIndex].click();
    }
  }
}