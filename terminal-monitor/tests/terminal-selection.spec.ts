import { test, expect } from '@playwright/test';

// Helper to wait for terminal to be ready
async function waitForTerminalReady(page) {
  // Wait for the terminal container to be visible
  await page.waitForSelector('.xterm', { state: 'visible', timeout: 10000 });
  // Give xterm time to initialize
  await page.waitForTimeout(500);
}

test.describe('Terminal Selection', () => {
  test('should login successfully', async ({ page }) => {
    // Navigate to the app
    await page.goto('http://localhost:3000/login');
    
    // Should be on login page
    await expect(page).toHaveURL(/.*\/login/);
    
    // Wait for the form to be ready
    await page.waitForSelector('input[id="clientId"]', { state: 'visible' });
    
    // Fill in credentials
    await page.fill('input[id="clientId"]', 'terminal-monitor');
    
    // Take screenshot before clicking
    await page.screenshot({ path: 'before-login.png' });
    
    // Click connect button
    await page.click('button:has-text("Connect")');
    
    // Wait a bit for any response
    await page.waitForTimeout(2000);
    
    // Take screenshot after clicking
    await page.screenshot({ path: 'after-login.png' });
    
    // Log current URL
    console.log('URL after login:', await page.url());
    
    // Should navigate to dashboard or root
    await page.waitForURL((url) => url.pathname === '/' || url.pathname === '/dashboard', { timeout: 10000 });
    
    // Should see the terminal list
    await expect(page.locator('h6:has-text("Active Terminals")')).toBeVisible({ timeout: 10000 });
  });
  
  test.beforeEach(async ({ page }) => {
    // Navigate to the app
    await page.goto('http://localhost:3000');
    
    // Handle login if needed
    const currentUrl = await page.url();
    console.log('Current URL:', currentUrl);
    
    if (currentUrl.includes('/login')) {
      // Fill in the client ID field - use the correct selector
      await page.fill('input[id="clientId"]', 'terminal-monitor');
      
      // Click the Connect button
      await page.click('button:has-text("Connect")');
      
      // Wait for either dashboard navigation or error message
      await Promise.race([
        page.waitForURL('**/dashboard', { timeout: 10000 }),
        page.waitForSelector('text=Failed to authenticate', { timeout: 10000 })
      ]).catch(async (e) => {
        // Log current state if login fails
        const errorText = await page.textContent('body');
        console.error('Login failed. Page content:', errorText);
        throw e;
      });
    }
    
    // Wait for dashboard to load - look for the terminal list container
    await page.waitForSelector('h6:has-text("Active Terminals")', { timeout: 10000 });
  });

  test('should create and select terminals without dimension errors', async ({ page }) => {
    // Listen for console errors
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Create first terminal
    await page.click('button:has-text("New Terminal")');
    // Wait for dialog to appear
    await page.waitForSelector('text=Create New Terminal', { timeout: 5000 });
    // Click Create button in dialog
    await page.click('button:has-text("Create")');
    await page.waitForTimeout(1000);
    
    // Wait for terminal to appear in the list
    await page.waitForSelector('li[role="button"]:has-text("Terminal")', { timeout: 5000 });
    
    // Click on the first terminal
    const firstTerminal = await page.locator('li[role="button"]').first();
    await firstTerminal.click();
    
    // Wait for terminal to be displayed
    await waitForTerminalReady(page);
    
    // Create second terminal
    await page.click('button:has-text("New Terminal")');
    await page.waitForSelector('text=Create New Terminal', { timeout: 5000 });
    await page.click('button:has-text("Create")');
    await page.waitForTimeout(1000);
    
    // Now we should have 2 terminals
    const terminalCount = await page.locator('li[role="button"]').count();
    expect(terminalCount).toBe(2);
    
    // Click on the second terminal
    const secondTerminal = await page.locator('li[role="button"]').nth(1);
    await secondTerminal.click();
    
    // Wait for terminal to switch
    await waitForTerminalReady(page);
    
    // Click back on the first terminal
    await firstTerminal.click();
    await waitForTerminalReady(page);
    
    // Click on second terminal again
    await secondTerminal.click();
    await waitForTerminalReady(page);
    
    // Check that no dimension errors occurred
    const dimensionErrors = consoleErrors.filter(error => 
      error.includes('Cannot read properties of undefined') && 
      error.includes('dimensions')
    );
    
    expect(dimensionErrors).toHaveLength(0);
  });

  test('should handle rapid terminal switching', async ({ page }) => {
    // Listen for console errors
    const consoleErrors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });

    // Create 3 terminals
    for (let i = 0; i < 3; i++) {
      await page.click('button:has-text("New Terminal")');
      await page.waitForSelector('text=Create New Terminal', { timeout: 5000 });
      await page.click('button:has-text("Create")');
      await page.waitForTimeout(500);
    }
    
    // Wait for all terminals to appear
    await page.waitForSelector('li[role="button"]:nth-child(3)', { timeout: 5000 });
    
    // Rapidly switch between terminals
    const terminals = await page.locator('li[role="button"]').all();
    
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < terminals.length; i++) {
        await terminals[i].click();
        // Very short wait to stress test
        await page.waitForTimeout(100);
      }
    }
    
    // Final wait for last terminal to be ready
    await waitForTerminalReady(page);
    
    // Check that no dimension errors occurred
    const dimensionErrors = consoleErrors.filter(error => 
      error.includes('Cannot read properties of undefined') && 
      error.includes('dimensions')
    );
    
    expect(dimensionErrors).toHaveLength(0);
  });

  test('should display terminal output correctly', async ({ page }) => {
    // Create a terminal
    await page.click('button:has-text("New Terminal")');
    await page.waitForSelector('text=Create New Terminal', { timeout: 5000 });
    await page.click('button:has-text("Create")');
    await page.waitForTimeout(1000);
    
    // Click on the terminal
    const terminal = await page.locator('li[role="button"]').first();
    await terminal.click();
    
    // Wait for terminal to be ready
    await waitForTerminalReady(page);
    
    // Verify terminal is displayed
    await expect(page.locator('.xterm')).toBeVisible();
    
    // Verify terminal header shows correct info
    const header = await page.locator('text=/Terminal.*cmd/');
    await expect(header).toBeVisible();
  });
});