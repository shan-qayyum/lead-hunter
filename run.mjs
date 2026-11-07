// Scheduled entry point: collect leads -> check listings -> audit outbound sites -> qualify with AI.
import fs from 'node:fs';
import path from 'node:path';
import { DATA, log, isOn, config, loadLeads, updateLeads, savePipelineLead, isAlive, loadState, saveState, healthEntry, llmBaseUrl } from './lib.mjs';

// Switched off in the app: exit before any network or AI call. "Run one check now" passes --force.
if (!isOn() && !process.argv.includes('--force')) process.exit(0);

const { freelancer, freelancerStatus, hn } = await import('./sources/inbound.mjs');
const { osm } = await import('./sources/outbound.mjs');
const { auditSite } = await import('./audit.mjs');
const { listingProvider, applyListing, noteSocialOnly } = await import('./listing.mjs');
const { qualifyInbound, pitchOutbound, outboundScore, buildQueue, applySourceStatus } = await import('./qualify.mjs');

const LOCK = path.join(DATA, 'run.lock');
fs.mkdirSync(DATA, { recursive: true });
let holder = 0;
try { holder = Number(fs.readFileSync(LOCK, 'utf8')); } catch {}
if (isAlive(holder)) { log('run: previous run still active, skipping'); process.exit(0); }
fs.writeFileSync(LOCK, String(process.pid));
setTimeout(() => { log('run: exceeded 25 min, aborting'); fs.rmSync(LOCK, { force: true }); process.exit(1); }, 25 * 60 * 1000).unref();

// Is the AI endpoint reachable? If not, leads are still collected and audited, just not scored.
async function aiReachable() {
  try { await fetch(`${llmBaseUrl()}/models`, { signal: AbortSignal.timeout(5000) }); return true; }
  catch { log(`run: AI endpoint ${llmBaseUrl()} is not reachable; leads are collected but not scored this run`); return false; }
}

