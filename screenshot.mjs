import { chromium } from 'playwright';
const br = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const pg = await br.newPage();
await pg.setViewportSize({ width: 1440, height: 900 });

// Login page
await pg.goto('http://localhost:3000/login.html');
await pg.waitForTimeout(1500);
await pg.screenshot({ path: 'ss_login.png', fullPage: false });

// Demo mode
await pg.evaluate(() => {
  localStorage.setItem('reserveai_user', JSON.stringify({
    token:'demo', businessId:'demo', businessName:'מסעדת הדמו', businessType:'restaurant',
    plan:'enterprise_plus', _isDemo:true, email:'demo@demo.com'
  }));
});
await pg.goto('http://localhost:3000/index.html');
await pg.waitForTimeout(2000);
await pg.screenshot({ path: 'ss_demo_main.png', fullPage: false });

// Click central dashboard
await pg.click('[data-tab="central"]');
await pg.waitForTimeout(1000);
await pg.screenshot({ path: 'ss_central.png', fullPage: false });

await br.close();
console.log('done');
