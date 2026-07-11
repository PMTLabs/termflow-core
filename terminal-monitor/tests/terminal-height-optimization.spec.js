const { test, expect } = require('@playwright/test');

test.describe('Terminal Height Optimization Test', () => {
  test('verify terminal uses maximum calculated height at 1920x1080', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    
    // Set to Full HD resolution
    await page.setViewportSize({
      width: 1920,
      height: 1080
    });
    
    console.log('Testing terminal height optimization at 1920x1080...');
    
    await page.goto('http://localhost:3000');
    
    // Handle login
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
    
    // Click first terminal
    await page.waitForSelector('[data-testid="terminal-list"], .terminal-list, .MuiList-root', { timeout: 10000 });
    const firstTerminal = await page.locator('[data-testid="terminal-item"], .MuiListItem-root, .terminal-item').first();
    if (await firstTerminal.isVisible()) {
      await firstTerminal.click();
      await page.waitForTimeout(3000); // Wait for terminal to fully initialize
    }
    
    // Wait for terminal to load
    await page.waitForSelector('.xterm', { timeout: 10000 });
    
    // Analyze height utilization with new optimizations
    const heightAnalysis = await page.evaluate(() => {
      // Get all the UI elements
      const header = document.querySelector('header, .MuiAppBar-root, [class*="Header"]');
      const terminalDisplayArea = document.querySelector('[class*="Box"]:has(.xterm)').parentElement;
      const inputPanel = document.querySelector('[class*="InputPanel"], [placeholder*="command"]')?.closest('[class*="Box"]');
      const xterm = document.querySelector('.xterm');
      const xtermViewport = document.querySelector('.xterm-viewport');
      const container = xterm ? xterm.closest('[class*="Paper"]') : null;
      
      if (!xterm || !container) return { error: 'Terminal elements not found' };
      
      // Get bounding rectangles
      const headerRect = header?.getBoundingClientRect();
      const terminalAreaRect = terminalDisplayArea?.getBoundingClientRect();
      const inputPanelRect = inputPanel?.getBoundingClientRect();
      const xtermRect = xterm.getBoundingClientRect();
      const xtermViewportRect = xtermViewport?.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      
      // Calculate expected vs actual heights
      const viewportHeight = window.innerHeight;
      const headerHeight = headerRect?.height || 64;
      const inputPanelHeight = inputPanelRect?.height || 120;
      const padding = 32; // Container padding
      const spacing = 16; // Grid spacing
      
      // Expected available height for terminal
      const expectedTerminalHeight = viewportHeight - headerHeight - inputPanelHeight - padding - spacing;
      
      // Count terminal rows
      const rows = xterm.querySelectorAll('.xterm-rows > *');
      
      return {
        viewport: { width: window.innerWidth, height: viewportHeight },
        uiElements: {
          header: headerRect ? { width: headerRect.width, height: headerRect.height } : null,
          terminalArea: terminalAreaRect ? { width: terminalAreaRect.width, height: terminalAreaRect.height } : null,
          inputPanel: inputPanelRect ? { width: inputPanelRect.width, height: inputPanelRect.height } : null,
          container: { width: containerRect.width, height: containerRect.height },
          xterm: { width: xtermRect.width, height: xtermRect.height },
          xtermViewport: xtermViewportRect ? { width: xtermViewportRect.width, height: xtermViewportRect.height } : null
        },
        heightCalculations: {
          expectedTerminalHeight: expectedTerminalHeight,
          actualTerminalHeight: xtermRect.height,
          heightUtilization: xtermRect.height / expectedTerminalHeight,
          viewportUtilization: xtermRect.height / viewportHeight,
          heightDifference: expectedTerminalHeight - xtermRect.height
        },
        terminalRows: {
          total: rows.length,
          rowHeight: rows.length > 0 ? xtermRect.height / rows.length : 0
        }
      };
    });
    
    console.log('HEIGHT OPTIMIZATION ANALYSIS:', JSON.stringify(heightAnalysis, null, 2));
    
    // Take screenshot showing optimized height
    await page.screenshot({ 
      path: 'terminal-height-optimized-1920x1080.png', 
      fullPage: false 
    });
    
    if (!heightAnalysis.error) {
      console.log('\n=== TERMINAL HEIGHT OPTIMIZATION REPORT ===');
      console.log(`Viewport: ${heightAnalysis.viewport.width}×${heightAnalysis.viewport.height}`);
      console.log(`Header Height: ${heightAnalysis.uiElements.header?.height || 'Not found'}px`);
      console.log(`Input Panel Height: ${heightAnalysis.uiElements.inputPanel?.height || 'Not found'}px`);
      console.log(`Terminal Container: ${heightAnalysis.uiElements.container.width}×${heightAnalysis.uiElements.container.height}`);
      console.log(`Terminal xterm: ${heightAnalysis.uiElements.xterm.width}×${heightAnalysis.uiElements.xterm.height}`);
      
      console.log('\n--- HEIGHT CALCULATIONS ---');
      console.log(`Expected Terminal Height: ${heightAnalysis.heightCalculations.expectedTerminalHeight}px`);
      console.log(`Actual Terminal Height: ${heightAnalysis.heightCalculations.actualTerminalHeight}px`);
      console.log(`Height Utilization: ${(heightAnalysis.heightCalculations.heightUtilization * 100).toFixed(1)}%`);
      console.log(`Viewport Utilization: ${(heightAnalysis.heightCalculations.viewportUtilization * 100).toFixed(1)}%`);
      console.log(`Height Difference: ${heightAnalysis.heightCalculations.heightDifference}px`);
      
      console.log('\n--- TERMINAL METRICS ---');
      console.log(`Total Rows: ${heightAnalysis.terminalRows.total}`);
      console.log(`Average Row Height: ${heightAnalysis.terminalRows.rowHeight.toFixed(1)}px`);
      
      // Quality assessments
      const isHeightWellUtilized = heightAnalysis.heightCalculations.heightUtilization >= 0.85;
      const isViewportWellUsed = heightAnalysis.heightCalculations.viewportUtilization >= 0.65;
      const hasGoodRowCount = heightAnalysis.terminalRows.total >= 45; // Expect ~45+ rows at 1080p
      
      console.log('\n--- OPTIMIZATION ASSESSMENT ---');
      console.log(`✓ Height well utilized (85%+): ${isHeightWellUtilized ? 'YES' : 'NO'}`);
      console.log(`✓ Viewport well used (65%+): ${isViewportWellUsed ? 'YES' : 'NO'}`);  
      console.log(`✓ Good row count (45+): ${hasGoodRowCount ? 'YES' : 'NO'}`);
      
      if (isHeightWellUtilized && isViewportWellUsed && hasGoodRowCount) {
        console.log('\n🎉 EXCELLENT: Terminal height optimization successful!');
      } else {
        console.log('\n⚠️ NEEDS IMPROVEMENT: Terminal height optimization incomplete');
        if (!isHeightWellUtilized) console.log('   - Terminal not using calculated height efficiently');
        if (!isViewportWellUsed) console.log('   - Terminal not using enough viewport space');
        if (!hasGoodRowCount) console.log('   - Terminal row count lower than expected for 1080p');
      }
      
      // Test assertions
      expect(heightAnalysis.heightCalculations.heightUtilization).toBeGreaterThan(0.80); // Use 80%+ of calculated space
      expect(heightAnalysis.heightCalculations.viewportUtilization).toBeGreaterThan(0.60); // Use 60%+ of viewport
      expect(heightAnalysis.terminalRows.total).toBeGreaterThan(40); // At least 40 rows at 1080p
    }
    
    await context.close();
  });
});