#!/usr/bin/env node
// Authenticated visual tour: serves the SPA locally, logs in as admin,
// screenshots every page (desktop + mobile). Reuses Patient Navigator's
// playwright install. Usage: node scripts/visual_tour.mjs
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, extname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const PN_PW = 'C:/Users/abhay/Desktop/Carcinome Brochure/Patient Navigator/node_modules/playwright/index.mjs';
const { chromium } = await import(pathToFileURL(PN_PW).href);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon' };
const server = createServer((req, res) => {
  let p = decodeURIComponent((req.url || '/').split('?')[0]);
  if (p === '/') p = '/index.html';
  const f = join(root, p);
  if (!existsSync(f) || !f.startsWith(root)) { res.writeHead(404); res.end('nf'); return; }
  try {
    const body = readFileSync(f);
    res.writeHead(200, { 'Content-Type': MIME[extname(f)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(500); res.end('err'); }
});
await new Promise((r) => server.listen(4198, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:4198';

const outDir = resolve(root, 'screenshots', 'tour');
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const shots = [];

async function tour(label, viewport) {
  const ctx = await browser.newContext({ viewport });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => errors.push(String(e).slice(0, 200)));

  await page.goto(`${BASE}/#dashboard`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: join(outDir, `${label}-00-login.png`) });
  shots.push(`${label}-00-login.png`);

  // Login
  const email = page.locator('input[type="email"]');
  if (await email.count()) {
    await email.fill('admin@carcinome.in');
    await page.locator('input[type="password"]').fill(process.env.ADMIN_PASSWORD);
    await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click();
    await page.waitForTimeout(4500);
  }

  const routes = ['dashboard', 'cases', 'patients', 'nurses', 'suppliers', 'messages', 'sandbox', 'settings'];
  for (let i = 0; i < routes.length; i++) {
    await page.goto(`${BASE}/#${routes[i]}`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);
    const name = `${label}-${String(i + 1).padStart(2, '0')}-${routes[i]}.png`;
    await page.screenshot({ path: join(outDir, name), fullPage: routes[i] === 'settings' });
    shots.push(name);
  }
  // Case detail: first case in the board
  await page.goto(`${BASE}/#cases`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2500);
  const caseLink = page.locator('[href*="#cases/"], [data-case-id]').first();
  if (await caseLink.count()) {
    await caseLink.click();
    await page.waitForTimeout(3500);
    const name = `${label}-08-case-detail.png`;
    await page.screenshot({ path: join(outDir, name), fullPage: true });
    shots.push(name);
  }
  await ctx.close();
  return errors;
}

const desktopErrors = await tour('desktop', { width: 1440, height: 900 });
const mobileErrors = await tour('mobile', { width: 390, height: 844 });

await browser.close();
server.close();

console.log('Screenshots:', shots.length);
for (const s of shots) console.log('  ' + join(outDir, s));
console.log('\nConsole errors (desktop):', desktopErrors.length ? '' : 'none');
for (const e of [...new Set(desktopErrors)].slice(0, 10)) console.log('  ' + e);
console.log('Console errors (mobile):', mobileErrors.length ? '' : 'none');
for (const e of [...new Set(mobileErrors)].slice(0, 10)) console.log('  ' + e);
