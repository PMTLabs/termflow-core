const { test, expect } = require('@playwright/test');

test.describe('Terminal Full Browser Maximize Test', () => {
  test('maximize browser and verify terminal uses full available space', async ({ page }) => {
    // Set browser to maximum size - get screen dimensions and maximize
    const screenSize = await page.evaluate(() => ({
      width: screen.availWidth,
      height: screen.availHeight
    }));
    
    console.log(`Screen size: ${screenSize.width}x${screenSize.height}`);
    
    // Set viewport to maximum screen size
    await page.setViewportSize({ 
      width: screenSize.width, 
      height: screenSize.height 
    });
    
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
    
    // Get initial terminal dimensions at full screen
    const initialInfo = await page.evaluate(() => {
      const xterm = document.querySelector('.xterm');
      const container = xterm ? xterm.parentElement : null;
      const appContainer = document.querySelector('[class*="MuiContainer"], [class*="App"], main, .main-content') || document.body;
      
      if (!xterm || !container) return { error: 'Terminal elements not found' };
      
      const xtermRect = xterm.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const appRect = appContainer.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;
      
      const rows = xterm.querySelectorAll('.xterm-rows > *');
      
      return {
        viewport: { width: viewportWidth, height: viewportHeight },
        app: { width: appRect.width, height: appRect.height },
        container: { width: containerRect.width, height: containerRect.height },
        xterm: { width: xtermRect.width, height: xtermRect.height },
        totalRows: rows.length,
        heightUtilization: containerRect.height / viewportHeight,
        terminalToViewport: xtermRect.height / viewportHeight
      };
    });
    
    console.log('Initial Fullscreen Analysis:', JSON.stringify(initialInfo, null, 2));
    
    // Take screenshot at full screen size
    await page.screenshot({ path: 'terminal-fullscreen-before.png', fullPage: false });
    
    // Fill terminal with content to maximize usage
    const inputPanel = await page.locator('[data-testid="input-panel"], input[placeholder*="command"], textarea[placeholder*="command"]').first();
    
    if (await inputPanel.isVisible()) {
      console.log('Filling terminal with content at full screen...');
      
      // Calculate how many commands we need based on available rows
      const commandsNeeded = Math.max(50, Math.floor(initialInfo.totalRows * 1.5));
      console.log(`Sending ${commandsNeeded} commands to fill ${initialInfo.totalRows} available rows...`);
      
      for (let i = 1; i <= commandsNeeded; i++) {
        await inputPanel.fill(`echo "FULLSCREEN TEST ${i}: This is a long line to test terminal utilization at maximum browser size with extensive content that should wrap and fill multiple terminal rows effectively"`);
        await inputPanel.press('Enter');
        await page.waitForTimeout(100); // Faster execution for many commands
        
        // Clear the input
        await inputPanel.fill('');
        
        // Periodic check to see if we're filling the terminal
        if (i % 10 === 0) {
          const currentRows = await page.evaluate(() => {
            const rows = document.querySelectorAll('.xterm-rows > *');
            return Array.from(rows).filter(row => row.textContent?.trim()).length;
          });
          console.log(`After ${i} commands: ${currentRows} rows have content`);
        }
      }
      
      await page.waitForTimeout(3000);
    }
    
    // Take final screenshot at full screen with content
    await page.screenshot({ path: 'terminal-fullscreen-maximized.png', fullPage: false });
    
    // Final analysis of terminal utilization at full screen
    const finalInfo = await page.evaluate(() => {
      const xterm = document.querySelector('.xterm');
      const container = xterm ? xterm.parentElement : null;
      const appContainer = document.querySelector('[class*="MuiContainer"], [class*="App"], main, .main-content') || document.body;
      
      if (!xterm || !container) return { error: 'Terminal elements not found' };
      
      const rows = xterm.querySelectorAll('.xterm-rows > *');
      const rowsWithContent = Array.from(rows).filter(row => {
        const text = row.textContent?.trim();
        return text && text.length > 0 && text !== ' ';
      });
      
      const visibleRows = Array.from(rows).filter(row => {
        const rect = row.getBoundingClientRect();
        return rect.height > 5 && rect.width > 10;
      });
      
      const xtermRect = xterm.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const appRect = appContainer.getBoundingClientRect();
      const viewportHeight = window.innerHeight;
      const viewportWidth = window.innerWidth;
      
      // Calculate various utilization metrics
      const contentUtilization = rowsWithContent.length / rows.length;
      const heightToViewport = xtermRect.height / viewportHeight;
      const containerToViewport = containerRect.height / viewportHeight;
      const terminalToContainer = xtermRect.height / containerRect.height;
      
      // Check if terminal is using available space efficiently
      const expectedTerminalHeight = Math.floor(viewportHeight * 0.6); // Expect ~60% of viewport for terminal
      const isUsingExpectedHeight = xtermRect.height >= expectedTerminalHeight;
      
      // Sample content from different sections
      const topContent = Array.from(rows).slice(0, 3).map(r => r.textContent?.slice(0, 60)).filter(t => t);
      const bottomContent = Array.from(rows).slice(-3).map(r => r.textContent?.slice(0, 60)).filter(t => t);
      
      return {
        viewport: { width: viewportWidth, height: viewportHeight },
        container: { width: containerRect.width, height: containerRect.height },
        xterm: { width: xtermRect.width, height: xtermRect.height },
        totalRows: rows.length,
        rowsWithContent: rowsWithContent.length,
        visibleRows: visibleRows.length,
        contentUtilization: contentUtilization,
        heightToViewport: heightToViewport,
        containerToViewport: containerToViewport,
        terminalToContainer: terminalToContainer,
        expectedTerminalHeight: expectedTerminalHeight,
        isUsingExpectedHeight: isUsingExpectedHeight,
        sampleContent: { top: topContent, bottom: bottomContent }
      };
    });
    
    console.log('Final Fullscreen Analysis:', JSON.stringify(finalInfo, null, 2));
    
    if (!finalInfo.error) {
      console.log(`\\n=== FULLSCREEN TERMINAL REPORT ===`);
      console.log(`Viewport: ${finalInfo.viewport.width}×${finalInfo.viewport.height}`);
      console.log(`Container: ${finalInfo.container.width}×${finalInfo.container.height}`);
      console.log(`Terminal: ${finalInfo.xterm.width}×${finalInfo.xterm.height}`);
      console.log(`Total rows: ${finalInfo.totalRows}`);
      console.log(`Rows with content: ${finalInfo.rowsWithContent}`);
      console.log(`Content utilization: ${(finalInfo.contentUtilization * 100).toFixed(1)}%`);
      console.log(`Terminal height vs viewport: ${(finalInfo.heightToViewport * 100).toFixed(1)}%`);
      console.log(`Terminal vs container fit: ${(finalInfo.terminalToContainer * 100).toFixed(1)}%`);
      console.log(`Expected terminal height: ${finalInfo.expectedTerminalHeight}px`);
      console.log(`Is using expected height: ${finalInfo.isUsingExpectedHeight ? 'YES' : 'NO'}`);
      
      if (finalInfo.heightToViewport < 0.4) {
        console.warn('🚨 UNDERUTILIZATION: Terminal using less than 40% of viewport height!');
        console.warn(`Terminal: ${finalInfo.xterm.height}px / Viewport: ${finalInfo.viewport.height}px`);
      } else if (finalInfo.heightToViewport >= 0.5) {
        console.log('✅ GOOD HEIGHT USAGE: Terminal using 50%+ of viewport height!');
      }
      
      if (finalInfo.terminalToContainer < 0.9) {
        console.warn('🚨 CONTAINER ISSUE: Terminal not filling its container properly!');
        console.warn(`Terminal: ${finalInfo.xterm.height}px / Container: ${finalInfo.container.height}px`);
      } else {
        console.log('✅ CONTAINER FIT: Terminal properly fills its container!');
      }
      
      if (finalInfo.contentUtilization < 0.7) {
        console.warn('⚠️ CONTENT ISSUE: Less than 70% of rows have content');
      } else {
        console.log('✅ CONTENT FILLED: Good content utilization!');
      }
      
      // Verify terminal is actually maximizing screen usage
      expect(finalInfo.terminalToContainer).toBeGreaterThan(0.85); // Terminal should fill 85%+ of container
      expect(finalInfo.heightToViewport).toBeGreaterThan(0.3); // Should use at least 30% of viewport height
    }
  });
});