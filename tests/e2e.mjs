// End-to-end test of Lead Hunter, driven like a real user in Chrome, against a throwaway copy
// of the data on port 4898 in test mode (no runs, no AI calls). Your real data is never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4898, BASE = `http://localhost:${PORT}`;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'leadhunter-e2e-'));
const DATA = path.join(TMP, 'data');
fs.mkdirSync(DATA, { recursive: true });
fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(TMP, 'config.json'));
fs.copyFileSync(path.join(ROOT, 'offer.example.json'), path.join(TMP, 'offer.json'));
fs.writeFileSync(path.join(DATA, 'switch.json'), JSON.stringify({ enabled: false }));
const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ lastRun: { startedAt: ago(13), finishedAt: ago(12), added: 15, closed: 0, ruleSkipped: 4, aiChecked: 8, qualified: 2, aiQuotaOut: true }, health: {
  freelancer: { at: ago(5), status: 'ok', found: 42, attempts: 10, errors: 0, lastOkAt: ago(5) },
  osm: { at: ago(5), status: 'failing', found: 0, attempts: 1, errors: 1, lastError: 'Dentist in London: all map servers failed (overpass-api.de timed out)', lastOkAt: ago(1500) },
} }));
fs.writeFileSync(path.join(DATA, 'pipeline.log'), `[${new Date().toISOString()}] collect: 3 seen, 3 new\n`);

// Deterministic fixture covering both lead types and every state the UI must handle.
const now = new Date().toISOString();
const fixture = {
  'freelancer:1': { id: 'freelancer:1', type: 'inbound', source: 'Freelancer.com', sourceDetail: 'search "website"', title: 'Build a WordPress site for my bakery', body: 'Need a 5-page WordPress site with online ordering.', url: 'https://www.freelancer.com/projects/1', postedAt: now, foundAt: now, status: 'qualified', score: 82, service: 'WordPress website', summary: 'Bakery wants a 5-page site with ordering.', redFlags: [], budget: { min: 250, max: 750, currency: 'USD', original: '250–750 USD' }, pitch: 'Hi! I build WordPress sites…', contact: { handle: 'Bid on Freelancer.com' }, region: 'United States' },
  'hn:a': { id: 'hn:a', type: 'inbound', source: 'Hacker News', sourceDetail: 'Freelancer? Seeking freelancer?', title: 'SEEKING FREELANCER | Shopify developer for store fixes', body: 'Fix checkout and theme speed.', url: 'https://example.com/hn/a', postedAt: now, foundAt: now, status: 'qualified', score: 64, service: 'Shopify fixes', redFlags: ['No budget given'], pitch: '', contact: { handle: 'shopowner' }, region: 'Unknown' },
  'freelancer:2': { id: 'freelancer:2', type: 'inbound', source: 'Freelancer.com', sourceDetail: 'search "website"', title: 'Landing page for a gym (awarded)', body: 'Landing page.', url: 'https://www.freelancer.com/projects/2', postedAt: now, foundAt: now, status: 'qualified', score: 90, sourceClosed: 'awarded to someone', sourceClosedAt: now, redFlags: [], contact: {}, region: 'Anywhere' },
  'hn:b': { id: 'hn:b', type: 'inbound', source: 'Hacker News', sourceDetail: 'Freelancer? Seeking freelancer?', title: 'SEEKING FREELANCER | Commission-only sales rep', body: 'Sales', url: 'https://example.com/hn/b', postedAt: now, foundAt: now, status: 'skipped', score: 5, redFlags: ['Commission only'], skipReason: 'Commission-only or unpaid work', contact: {}, region: 'Unknown' },
  'osm:node/1': { id: 'osm:node/1', type: 'outbound', source: 'OpenStreetMap', sourceDetail: 'Dentist · Dubai', title: 'Smile Dental (Dentist, Dubai)', url: 'https://www.openstreetmap.org/node/1', mapsUrl: 'https://www.google.com/maps/search/?api=1&query=Smile', business: { name: 'Smile Dental', category: 'Dentist', address: '12 Beach Rd Dubai' }, contact: { phone: '+971 4 555 0101', email: 'info@smile.example', website: 'http://smile.example' }, region: 'Gulf', country: 'UAE', city: 'Dubai', foundAt: now, status: 'qualified', score: 75, service: 'Smile Dental site is not secure and not mobile friendly, which costs them new patients', audit: { hasWebsite: true, url: 'http://smile.example', finalUrl: 'http://smile.example/', platform: 'Wix', ms: 5200, need: 60, issues: [{ text: 'Not secure: no HTTPS', weight: 25 }, { text: 'Not mobile-friendly (no responsive viewport)', weight: 30 }] }, pitch: 'Hi Smile Dental team, …', pitchSubject: 'Your site shows "Not secure"', },
  'osm:node/2': { id: 'osm:node/2', type: 'outbound', source: 'OpenStreetMap', sourceDetail: 'Gym · Lahore', title: 'Iron Gym (Gym, Lahore)', url: 'https://www.openstreetmap.org/node/2', business: { name: 'Iron Gym', category: 'Gym', address: 'Lahore' }, contact: { phone: '+92 300 1234567' }, region: 'Pakistan', country: 'Pakistan', city: 'Lahore', foundAt: now, status: 'new', score: 75, audit: { hasWebsite: false, need: 70, issues: [{ text: 'No website listed for this business', weight: 70 }] } },
  'osm:node/4': { id: 'osm:node/4', type: 'outbound', source: 'OpenStreetMap', sourceDetail: 'Gym · London', title: 'Fit Studio (Gym, London)', url: 'https://www.openstreetmap.org/node/4', business: { name: 'Fit Studio', category: 'Gym', address: 'London' }, contact: { phone: '+44 20 7000 0000', website: 'https://fit.example/old.htm' }, region: 'West', country: 'UK', city: 'London', foundAt: now, status: 'skipped', score: 35, audit: { hasWebsite: true, url: 'https://fit.example/', need: 15, issues: [{ key: 'dead-link', text: 'The link on their map listing leads to a missing page (HTTP 404); their homepage works', weight: 15 }] } },
  'osm:node/3': { id: 'osm:node/3', type: 'outbound', source: 'OpenStreetMap', sourceDetail: 'Cafe · Karachi', title: 'Chai Corner (Cafe, Karachi)', url: 'https://www.openstreetmap.org/node/3', business: { name: 'Chai Corner', category: 'Cafe', address: 'Karachi' }, contact: { phone: '+92 21 1234567' }, region: 'Pakistan', country: 'Pakistan', city: 'Karachi', foundAt: now, status: 'new', score: 45, pitch: 'Old pitch', audit: { hasWebsite: false, unverified: true, need: 60, issues: [{ text: 'No website on its map listing', weight: 60 }] } },
};
fs.writeFileSync(path.join(DATA, 'leads.json'), JSON.stringify(fixture));

