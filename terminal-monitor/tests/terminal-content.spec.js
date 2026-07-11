const { test, expect } = require('@playwright/test');

test.describe('Terminal Content Fill Test', () => {
  test('verify terminal can fill multiple rows', async ({ page }) => {
    await page.goto('http://localhost:3000');
    
    // Handle login if needed
    await page.waitForSelector('input[type="text"], input[type="email"], .terminal-list, .MuiPaper-root', { timeout: 10000 });
    const loginInput = await page.locator('input[type="text"], input[type="email"]').first();
    if (await loginInput.isVisible()) {
      await loginInput.fill('admin');
      const passwordInput = await page.locator('input[type="password"]');
      if (await passwordInput.isVisible()) {
        await passwordInput.fill('password');
      }
      const loginButton = await page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign In")');
      await loginButton.click();
      await page.waitForSelector('.terminal-list, .MuiPaper-root', { timeout: 10000 });
    }
    
    // Click on first terminal
    await page.waitForSelector('[data-testid="terminal-list"], .terminal-list, .MuiList-root', { timeout: 10000 });
    const firstTerminal = await page.locator('[data-testid="terminal-item"], .MuiListItem-root, .terminal-item').first();
    if (await firstTerminal.isVisible()) {
      await firstTerminal.click();
      await page.waitForTimeout(2000);
    }
    
    // Wait for terminal
    await page.waitForSelector('.xterm', { timeout: 10000 });
    
    // Send multiple commands to fill the terminal
    const inputField = await page.locator('input[placeholder*="command"], input[placeholder*="Command"], textarea, input[type="text"]').last();
    
    if (await inputField.isVisible()) {
      // Send commands to generate more output
      for (let i = 1; i <= 15; i++) {
        await inputField.fill(`echo "Line ${i} - This is a test line to fill the terminal with content"`);
        await inputField.press('Enter');
        await page.waitForTimeout(300); // Brief delay between commands
      }
      
      // Wait for all commands to execute
      await page.waitForTimeout(3000);
      
      // Take screenshot after filling with content
      await page.screenshot({ 
        path: 'terminal-filled-screenshot.png',
        fullPage: true 
      });
      
      // Check how many rows now have content
      const contentInfo = await page.evaluate(() => {
        const rows = document.querySelectorAll('.xterm-rows > *');
        const rowsWithContent = Array.from(rows).filter(row => {
          const text = row.textContent?.trim();
          return text && text.length > 0 && text !== ' ';
        });
        
        return {
          totalRows: rows.length,
          rowsWithContent: rowsWithContent.length,
          contentRatio: rowsWithContent.length / rows.length,
          sampleContent: rowsWithContent.slice(-5).map(row => row.textContent?.trim().slice(0, 60))
        };
      });
      
      console.log('Content fill results:', JSON.stringify(contentInfo, null, 2));
      console.log(`Content utilization: ${(contentInfo.contentRatio * 100).toFixed(1)}%`);
      
      // The terminal should now be using more rows
      expect(contentInfo.rowsWithContent).toBeGreaterThan(10);
    } else {
      console.log('No input field found - terminal might not support input');
    }
  });
});