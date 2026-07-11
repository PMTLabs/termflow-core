const { test, expect } = require('@playwright/test');

test.describe('Terminal Maximize Screen Usage', () => {
  test('generate content to fill entire terminal height and verify', async ({ page }) => {
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
    
    // Wait for terminal to fully load
    await page.waitForSelector('.xterm', { timeout: 10000 });
    
    // Take initial screenshot
    await page.screenshot({ path: 'terminal-before-fill.png', fullPage: true });
    
    // Method 1: Try the input panel at the bottom
    console.log('Attempting to use input panel...');
    const inputPanel = await page.locator('[data-testid="input-panel"], input[placeholder*="command"], textarea[placeholder*="command"]').first();
    
    if (await inputPanel.isVisible()) {
      console.log('Found input panel, sending commands...');
      
      // Send commands to fill the terminal
      for (let i = 1; i <= 35; i++) {
        await inputPanel.fill(`echo "Line ${i}: Testing terminal height utilization with longer content that should wrap and fill multiple rows"`);
        await inputPanel.press('Enter');
        await page.waitForTimeout(200); // Brief delay
        
        // Clear the input for next command
        await inputPanel.fill('');
      }
      
      // Wait for all commands to process
      await page.waitForTimeout(3000);
      
    } else {
      // Method 2: Try to find and use quick command buttons
      console.log('Input panel not found, trying quick command buttons...');
      const commandButtons = await page.locator('button[data-testid*="quick"], button:has-text("ls"), button:has-text("dir"), button:has-text("echo")');
      
      if (await commandButtons.count() > 0) {
        console.log('Found quick command buttons, using them...');
        for (let i = 0; i < 25; i++) {
          const buttonCount = await commandButtons.count();
          if (buttonCount > 0) {
            const randomButton = await commandButtons.nth(i % buttonCount);
            await randomButton.click();
            await page.waitForTimeout(300);
          }
        }
      } else {
        // Method 3: Directly inject content via browser console
        console.log('No input methods found, injecting content directly...');
        await page.evaluate(() => {
          // Try to find the terminal instance and write content directly
          const xtermElements = document.querySelectorAll('.xterm');
          if (xtermElements.length > 0) {
            const xterm = xtermElements[0];
            
            // Try to access the xterm instance
            if (window._terminalInstances) {
              const terminalId = Object.keys(window._terminalInstances)[0];
              const terminal = window._terminalInstances[terminalId];
              if (terminal && terminal.write) {
                // Generate content to fill the terminal
                for (let i = 1; i <= 30; i++) {
                  terminal.write(`\\r\\nLine ${i}: This is test content to maximize terminal screen usage and verify full height utilization`);
                }
                terminal.write('\\r\\nTerminal content generation complete.\\r\\n');
              }
            }
          }
        });
        
        await page.waitForTimeout(2000);
      }
    }
    
    // Take final screenshot after filling content
    await page.screenshot({ path: 'terminal-maximized.png', fullPage: true });
    
    // Analyze the terminal content utilization
    const utilizationInfo = await page.evaluate(() => {
      const xterm = document.querySelector('.xterm');
      if (!xterm) return { error: 'No xterm found' };
      
      const rows = xterm.querySelectorAll('.xterm-rows > *');
      const container = xterm.parentElement;
      
      // Count rows with actual content
      const rowsWithContent = Array.from(rows).filter(row => {
        const text = row.textContent?.trim();
        return text && text.length > 0 && text !== ' ' && !text.match(/^\\s*$/);
      });
      
      // Count visible text lines
      const visibleTextLines = Array.from(rows).filter(row => {
        const rect = row.getBoundingClientRect();
        const text = row.textContent?.trim();
        return rect.height > 5 && text && text.length > 5;
      });
      
      // Get container and viewport dimensions
      const containerRect = container.getBoundingClientRect();
      const xtermRect = xterm.getBoundingClientRect();
      const viewport = xterm.querySelector('.xterm-viewport');
      const viewportRect = viewport ? viewport.getBoundingClientRect() : null;
      
      // Calculate utilization metrics
      const contentUtilization = rowsWithContent.length / rows.length;
      const visualUtilization = visibleTextLines.length / rows.length;
      
      // Sample content from different parts of terminal
      const topContent = Array.from(rows).slice(0, 3).map(r => r.textContent?.slice(0, 50)).filter(t => t);
      const middleContent = Array.from(rows).slice(Math.floor(rows.length/2), Math.floor(rows.length/2) + 3).map(r => r.textContent?.slice(0, 50)).filter(t => t);
      const bottomContent = Array.from(rows).slice(-3).map(r => r.textContent?.slice(0, 50)).filter(t => t);
      
      return {
        totalRows: rows.length,
        rowsWithContent: rowsWithContent.length,
        visibleTextLines: visibleTextLines.length,
        contentUtilization: contentUtilization,
        visualUtilization: visualUtilization,
        dimensions: {
          container: { width: containerRect.width, height: containerRect.height },
          xterm: { width: xtermRect.width, height: xtermRect.height },
          viewport: viewportRect ? { width: viewportRect.width, height: viewportRect.height } : null
        },
        sampleContent: {
          top: topContent,
          middle: middleContent,
          bottom: bottomContent
        }
      };
    });
    
    console.log('Terminal Utilization Analysis:', JSON.stringify(utilizationInfo, null, 2));
    
    if (!utilizationInfo.error) {
      console.log(`\\n=== TERMINAL UTILIZATION REPORT ===`);
      console.log(`Total rows available: ${utilizationInfo.totalRows}`);
      console.log(`Rows with content: ${utilizationInfo.rowsWithContent}`);
      console.log(`Visible text lines: ${utilizationInfo.visibleTextLines}`);
      console.log(`Content utilization: ${(utilizationInfo.contentUtilization * 100).toFixed(1)}%`);
      console.log(`Visual utilization: ${(utilizationInfo.visualUtilization * 100).toFixed(1)}%`);
      console.log(`Container: ${utilizationInfo.dimensions.container.width}×${utilizationInfo.dimensions.container.height}`);
      console.log(`Terminal: ${utilizationInfo.dimensions.xterm.width}×${utilizationInfo.dimensions.xterm.height}`);
      
      if (utilizationInfo.visualUtilization < 0.6) {
        console.warn('🚨 LOW UTILIZATION: Terminal is not using 60%+ of available screen space!');
      } else if (utilizationInfo.visualUtilization >= 0.8) {
        console.log('✅ GOOD UTILIZATION: Terminal is using 80%+ of available screen space!');
      } else {
        console.log('⚠️ MODERATE UTILIZATION: Terminal is using some but not most of available space.');
      }
      
      // Verify we actually maximized the usage
      expect(utilizationInfo.visualUtilization).toBeGreaterThan(0.5); // At least 50% should have content
    }
  });
});