const server = spawn(process.execPath, [path.join(ROOT, 'server.mjs')], {
  env: { ...process.env, LH_DATA: DATA, LH_CONFIG: path.join(TMP, 'config.json'), LH_OFFER: path.join(TMP, 'offer.json'), LH_PORT: String(PORT), LH_NO_SPAWN: '1' }, stdio: 'pipe',
});
for (let i = 0; i < 50; i++) { try { await fetch(BASE + '/api/leads'); break; } catch { await new Promise((r) => setTimeout(r, 200)); } }

const browser = await chromium.launch({ channel: 'chrome', headless: !process.argv.includes('--headed') });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 860 } });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(e.message));

const results = [];
const assert = (c, m) => { if (!c) throw new Error(m); };
async function test(name, fn) {
  try { await fn(); results.push({ ok: true }); console.log(`  ✓ ${name}`); }
  catch (e) { results.push({ ok: false }); console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); await page.screenshot({ path: path.join(TMP, `fail-${results.length}.png`) }).catch(() => {}); }
}
const apiJson = async (p, o) => (await fetch(BASE + '/api/' + p, o)).json();
const go = async (hash) => {
  if (await page.locator('#drawer.open').count()) await page.keyboard.press('Escape');
  await page.goto(BASE + '/' + hash); await page.locator('#view h1').waitFor({ timeout: 10000 }); await page.waitForTimeout(250);
};
const drawer = () => page.locator('#drawer.open');
const toast = async () => { await page.waitForTimeout(250); return page.locator('#toast').innerText(); };
const lead = (id) => `#/leads/${encodeURIComponent(id)}`;

console.log(`\nLead Hunter e2e · data copy in ${TMP}\n`);

