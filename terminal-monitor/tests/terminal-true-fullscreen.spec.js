const { test, expect } = require('@playwright/test');

test.describe('Terminal True Full Screen Maximize Test', () => {
  test('maximize browser window completely and verify terminal usage', async ({ page }) => {
    // Get maximum screen dimensions first
    const maxScreenSize = await page.evaluate(() => ({
      width: screen.availWidth,
      height: screen.availHeight,
      fullWidth: screen.width,
      fullHeight: screen.height
    }));
    
    console.log('Maximum screen dimensions:', maxScreenSize);
    
    // Set viewport to maximum available screen size
    await page.setViewportSize({
      width: maxScreenSize.width,
      height: maxScreenSize.height
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
    
    // Get true fullscreen analysis
    const fullscreenAnalysis = await page.evaluate(() => {
      const xterm = document.querySelector('.xterm');
      const container = xterm ? xterm.parentElement : null;
      const appContainer = document.querySelector('[class*="MuiContainer"], [class*="App"], main, .main-content') || document.body;
      
      if (!xterm || !container) return { error: 'Terminal elements not found' };
      
      const xtermRect = xterm.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const appRect = appContainer.getBoundingClientRect();
      const bodyRect = document.body.getBoundingClientRect();
      
      // Get actual window dimensions
      const windowDimensions = {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        screenWidth: screen.width,
        screenHeight: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight
      };
      
      const rows = xterm.querySelectorAll('.xterm-rows > *');
      
      // Calculate comprehensive utilization metrics
      const terminalToScreen = xtermRect.height / windowDimensions.availHeight;
      const terminalToWindow = xtermRect.height / windowDimensions.innerHeight;
      const containerToScreen = containerRect.height / windowDimensions.availHeight;
      const windowToScreen = windowDimensions.innerHeight / windowDimensions.availHeight;
      
      return {
        windowDimensions,
        elements: {
          body: { width: bodyRect.width, height: bodyRect.height },
          app: { width: appRect.width, height: appRect.height },
          container: { width: containerRect.width, height: containerRect.height },
          xterm: { width: xtermRect.width, height: xtermRect.height }
        },
        totalRows: rows.length,
        utilization: {
          terminalToScreen: terminalToScreen,
          terminalToWindow: terminalToWindow,
          containerToScreen: containerToScreen,
          windowToScreen: windowToScreen,
          terminalToContainer: xtermRect.height / containerRect.height
        },
        isFullyMaximized: windowDimensions.innerWidth >= windowDimensions.availWidth * 0.95 &&
                          windowDimensions.innerHeight >= windowDimensions.availHeight * 0.85
      };
    });
    
    console.log('TRUE FULLSCREEN ANALYSIS:', JSON.stringify(fullscreenAnalysis, null, 2));
    
    // Take screenshot at true fullscreen
    await page.screenshot({ 
      path: 'terminal-true-fullscreen-initial.png', 
      fullPage: false 
    });
    
    // Fill terminal with content to test maximum utilization
    const inputPanel = await page.locator('[data-testid="input-panel"], input[placeholder*="command"], textarea[placeholder*="command"]').first();
    
    if (await inputPanel.isVisible()) {
      console.log('Filling terminal at TRUE fullscreen size...');
      
      // Calculate commands needed based on available rows at fullscreen
      const commandsNeeded = Math.max(40, Math.floor(fullscreenAnalysis.totalRows * 1.5));
      console.log(`Sending ${commandsNeeded} commands to fill ${fullscreenAnalysis.totalRows} rows at true fullscreen...`);
      
      for (let i = 1; i <= commandsNeeded; i++) {
        await inputPanel.fill(`echo "MAXIMUM SCREEN ${i}: Testing terminal at ${maxScreenSize.width}x${maxScreenSize.height} - full browser maximization test with extensive content"`);
        await inputPanel.press('Enter');
        await page.waitForTimeout(80);
        await inputPanel.fill('');
        
        // Progress check every 10 commands
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
    
    // Take final screenshot at true fullscreen with content
    await page.screenshot({ 
      path: 'terminal-true-fullscreen-filled.png', 
      fullPage: false 
    });
    
    // Final analysis with content
    const finalAnalysis = await page.evaluate(() => {
      const xterm = document.querySelector('.xterm');
      const container = xterm ? xterm.parentElement : null;
      
      if (!xterm || !container) return { error: 'Terminal elements not found' };
      
      const rows = xterm.querySelectorAll('.xterm-rows > *');
      const rowsWithContent = Array.from(rows).filter(row => {
        const text = row.textContent?.trim();
        return text && text.length > 0 && text !== ' ';
      });
      
      const xtermRect = xterm.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      
      return {
        windowSize: {
          inner: { w: window.innerWidth, h: window.innerHeight },
          screen: { w: screen.availWidth, h: screen.availHeight }
        },
        elements: {
          container: { w: containerRect.width, h: containerRect.height },
          xterm: { w: xtermRect.width, h: xtermRect.height }
        },
        content: {
          totalRows: rows.length,
          rowsWithContent: rowsWithContent.length,
          utilization: rowsWithContent.length / rows.length
        },
        metrics: {
          terminalHeightVsScreen: xtermRect.height / screen.availHeight,
          terminalHeightVsWindow: xtermRect.height / window.innerHeight,
          containerFit: xtermRect.height / containerRect.height,
          screenUsage: (xtermRect.width * xtermRect.height) / (screen.availWidth * screen.availHeight)
        }
      };
    });
    
    console.log('FINAL TRUE FULLSCREEN RESULTS:', JSON.stringify(finalAnalysis, null, 2));
    
    if (!finalAnalysis.error) {
      console.log('\n=== TRUE FULLSCREEN TERMINAL REPORT ===');
      console.log(`Window: ${finalAnalysis.windowSize.inner.w}×${finalAnalysis.windowSize.inner.h}`);
      console.log(`Screen: ${finalAnalysis.windowSize.screen.w}×${finalAnalysis.windowSize.screen.h}`);
      console.log(`Container: ${finalAnalysis.elements.container.w}×${finalAnalysis.elements.container.h}`);
      console.log(`Terminal: ${finalAnalysis.elements.xterm.w}×${finalAnalysis.elements.xterm.h}`);
      console.log(`Total rows: ${finalAnalysis.content.totalRows}`);
      console.log(`Rows with content: ${finalAnalysis.content.rowsWithContent}`);
      console.log(`Content utilization: ${(finalAnalysis.content.utilization * 100).toFixed(1)}%`);
      console.log(`Terminal height vs screen: ${(finalAnalysis.metrics.terminalHeightVsScreen * 100).toFixed(1)}%`);
      console.log(`Terminal height vs window: ${(finalAnalysis.metrics.terminalHeightVsWindow * 100).toFixed(1)}%`);
      console.log(`Container fit: ${(finalAnalysis.metrics.containerFit * 100).toFixed(1)}%`);
      console.log(`Total screen area usage: ${(finalAnalysis.metrics.screenUsage * 100).toFixed(1)}%`);
      
      // Verify true fullscreen performance
      const isWindowMaximized = finalAnalysis.windowSize.inner.w >= finalAnalysis.windowSize.screen.w * 0.95;
      const isTerminalWellSized = finalAnalysis.metrics.terminalHeightVsWindow > 0.4;
      const isContentFilled = finalAnalysis.content.utilization > 0.7;
      
      console.log(`\nIs window truly maximized: ${isWindowMaximized ? 'YES' : 'NO'}`);
      console.log(`Is terminal well-sized: ${isTerminalWellSized ? 'YES' : 'NO'}`);
      console.log(`Is content filled: ${isContentFilled ? 'YES' : 'NO'}`);
      
      if (!isWindowMaximized) {
        console.warn('🚨 BROWSER NOT FULLY MAXIMIZED');
      }
      if (!isTerminalWellSized) {
        console.warn('🚨 TERMINAL SIZE ISSUE AT FULLSCREEN');
      }
      if (!isContentFilled) {
        console.warn('🚨 CONTENT NOT PROPERLY FILLED');
      }
      
      if (isWindowMaximized && isTerminalWellSized && isContentFilled) {
        console.log('✅ SUCCESS: Terminal working properly at true fullscreen!');
      }
      
      // Test assertions
      expect(finalAnalysis.metrics.containerFit).toBeGreaterThan(0.9);
      expect(finalAnalysis.metrics.terminalHeightVsWindow).toBeGreaterThan(0.3);
      expect(finalAnalysis.content.utilization).toBeGreaterThan(0.6);
    }
  });
});