// What this run did, saved as state.lastRun when it ends.
const summary = { startedAt: new Date().toISOString(), added: 0, closed: 0, ruleSkipped: 0, aiChecked: 0, qualified: 0 };
try {
  const cfg = config();
  const src = cfg.sources;
  const started = Date.now();

  // 1. Collect from every enabled source; merge only new ids into the freshest file.
  // Each source's outcome is kept in state.health for the Settings and Overview panels.
  const found = [];
  const collectors = { freelancer: () => freelancer(src.freelancer), hn: () => hn(), osm: () => osm(src.osm) };
  for (const [name, collect] of Object.entries(collectors)) {
    if (!src[name]?.enabled) continue;
    const out = await collect();
    found.push(...out);
    const st = loadState();
    saveState({ ...st, health: { ...st.health, [name]: healthEntry(st.health?.[name], out) } });
  }
  const added = updateLeads((leads) => {
    let n = 0;
    for (const l of found) if (!leads[l.id]) { leads[l.id] = l; n++; }
    return n;
  });
  summary.added = added;
  log(`collect: ${found.length} seen, ${added} new`);

  // 1b. Retire Freelancer posts that were awarded or closed, and refresh bid counts.
  if (src.freelancer?.enabled) {
    const ids = Object.values(loadLeads()).filter((l) => l.source === 'Freelancer.com' && ['new', 'qualified'].includes(l.status) && !l.sourceClosed).map((l) => l.id).slice(0, 500);
    const status = await freelancerStatus(ids);
    const closed = updateLeads((leads) => [...status].filter(([id, st]) => leads[id] && applySourceStatus(leads[id], st)).length);
    summary.closed = closed;
    if (closed) log(`collect: ${closed} Freelancer project${closed > 1 ? 's' : ''} closed or awarded since found`);
  }

  // 2. Check each business's public listing (when a provider is configured), then audit the website
  // it lists (no AI). OpenStreetMap is often years out of date: closed businesses, chain takeovers
  // and previous owners' websites.
  const toAudit = Object.values(loadLeads()).filter((l) => l.type === 'outbound' && l.status === 'new' && !l.audit).slice(0, cfg.auditsPerRun);
  let listingSkipped = 0;
  const checkListing = listingProvider(cfg);
  for (const l of toAudit) {
    const b = l.business || {};
    if (!l.listing && checkListing) {
      applyListing(l, await checkListing({ name: b.name, address: b.address, city: l.city, phone: l.contact?.phone, lat: b.lat, lon: b.lon }));
      if (l.status === 'skipped') { savePipelineLead(l, 'new'); listingSkipped++; log(`listing: skipped ${b.name}: ${l.skipReason}`); continue; }
    }
    const street = b.street || ((b.address || '').endsWith(` ${l.city}`) ? b.address.slice(0, -l.city.length - 1) : ''); // older leads lack b.street
    l.audit = await auditSite(l.contact.website, { name: b.name, country: l.country, phone: l.contact.phone, street });
    noteSocialOnly(l);
    if (l.audit.foundBy) l.contact = { ...l.contact, website: l.audit.url };
    if (l.audit.emails?.length && !l.contact.email) l.contact = { ...l.contact, email: l.audit.emails[0] };
    l.score = outboundScore(l);
    savePipelineLead(l, 'new');
  }
  summary.listingSkipped = listingSkipped;
  if (toAudit.length) log(`audit: ${toAudit.length - listingSkipped} websites checked, ${listingSkipped} skipped after the listing check`);

  // 3. Low outbound and clearly-irrelevant inbound are skipped by rule; the rest get AI qualification,
  // inbound and outbound alternating, within a time budget.
  const { ruleSkip, ai: queue } = buildQueue(Object.values(loadLeads()), cfg);
  for (const l of ruleSkip) { l.status = 'skipped'; l.processedAt = new Date().toISOString(); savePipelineLead(l, 'new'); }
  summary.ruleSkipped = ruleSkip.length;
  if (ruleSkip.length) log(`qualify: ${ruleSkip.length} skipped by rule (low score, not web work, commission-only or duplicate)`);
  if (queue.length && await aiReachable()) {
    let qualified = 0;
    for (const l of queue) {
      if (Date.now() - started > 15 * 60 * 1000) { log('qualify: time budget used, continuing next run'); break; }
      summary.aiChecked++;
      try {
        if (l.type === 'inbound') {
          const q = await qualifyInbound(l);
          Object.assign(l, { score: q.score, service: q.service, summary: q.summary, budgetNote: q.budgetNote, redFlags: q.redFlags, pitch: q.reply, engine: q.engine });
          l.status = q.relevant && q.score >= cfg.minScore ? 'qualified' : 'skipped';
        } else {
          const p = await pitchOutbound(l);
          Object.assign(l, { pitch: p.email, pitchSubject: p.subject, service: p.angle, engine: p.engine });
          l.status = 'qualified';
        }
        if (l.status === 'qualified') qualified++;
        Object.assign(l, { forceAI: undefined, error: undefined }); // undefined (not delete) so the merge clears them
        l.processedAt = new Date().toISOString();
        log(`qualify: ${l.status} ${l.score} ${l.title.slice(0, 70)} [${l.engine || 'rules'}]`);
      } catch (e) {
        if (e.rateLimited) { summary.aiChecked--; summary.aiQuotaOut = true; log('qualify: AI quota used up, pausing until the next run'); break; }
        l.attempts = (l.attempts || 0) + 1;
        if (l.attempts >= 3) l.status = 'error';
        l.error = e.message;
        log('qualify failed', l.id, e.message);
      }
      savePipelineLead(l, 'new');
    }
    summary.qualified = qualified;
    if (qualified) log(`run: ${qualified} new lead${qualified > 1 ? 's' : ''} ready to review in the app`);
  } else if (queue.length) summary.aiDown = true;
} catch (e) {
  log('run failed:', e.stack || e.message);
  summary.failed = e.message;
} finally {
  saveState({ ...loadState(), lastRun: { ...summary, finishedAt: new Date().toISOString() } }); // sidebar + Overview
  fs.rmSync(LOCK, { force: true });
}