await test('Overview shows qualified count, pipeline and region/source breakdowns', async () => {
  await go('#/overview');
  assert((await page.locator('.tile .v').first().innerText()) === '4', 'qualified tile should be 4');
  assert(await page.locator('.list .item').count() === 3, 'best-leads list should show 3 (not the awarded one)');
  for (const h of ['Funnel', 'Qualified leads by region', 'Leads by source']) assert(await page.locator('.panel h2', { hasText: h }).count(), `${h} panel missing`);
});
await test('Leads: status chips, type/region filters, search and sort', async () => {
  await go('#/leads');
  assert(await page.locator('tbody tr').count() === 4, 'qualified chip should list 4');
  assert((await page.locator('tbody tr').last().innerText()).includes('Awarded on Freelancer.com'), 'awarded post should sink to the bottom with a label');
  await page.locator('.chip', { hasText: 'Skipped' }).click(); await page.waitForTimeout(150);
  assert(await page.locator('tbody tr').count() === 2, 'skipped should list 2');
  await page.locator('.chip', { hasText: 'All' }).click();
  await page.selectOption('#type', 'outbound'); await page.waitForTimeout(150);
  assert((await page.locator('tbody tr').allInnerTexts()).every((t) => t.includes('Outbound')), 'type filter leaked');
  await page.selectOption('#type', ''); await page.selectOption('#region', 'Gulf'); await page.waitForTimeout(150);
  assert(await page.locator('tbody tr').count() === 1, 'region filter wrong');
  await page.selectOption('#region', '');
  await page.fill('#q', 'bakery'); await page.waitForTimeout(450);
  assert(await page.locator('tbody tr').count() === 1, 'search wrong');
  await page.fill('#q', 'ordering bakery'); await page.waitForTimeout(450);
  assert(await page.locator('tbody tr').count() === 1, 'multi-word search should match words anywhere, incl. the post');
  await page.fill('#q', 'bakery shopify'); await page.waitForTimeout(450);
  assert(await page.locator('tbody tr').count() === 0, 'every word must match');
  await page.fill('#q', ''); await page.waitForTimeout(450);
  await page.selectOption('#type', 'inbound'); await page.selectOption('#sort', 'budget'); await page.waitForTimeout(150);
  assert((await page.locator('tbody tr').first().innerText()).includes('bakery'), 'budget sort should put the $750 job first');
  await page.selectOption('#sort', 'score'); await page.selectOption('#type', ''); await page.locator('.chip', { hasText: 'Qualified' }).click();
  await go(lead('freelancer:2')); await drawer().waitFor();
  assert((await page.locator('#drawer').innerText()).includes("can't bid on it"), 'closed note missing in the lead panel');
});
await test('Inbound lead panel: post, budget, red flags, AI quick actions', async () => {
  await go(lead('hn:a')); await drawer().waitFor();
  assert((await page.locator('#drawer h1').innerText()).includes('Shopify'), 'wrong lead');
  assert(await page.locator('#drawer h3', { hasText: 'Red flags' }).count(), 'red flags missing');
  assert(await page.locator('#drawer .chip', { hasText: 'Write proposal' }).count(), 'inbound quick actions missing');
  await page.locator('#drawer .chip', { hasText: 'Summarize' }).click();
  await page.locator('.msg.ai:not(.thinking)').first().waitFor({ timeout: 5000 });
  await page.locator('[data-act=use-pitch]').first().click(); await page.waitForTimeout(300);
  assert((await apiJson('leads/' + encodeURIComponent('hn:a'))).pitch.includes('(test)'), 'AI answer not saved as message');
});
await test('Outbound lead panel: business, audit findings, email link, AI quick actions', async () => {
  await go(lead('osm:node/1')); await drawer().waitFor();
  assert(await page.locator('.issues li').count() === 2, 'audit findings missing');
  const mail = await page.locator('#drawer a', { hasText: 'Open in email' }).getAttribute('href');
  assert(mail.startsWith('mailto:info@smile.example') && mail.includes('subject='), `bad mailto ${mail}`);
  assert(await page.locator('#drawer .chip', { hasText: 'Explain findings' }).count(), 'outbound quick actions missing');
});
await test('Unverified "no website" is labelled and can be confirmed', async () => {
  await go('#/leads'); await page.locator('.chip', { hasText: 'Queued' }).click(); await page.waitForTimeout(150);
  assert((await page.locator('tbody tr', { hasText: 'Iron Gym' }).innerText()).includes('unverified'), 'list should say unverified');
  await go(lead('osm:node/2')); await drawer().waitFor();
  assert((await page.locator('#nosite-note').innerText()).includes('Unverified'), 'unverified note missing');
  assert(!(await page.locator('#drawer a', { hasText: 'Open in email' }).count()), 'email button shown without an email');
  await page.locator('[data-act=confirm-nosite]').click(); await page.waitForTimeout(400);
  const l = JSON.parse(fs.readFileSync(path.join(DATA, 'leads.json'), 'utf8'))['osm:node/2'];
  assert(l.audit.confirmedNoSite && l.audit.need === 70 && l.score === 75, `confirm not saved: ${JSON.stringify(l.audit)} ${l.score}`);
  assert((await page.locator('#drawer').innerText()).includes('you checked') && !(await page.locator('#nosite-note').count()), 'drawer still says unverified');
});
await test('Re-check website queues an outbound lead for a fresh audit', async () => {
  await go(lead('osm:node/4')); await drawer().waitFor();
  await page.locator('[data-act=reaudit]').click(); await page.waitForTimeout(400);
  const l = JSON.parse(fs.readFileSync(path.join(DATA, 'leads.json'), 'utf8'))['osm:node/4'];
  assert(!l.audit && l.status === 'new' && l.contact.website === 'https://fit.example/old.htm', `not re-queued: ${JSON.stringify(l)}`);
});
await test('Entering their real website queues the lead for a fresh audit', async () => {
  await go(lead('osm:node/3')); await drawer().waitFor();
  await page.fill('#site-url', 'not a url'); await page.click('#site-form button'); await page.waitForTimeout(300);
  assert((await toast()).includes("doesn't look like"), 'bad address accepted');
  const i = errors.findIndex((x) => /status of 400/.test(x)); if (i >= 0) errors.splice(i, 1); // the 400 we just provoked
  await page.fill('#site-url', 'chaicorner.example.pk'); await page.click('#site-form button'); await page.waitForTimeout(400);
  const l = JSON.parse(fs.readFileSync(path.join(DATA, 'leads.json'), 'utf8'))['osm:node/3'];
  assert(l.contact.website === 'https://chaicorner.example.pk/' && !l.audit && l.status === 'new' && l.score === null, `website not queued: ${JSON.stringify(l)}`);
  assert((await page.locator('#drawer').innerText()).includes('Not checked yet'), 'drawer should show it awaits a check');
});
await test('Rule-skipped lead says why; Re-check with AI overrides the rule', async () => {
  await go('#/leads'); await page.locator('.chip', { hasText: 'Skipped' }).click(); await page.waitForTimeout(150);
  assert((await page.locator('tbody tr').first().innerText()).includes('Commission-only'), 'skip reason missing from the list');
  await go(lead('hn:b')); await drawer().waitFor();
  assert((await page.locator('#drawer .note').innerText()).includes('without AI'), 'skip reason note missing');
  await page.locator('[data-act=requalify]').click(); await page.waitForTimeout(300);
  const l = JSON.parse(fs.readFileSync(path.join(DATA, 'leads.json'), 'utf8'))['hn:b'];
  assert(l.status === 'new' && l.forceAI === true && !l.skipReason, `requalify should force AI: ${JSON.stringify({ s: l.status, f: l.forceAI, r: l.skipReason })}`);
  await page.keyboard.press('Escape');
});
await test('Editing the message, deal value and notes persists', async () => {
  await go(lead('osm:node/1')); await drawer().waitFor();
  await page.fill('#pitch', 'Edited pitch'); await page.locator('[data-act=save-pitch]').click();
  await page.fill('#value', '600'); await page.fill('#notes', 'Spoke to the receptionist');
  await page.locator('[data-act=save-deal]').click(); await page.waitForTimeout(300);
  const l = await apiJson('leads/' + encodeURIComponent('osm:node/1'));
  assert(l.pitch === 'Edited pitch' && l.value === 600 && l.notes === 'Spoke to the receptionist', 'edits not saved');
  const bad = await fetch(`${BASE}/api/leads/${encodeURIComponent('osm:node/1')}`, { method: 'POST', body: JSON.stringify({ value: -5 }) });
  assert(bad.status === 400, 'negative deal value accepted');
});
await test('Walk a lead through the pipeline to Won; values roll up', async () => {
  await go(lead('osm:node/1')); await drawer().waitFor();
  for (const [act, col] of [['contacted', 'Contacted'], ['replied', 'Replied'], ['proposal', 'Proposal sent'], ['won', 'Won']]) {
    await page.locator(`[data-act=${act}]`).click(); await page.waitForTimeout(400);
    assert((await apiJson('leads/' + encodeURIComponent('osm:node/1'))).status === act, `status not ${act}`);
  }
  await page.keyboard.press('Escape'); await go('#/pipeline');
  const won = page.locator('.col').filter({ has: page.locator('h2', { hasText: 'Won' }) });
  assert((await won.innerText()).includes('Smile Dental') && (await won.innerText()).includes('$600'), 'Won column missing deal or value');
  await go('#/overview');
  assert((await page.locator('.tile .v').nth(3).innerText()) === '$600', 'won value tile wrong');
});
await test('"Not a fit" moves a lead to Closed', async () => {
  await go(lead('hn:a')); await drawer().waitFor();
  await page.locator('[data-act=dismissed]').click(); await page.waitForTimeout(300);
  assert((await apiJson('leads/' + encodeURIComponent('hn:a'))).status === 'dismissed', 'not dismissed');
});
await test('Source health: failing sources flagged on Overview, every source explained in Settings', async () => {
  await go('#/overview');
  const alert = await page.locator('.source-alert').innerText();
  assert(alert.includes('OpenStreetMap') && !alert.includes('Freelancer'), `overview alert wrong: ${alert}`);
  await go('#/settings');
  assert((await page.locator('[data-health=freelancer]').innerText()).includes('42 found'), 'freelancer health missing');
  assert((await page.locator('[data-health=osm]').innerText()).includes('all map servers failed'), 'osm failure missing');
  assert((await page.locator('[data-health=hn]').innerText()).includes('Not checked yet'), 'unchecked source should say so');
  const last = await page.locator('#last-run').innerText();
  assert(last.includes('12 min ago') && last.includes('15 new') && last.includes('2 qualified') && last.includes('quota ran out'), `last run line wrong: ${last}`);
});
await test('My offer saves and the list fields split per line', async () => {
  await go('#/offer');
  await page.fill('#o-rates', 'Websites from $400'); await page.fill('#o-services', 'Websites\nSEO fixes\n');
  await page.click('#offer-save'); await page.waitForTimeout(300);
  const o = await apiJson('offer');
  assert(o.rates === 'Websites from $400' && o.services.length === 2, `offer not saved: ${JSON.stringify(o.services)}`);
});
await test('Settings: sources toggle, validation, switch and power button stay in sync', async () => {
  await go('#/settings');
  await page.locator('label.switch', { has: page.locator('[data-source=hn]') }).click(); // the visible toggle, as a user would
  assert(!(await page.locator('[data-source=hn]').isChecked()), 'HN toggle did not switch off');
  await page.fill('#set-minScore', '120'); await page.click('#save-set');
  assert((await toast()).includes('0–100'), 'invalid score accepted');
  await page.fill('#set-minScore', '55'); await page.click('#save-set'); await page.waitForTimeout(300);
  const cfg = JSON.parse(fs.readFileSync(path.join(TMP, 'config.json'), 'utf8'));
  assert(cfg.minScore === 55 && cfg.sources.hn.enabled === false && cfg.sources.osm.cities.length > 10, 'settings not saved correctly');
  await page.locator('label.switch').first().click(); await page.waitForTimeout(500);
  assert((await page.locator('#pipe-state').innerText()).includes('is on'), 'sidebar not on');
  await page.click('#power'); await page.waitForTimeout(500);
  assert(!(await page.locator('#enabled').isChecked()), 'settings switch out of sync');
});
await test('API rejects bad input and never serves private files', async () => {
  assert((await fetch(BASE + '/api/leads/nope')).status === 404, 'unknown lead not 404');
  assert((await fetch(`${BASE}/api/leads/${encodeURIComponent('osm:node/2')}`, { method: 'POST', body: '{"status":"hacked"}' })).status === 400, 'bad status accepted');
  assert((await fetch(`${BASE}/api/leads/${encodeURIComponent('osm:node/2')}/chat`, { method: 'POST', body: '{"question":" "}' })).status === 400, 'empty question accepted');
  for (const p of ['/..%2Fconfig.json', '/..%2Foffer.json', '/..%2F..%2Fdata%2Fleads.json']) {
    const t = await (await fetch(BASE + p)).text();
    assert(!/"minScore"|"proof"|"audit"/.test(t), `${p} leaked a private file`);
  }
});
await test('Bulk: select leads, mark not a fit, undo; export CSV', async () => {
  await go('#/leads'); await page.locator('.chip', { hasText: 'Queued' }).click(); await page.waitForTimeout(150);
  const queued = await page.locator('tbody tr').count();
  assert(queued >= 2, `need queued leads, got ${queued}`);
  await page.locator('#sel-all').check(); await page.waitForTimeout(150);
  assert((await page.locator('.bulk').innerText()).includes(`${queued} selected`), 'selection count wrong');
  assert(!(await drawer().count()), 'ticking a box opened the lead');
  await page.locator('[data-bulk=dismissed]').click(); await page.waitForTimeout(400);
  const stillNew = () => Object.values(JSON.parse(fs.readFileSync(path.join(DATA, 'leads.json'), 'utf8'))).filter((l) => l.status === 'new').length;
  assert(stillNew() === 0, 'bulk dismiss left queued leads');
  await page.locator('#toast button', { hasText: 'Undo' }).click(); await page.waitForTimeout(400);
  assert(stillNew() === queued, 'undo did not restore');
  await page.locator('[data-sel]').first().check(); await page.waitForTimeout(150);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('[data-bulk=export]').click()]);
  const lines = fs.readFileSync(await dl.path(), 'utf8').trim().split('\r\n');
  assert(lines[0].replace(/^﻿/, '').startsWith('Status,Score,Type,Title') && lines.length === 2, `export wrong: ${lines.length} lines`);
  const all = await (await fetch(BASE + '/api/export', { method: 'POST', body: '{}' })).text();
  assert(all.trim().split('\r\n').length === Object.keys(fixture).length + 1, 'export of everything wrong');
  assert(all.includes("'+971 4 555 0101"), 'phone not protected from spreadsheet formulas');
  await page.locator('[data-bulk=clear]').click();
});
await test('Keyboard: open a lead with Enter, Tab stays in the panel, Escape returns to the row', async () => {
  await go('#/leads');
  const row = page.locator('tbody tr').first(); const id = await row.getAttribute('data-lead');
  await row.focus(); await page.keyboard.press('Enter'); await drawer().waitFor(); await page.waitForTimeout(300);
  assert(await page.evaluate(() => document.activeElement?.classList.contains('close')), 'focus should start on the close button');
  await page.keyboard.press('Shift+Tab');
  assert(await page.evaluate(() => document.querySelector('#drawer').contains(document.activeElement)), 'Shift+Tab left the panel');
  await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  assert(await page.evaluate((x) => document.activeElement?.dataset.lead === x, id), 'focus did not return to the row');
  assert(await page.evaluate(() => document.querySelector('#drawer').inert), 'closed panel should be inert (not tabbable)');
});
await test('A link to a lead that no longer exists says so instead of hanging', async () => {
  await go(lead('freelancer:gone')); await drawer().waitFor();
  await page.locator('#drawer h1', { hasText: 'Lead not found' }).waitFor({ timeout: 3000 });
  const i = errors.findIndex((x) => /status of 404/.test(x)); if (i >= 0) errors.splice(i, 1); // the 404 we just provoked
  await page.keyboard.press('Escape');
});
await test('Phone width fits; dark mode works; no console errors', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const v of ['overview', 'leads', 'offer', 'settings']) {
    await go('#/' + v);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert(over <= 1, `#/${v} overflows by ${over}px`);
  }
  await go(lead('osm:node/1')); await drawer().waitFor();
  const wide = await page.evaluate(() => [...document.querySelectorAll('#drawer *')].filter((el) => el.getBoundingClientRect().right > innerWidth + 1).map((el) => el.className || el.tagName).slice(0, 3));
  assert(!wide.length, `lead panel overflows on a phone: ${wide.join(', ')}`);
  await page.keyboard.press('Escape');
  await page.setViewportSize({ width: 1366, height: 860 });
  await page.emulateMedia({ colorScheme: 'dark' }); await go('#/overview');
  const [r, g, b] = (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).match(/\d+/g).map(Number);
  assert(r + g + b < 120, 'dark mode background too light');
  assert(!errors.length, errors.slice(0, 3).join(' | '));
});

process.on('unhandledRejection', (e) => { if (!/closed/i.test(e?.message || '')) throw e; });
await browser.close(); server.kill();
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed${failed ? ` (screenshots in ${TMP})` : ''}\n`);
if (!failed) fs.rmSync(TMP, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
