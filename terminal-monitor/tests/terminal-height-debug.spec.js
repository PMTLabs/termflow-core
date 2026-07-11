const { test, expect } = require('@playwright/test');

test.describe('Terminal Height Debug', () => {
  test('debug height allocation chain at 1920x1080', async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto('http://localhost:3000');
    
    // Login
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
    
    // Select terminal
    const firstTerminal = await page.locator('[data-testid="terminal-item"], .MuiListItem-root, .terminal-item').first();
    if (await firstTerminal.isVisible()) {
      await firstTerminal.click();
      await page.waitForTimeout(3000);
    }
    
    await page.waitForSelector('.xterm', { timeout: 10000 });
    
    // Debug height chain
    const heightDebug = await page.evaluate(() => {
      const elements = {
        viewport: { width: window.innerWidth, height: window.innerHeight },
        body: document.body,
        root: document.querySelector('#root'),
        mainBox: document.querySelector('[style*="height: 100vh"]'),
        header: document.querySelector('header, [class*="Header"], .MuiAppBar-root'),
        container: document.querySelector('.MuiContainer-root'),
        gridContainer: document.querySelector('.MuiGrid-container'),
        gridItem: document.querySelector('.MuiGrid-item:last-child'), // Terminal side
        terminalBox: document.querySelector('[style*="flex: 1"]'), // Terminal display area
        terminalViewer: document.querySelector('[class*="Paper"]:has(.xterm)'),
        xterm: document.querySelector('.xterm'),
        inputPanel: document.querySelector('[placeholder*="command"]')?.closest('[class*="Box"]')
      };
      
      const result = { viewport: elements.viewport };
      
      Object.keys(elements).forEach(key => {
        if (key === 'viewport') return;
        const element = elements[key];
        if (element) {
          const rect = element.getBoundingClientRect();
          const styles = window.getComputedStyle(element);
          result[key] = {
            size: { width: rect.width, height: rect.height },
            position: { top: rect.top, left: rect.left },
            styles: {
              height: styles.height,
              minHeight: styles.minHeight,
              maxHeight: styles.maxHeight,
              flex: styles.flex,
              flexGrow: styles.flexGrow,
              flexShrink: styles.flexShrink,
              flexBasis: styles.flexBasis,
              display: styles.display,
              flexDirection: styles.flexDirection,
              overflow: styles.overflow,
              padding: `${styles.paddingTop} ${styles.paddingRight} ${styles.paddingBottom} ${styles.paddingLeft}`,
            }
          };
        } else {
          result[key] = null;
        }
      });
      
      return result;
    });
    
    console.log('HEIGHT DEBUG CHAIN:', JSON.stringify(heightDebug, null, 2));
    
    // Take debug screenshot
    await page.screenshot({ path: 'terminal-height-debug.png', fullPage: false });
    
    await context.close();
  });
});