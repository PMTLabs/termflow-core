const { test, expect } = require('@playwright/test');

test.describe('Terminal Maximum Screen Resolution Test', () => {
  test('test terminal at 1920x1080 maximum resolution', async ({ browser }) => {
    // Create context with no viewport restrictions
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Force set to actual maximum screen resolution (1920x1080)
    await page.setViewportSize({
      width: 1920,
      height: 1080
    });
    
    console.log('Set viewport to 1920x1080 - true maximum screen size');
    
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
    
    // Analyze terminal at 1920x1080
    const maxResolutionAnalysis = await page.evaluate(() => {
      const xterm = document.querySelector('.xterm');
      const container = xterm ? xterm.parentElement : null;
      const appContainer = document.querySelector('[class*="MuiContainer"], [class*="App"], main, .main-content') || document.body;
      
      if (!xterm || !container) return { error: 'Terminal elements not found' };
      
      const xtermRect = xterm.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      const appRect = appContainer.getBoundingClientRect();
      const bodyRect = document.body.getBoundingClientRect();
      
      const windowDimensions = {
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
        isFullHD: window.innerWidth >= 1920 && window.innerHeight >= 1080
      };
      
      const rows = xterm.querySelectorAll('.xterm-rows > *');
      
      return {
        viewport: windowDimensions,
        elements: {
          body: { width: bodyRect.width, height: bodyRect.height },
          app: { width: appRect.width, height: appRect.height },
          container: { width: containerRect.width, height: containerRect.height },
          xterm: { width: xtermRect.width, height: xtermRect.height }
        },
        totalRows: rows.length,
        metrics: {
          terminalToViewport: xtermRect.height / windowDimensions.innerHeight,
          containerToViewport: containerRect.height / windowDimensions.innerHeight,
          terminalToContainer: xtermRect.height / containerRect.height,
          fullHDCoverage: (xtermRect.width * xtermRect.height) / (1920 * 1080)
        }
      };
    });
    
    console.log('MAXIMUM RESOLUTION ANALYSIS (1920x1080):', JSON.stringify(maxResolutionAnalysis, null, 2));
    
    // Take screenshot at maximum resolution
    await page.screenshot({ 
      path: 'terminal-1920x1080-initial.png', 
      fullPage: false 
    });
    
    // Fill terminal with content at maximum resolution
    const inputPanel = await page.locator('[data-testid="input-panel"], input[placeholder*="command"], textarea[placeholder*="command"]').first();
    
    if (await inputPanel.isVisible()) {
      console.log('Filling terminal at 1920x1080 resolution...');
      
      // Calculate commands needed for full HD resolution
      const commandsNeeded = Math.max(50, Math.floor(maxResolutionAnalysis.totalRows * 2));
      console.log(`Sending ${commandsNeeded} commands to fill ${maxResolutionAnalysis.totalRows} rows at 1920x1080...`);
      
      for (let i = 1; i <= commandsNeeded; i++) {
        await inputPanel.fill(`echo "FULL HD TEST ${i}: Terminal at maximum 1920x1080 resolution - ${maxResolutionAnalysis.viewport.innerWidth}x${maxResolutionAnalysis.viewport.innerHeight} - testing full screen terminal utilization"`);
        await inputPanel.press('Enter');
        await page.waitForTimeout(60);
        await inputPanel.fill('');
        
        if (i % 12 === 0) {
          const currentRows = await page.evaluate(() => {
            const rows = document.querySelectorAll('.xterm-rows > *');
            return Array.from(rows).filter(row => row.textContent?.trim()).length;
          });
          console.log(`After ${i} commands: ${currentRows} rows have content`);
        }
      }
      
      await page.waitForTimeout(3000);
    }
    
    // Take final screenshot at 1920x1080 with content
    await page.screenshot({ 
      path: 'terminal-1920x1080-filled.png', 
      fullPage: false 
    });
    
    // Final analysis at full HD resolution
    const finalFullHD = await page.evaluate(() => {
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
      
      const windowSize = {
        width: window.innerWidth,
        height: window.innerHeight,
        isActualFullHD: window.innerWidth === 1920 && window.innerHeight === 1080
      };
      
      return {
        window: windowSize,
        elements: {
          container: { w: containerRect.width, h: containerRect.height },
          xterm: { w: xtermRect.width, h: xtermRect.height }
        },
        content: {
          totalRows: rows.length,
          rowsWithContent: rowsWithContent.length,
          utilization: rowsWithContent.length / rows.length
        },
        fullHDMetrics: {
          terminalHeightVs1080p: xtermRect.height / 1080,
          terminalWidthVs1920p: xtermRect.width / 1920,
          containerHeightVs1080p: containerRect.height / 1080,
          fullHDAreaUsage: (xtermRect.width * xtermRect.height) / (1920 * 1080),
          terminalToWindowHeight: xtermRect.height / window.innerHeight,
          containerFit: xtermRect.height / containerRect.height
        }
      };
    });
    
    console.log('FINAL FULL HD RESULTS:', JSON.stringify(finalFullHD, null, 2));
    
    if (!finalFullHD.error) {
      console.log('\n=== FULL HD (1920x1080) TERMINAL REPORT ===');
      console.log(`Actual window size: ${finalFullHD.window.width}×${finalFullHD.window.height}`);
      console.log(`Is actually Full HD: ${finalFullHD.window.isActualFullHD ? 'YES' : 'NO'}`);
      console.log(`Container: ${finalFullHD.elements.container.w}×${finalFullHD.elements.container.h}`);
      console.log(`Terminal: ${finalFullHD.elements.xterm.w}×${finalFullHD.elements.xterm.h}`);
      console.log(`Total rows: ${finalFullHD.content.totalRows}`);
      console.log(`Rows with content: ${finalFullHD.content.rowsWithContent}`);
      console.log(`Content utilization: ${(finalFullHD.content.utilization * 100).toFixed(1)}%`);
      console.log(`Terminal height vs 1080p: ${(finalFullHD.fullHDMetrics.terminalHeightVs1080p * 100).toFixed(1)}%`);
      console.log(`Terminal width vs 1920p: ${(finalFullHD.fullHDMetrics.terminalWidthVs1920p * 100).toFixed(1)}%`);
      console.log(`Container height vs 1080p: ${(finalFullHD.fullHDMetrics.containerHeightVs1080p * 100).toFixed(1)}%`);
      console.log(`Full HD area usage: ${(finalFullHD.fullHDMetrics.fullHDAreaUsage * 100).toFixed(1)}%`);
      console.log(`Terminal vs window height: ${(finalFullHD.fullHDMetrics.terminalToWindowHeight * 100).toFixed(1)}%`);
      console.log(`Container fit: ${(finalFullHD.fullHDMetrics.containerFit * 100).toFixed(1)}%`);
      
      // Verification for Full HD
      const isActualFullHD = finalFullHD.window.isActualFullHD;
      const isTerminalWellSized = finalFullHD.fullHDMetrics.terminalToWindowHeight > 0.35;
      const isContentFilled = finalFullHD.content.utilization > 0.65;
      const isUsingFullHDWell = finalFullHD.fullHDMetrics.fullHDAreaUsage > 0.25;
      
      console.log(`\n=== FULL HD VERIFICATION ===`);
      console.log(`✓ Window is actual 1920x1080: ${isActualFullHD ? 'YES' : 'NO'}`);
      console.log(`✓ Terminal well-sized for Full HD: ${isTerminalWellSized ? 'YES' : 'NO'}`);
      console.log(`✓ Content properly filled: ${isContentFilled ? 'YES' : 'NO'}`);
      console.log(`✓ Good Full HD area usage: ${isUsingFullHDWell ? 'YES' : 'NO'}`);
      
      if (isActualFullHD && isTerminalWellSized && isContentFilled && isUsingFullHDWell) {
        console.log('\n🎉 SUCCESS: Terminal working excellently at Full HD 1920x1080!');
      } else {
        console.log('\n⚠️  Issues detected at Full HD resolution');
        if (!isActualFullHD) console.log('   - Window not actually 1920x1080');
        if (!isTerminalWellSized) console.log('   - Terminal not well-sized for Full HD');
        if (!isContentFilled) console.log('   - Content not properly filled');
        if (!isUsingFullHDWell) console.log('   - Poor Full HD area utilization');
      }
      
      // Test assertions for Full HD
      expect(finalFullHD.fullHDMetrics.containerFit).toBeGreaterThan(0.85);
      expect(finalFullHD.fullHDMetrics.terminalToWindowHeight).toBeGreaterThan(0.3);
      expect(finalFullHD.content.utilization).toBeGreaterThan(0.6);
    }
    
    await context.close();
  });
});