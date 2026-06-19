import { chromium } from 'playwright';
import { readdirSync, renameSync } from 'fs';
import { join } from 'path';

const videoDir = './tmp-video';
const br = await chromium.launch({ headless: true });
const ctx = await br.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: videoDir, size: { width: 1440, height: 900 } }
});
const pg = await ctx.newPage();

// Set demo user with enterprise_plus plan
const demoUser = {
  id: 'demo-user-001',
  token: 'demo-token-abc123',
  businessId: 'demo-business',
  businessName: 'The Reserve Demo',
  businessType: 'restaurant',
  plan: 'enterprise_plus',
  _isDemo: true,
  email: 'demo@demo.com'
};

// ── 1. Login page (3s)
await pg.goto('http://localhost:3000/login.html');
await pg.waitForTimeout(800);
// Scroll to pricing
await pg.evaluate(() => document.getElementById('pricing')?.scrollIntoView({ behavior: 'smooth' }));
await pg.waitForTimeout(2200);

// ── 2. Enter demo → bookings (4s)
await pg.evaluate((u) => {
  localStorage.setItem('reserveai_user', JSON.stringify(u));
}, demoUser);
await pg.goto('http://localhost:3000/');
await pg.waitForTimeout(3500);

// ── 3. Analytics tab (4s)
await pg.click('[data-tab="analytics"]').catch(() => {});
await pg.waitForTimeout(3500);

// ── 4. Map tab — 3D map (5s)
await pg.click('[data-tab="map"]').catch(() => {});
await pg.waitForTimeout(4500);

// ── 5. Open first booking detail (4s)
await pg.click('[data-tab="bookings"]').catch(() => {});
await pg.waitForTimeout(1500);
const firstRow = pg.locator('tbody tr').first();
await firstRow.click().catch(() => {});
await pg.waitForTimeout(2500);

// ── 6. Settings tab (4s)
await pg.keyboard.press('Escape');
await pg.click('[data-tab="settings"]').catch(() => {});
await pg.waitForTimeout(3500);

// ── 7. Back to bookings (2s)
await pg.click('[data-tab="bookings"]').catch(() => {});
await pg.waitForTimeout(1500);

await ctx.close();
await br.close();

// Move the recorded video to public/demo.webm
const files = readdirSync(videoDir).filter(f => f.endsWith('.webm'));
if (files.length > 0) {
  renameSync(join(videoDir, files[0]), './public/demo.webm');
  console.log('✅ demo.webm saved to public/demo.webm');
} else {
  console.log('❌ No video file found in', videoDir);
}
