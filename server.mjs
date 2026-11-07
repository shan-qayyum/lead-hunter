// Lead Hunter app: JSON API + static frontend at http://localhost:4818
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { outboundScore } from './qualify.mjs';
import { ROOT, DATA, CONFIG, OFFER, loadLeads, updateLeads, readJson, writeJson, isOn, setOn, log, chat as aiChat, isAlive, loadState } from './lib.mjs';

const PORT = Number(process.env.LH_PORT) || 4818;
const NO_SPAWN = !!process.env.LH_NO_SPAWN; // tests: never start runs or call AI
const PUBLIC = path.join(ROOT, 'public');
const LOCK = path.join(DATA, 'run.lock');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const STATUSES = ['new', 'qualified', 'skipped', 'contacted', 'replied', 'proposal', 'won', 'lost', 'dismissed', 'error'];
const STAMP = { contacted: 'contactedAt', replied: 'repliedAt', proposal: 'proposalAt', won: 'closedAt', lost: 'closedAt', dismissed: 'closedAt' };

const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };
function busy() {
  const pid = Number(readText(LOCK));
  if (!pid) return false;
  if (isAlive(pid)) return true;
  fs.rmSync(LOCK, { force: true });
  return false;
}
// Last outcome per enabled source (written by run.mjs).
const sourceHealth = (cfg) => Object.fromEntries(Object.entries(loadState().health || {}).filter(([k]) => cfg.sources?.[k]?.enabled));

function summary(l) {
  return {
    id: l.id, type: l.type, source: l.source, sourceDetail: l.sourceDetail, title: l.title, url: l.url,
    status: l.status, score: l.score ?? null, service: l.service, region: l.region, city: l.city, country: l.country,
    postedAt: l.postedAt, foundAt: l.foundAt, budget: l.budget, value: l.value ?? null,
    hasWebsite: l.type === 'outbound' ? !!l.audit?.hasWebsite : null, noSiteConfirmed: !!l.audit?.confirmedNoSite, issues: l.audit?.issues?.length ?? null,
    reach: { email: !!(l.contact?.email), phone: !!l.contact?.phone },
    contactedAt: l.contactedAt, hasNotes: !!l.notes, skipReason: l.skipReason, sourceClosed: l.sourceClosed, bids: l.bids,
    // Extra text the Leads search looks through (kept short: the list loads every lead).
    search: [l.business?.name, l.skills?.join(' '), l.summary, l.country, l.contact?.handle, l.notes, (l.body || '').slice(0, 400)].filter(Boolean).join(' ').toLowerCase(),
  };
}

function stats(leads) {
  const by = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const l of leads) by[l.status] = (by[l.status] || 0) + 1;
  const active = ['contacted', 'replied', 'proposal'];
  return {
    by, total: leads.length,
    inbound: leads.filter((l) => l.type === 'inbound').length, outbound: leads.filter((l) => l.type === 'outbound').length,
    qualified: by.qualified, contacted: leads.filter((l) => l.contactedAt).length,
    replies: leads.filter((l) => l.repliedAt).length, won: by.won,
    pipelineValue: leads.filter((l) => active.includes(l.status)).reduce((s, l) => s + (Number(l.value) || 0), 0),
    wonValue: leads.filter((l) => l.status === 'won').reduce((s, l) => s + (Number(l.value) || 0), 0),
    sources: leads.filter((l) => l.status !== 'skipped' && l.status !== 'new').reduce((m, l) => ((m[l.source] = (m[l.source] || 0) + 1), m), {}),
    regions: leads.filter((l) => l.status === 'qualified').reduce((m, l) => ((m[l.region || 'Unknown'] = (m[l.region || 'Unknown'] || 0) + 1), m), {}),
  };
}

const body = (req) => new Promise((resolve) => {
  let s = '';
  req.on('data', (d) => (s += d));
  req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
});
const CSV_COLUMNS = [
  ['Status', (l) => l.status], ['Score', (l) => l.score], ['Type', (l) => l.type], ['Title', (l) => l.title], ['Source', (l) => l.source],
  ['Link', (l) => l.url], ['Service', (l) => l.service], ['Business', (l) => l.business?.name], ['Category', (l) => l.business?.category],
  ['City', (l) => l.city], ['Country', (l) => l.country || l.region], ['Email', (l) => l.contact?.email], ['Phone', (l) => l.contact?.phone],
  ['Website', (l) => l.audit?.finalUrl || l.contact?.website], ['Website issues', (l) => l.audit?.issues?.map((i) => i.text).join('; ')],
  ['Budget (USD)', (l) => (l.budget?.max ? `${l.budget.min}-${l.budget.max}` : '')], ['Posted', (l) => l.postedAt || l.foundAt],
  ['Contacted', (l) => l.contactedAt], ['Deal value', (l) => l.value], ['Notes', (l) => l.notes],
];
// Cells starting with = + - @ are prefixed so a spreadsheet never runs them as formulas.
const cell = (v) => { const t = String(v ?? '').replace(/^[=+\-@]/, (c) => `'${c}`); return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
export const toCsv = (rows) => [CSV_COLUMNS.map(([h]) => h), ...rows.map((l) => CSV_COLUMNS.map(([, f]) => f(l)))].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
const send = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
const detach = (args) => NO_SPAWN ? log(`(test mode) would run: ${args.join(' ')}`)
  : spawn(process.execPath, [path.join(ROOT, args[0]), ...args.slice(1)], { cwd: ROOT, detached: true, stdio: 'ignore' }).unref();

async function api(req, res, url) {
  const [resource, rawId, action] = url.pathname.split('/').filter(Boolean).slice(1);
  const id = rawId && decodeURIComponent(rawId);

  if (resource === 'leads' && !id && req.method === 'GET') {
    const leads = Object.values(loadLeads());
    const cfg = readJson(CONFIG, {});
    return send(res, 200, { leads: leads.map(summary), stats: stats(leads), busy: busy(), health: sourceHealth(cfg), lastRun: loadState().lastRun, aiPerRun: cfg.aiPerRun });
  }

  if (resource === 'leads' && id) {
    const l = loadLeads()[id];
    if (!l) return send(res, 404, { error: 'unknown lead' });
    if (req.method === 'GET' && !action) {
      return send(res, 200, { ...summary(l), body: l.body, sourceClosedAt: l.sourceClosedAt, summaryText: l.summary, budgetNote: l.budgetNote, redFlags: l.redFlags || [], skills: l.skills || [], bids: l.bids,
        business: l.business, contact: l.contact, audit: l.audit, mapsUrl: l.mapsUrl, pitch: l.pitch || '', pitchSubject: l.pitchSubject || '',
        notes: l.notes || '', chat: l.chat || [], engine: l.engine, error: l.error });
    }
    if (req.method === 'POST' && !action) {
      const b = await body(req);
      if (b.status && !STATUSES.includes(b.status)) return send(res, 400, { error: `unknown status "${b.status}"` });
      if (b.value !== undefined && b.value !== '' && !(Number(b.value) >= 0)) return send(res, 400, { error: 'Deal value must be a positive number.' });
      let site;
      if (b.website !== undefined) {
        const w = String(b.website).trim();
        try { site = new URL(/^https?:\/\//i.test(w) ? w : `https://${w}`); } catch {}
        if (!site || !site.hostname.includes('.')) return send(res, 400, { error: "That doesn't look like a web address." });
      }
      const now = new Date().toISOString();
      const updated = updateLeads((leads) => {
        const x = leads[id];
        if (b.status) { x.status = b.status; if (STAMP[b.status] && !x[STAMP[b.status]]) x[STAMP[b.status]] = now; }
        if (typeof b.notes === 'string') x.notes = b.notes;
        if (b.value !== undefined) x.value = b.value === '' ? null : Number(b.value);
        if (typeof b.pitch === 'string') { x.pitch = b.pitch; x.pitchEdited = true; }
        if (b.confirmNoSite && x.audit && !x.audit.hasWebsite) {
          x.audit = { ...x.audit, unverified: false, confirmedNoSite: true, need: 70, issues: [{ key: 'none', text: 'No website (checked on Google Maps)', weight: 70 }] };
          x.score = outboundScore(x);
        }
        if (site) { // they do have a site: the next run audits it and (unless you edited it) redrafts the pitch
          x.contact = { ...x.contact, website: site.href, websiteFrom: 'you' }; delete x.audit; x.score = null; // Google's listing never overrides it
          if (['new', 'qualified', 'skipped'].includes(x.status)) x.status = 'new';
        }
        return x;
      });
      return send(res, 200, summary(updated));
    }
    if (action === 'chat') {
      if (req.method === 'DELETE') { updateLeads((leads) => { delete leads[id].chat; }); return send(res, 200, { chat: [] }); }
      const { question } = await body(req);
      if (!question?.trim()) return send(res, 400, { error: 'Ask something first.' });
      const o = readJson(OFFER, {});
      const system = `You are a research and writing assistant for a freelance web developer, helping with ONE specific lead. Be concrete and practical. Anything the freelancer will send (proposals, emails, messages, quotes) must use ONLY facts from their offer below; never invent results, clients or numbers. ${o.rates ? `Their rates: ${o.rates}.` : 'Rates are not set: suggest how to scope and price, but say they are estimates.'} Plain English, short paragraphs or bullets.
FREELANCER OFFER: ${JSON.stringify(o)}
LEAD (${l.type}, ${l.source}): ${l.title}
${l.budget ? `Budget: ${l.budget.original}\n` : ''}${l.body ? `Post: ${l.body.slice(0, 5000)}\n` : ''}${l.business ? `Business: ${JSON.stringify(l.business)} in ${l.city}, ${l.country}\n` : ''}${l.audit ? `Website audit: ${JSON.stringify({ url: l.audit.finalUrl || l.audit.url, platform: l.audit.platform, issues: l.audit.issues?.map((i) => i.text) })}\n` : ''}${l.pitch ? `Current draft pitch: ${l.pitch}\n` : ''}${l.notes ? `Freelancer's notes: ${l.notes}` : ''}`;
      const history = (l.chat || []).slice(-10).map((m) => ({ role: m.role, content: m.text }));
      try {
        const { text, model } = NO_SPAWN ? { text: `(test) **Answer** for ${l.title.slice(0, 20)}:\n- ${question.slice(0, 40)}`, model: 'test-model' }
          : await aiChat([{ role: 'system', content: system }, ...history, { role: 'user', content: question.trim() }], { temperature: 0.5 });
        const now = new Date().toISOString();
        const c = updateLeads((leads) => { const arr = (leads[id].chat ||= []); arr.push({ role: 'user', text: question.trim(), at: now }, { role: 'assistant', text, model, at: now }); return arr; });
        return send(res, 200, { chat: c });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    if (req.method === 'POST' && action === 'requalify') {
      if (busy()) return send(res, 409, { error: 'A run is in progress. Try again in a few minutes.' });
      updateLeads((leads) => { Object.assign(leads[id], { status: 'new', attempts: 0, forceAI: true }); delete leads[id].error; delete leads[id].pitchEdited; delete leads[id].skipReason; });
      detach(['run.mjs', '--force']);
      return send(res, 202, { ok: true });
    }
  }

  // Many leads at once: { ids, status } sets one status; { restore: { id: status } } undoes it.
  if (resource === 'bulk' && req.method === 'POST') {
    const b = await body(req);
    const changes = b.restore && typeof b.restore === 'object' ? Object.entries(b.restore)
      : Array.isArray(b.ids) ? b.ids.map((id) => [id, b.status]) : [];
    if (!changes.length) return send(res, 400, { error: 'Select some leads first.' });
    if (changes.some(([, st]) => !STATUSES.includes(st))) return send(res, 400, { error: 'unknown status' });
    const now = new Date().toISOString();
    const previous = updateLeads((leads) => Object.fromEntries(changes.filter(([id]) => leads[id]).map(([id, st]) => {
      const x = leads[id], was = x.status;
      x.status = st;
      if (!b.restore && STAMP[st] && !x[STAMP[st]]) x[STAMP[st]] = now;
      return [id, was];
    })));
    return send(res, 200, { updated: Object.keys(previous).length, previous });
  }

  // CSV of the given leads (or all), with full contact details, for a spreadsheet or CRM.
  if (resource === 'export' && req.method === 'POST') {
    const b = await body(req);
    const all = loadLeads();
    const rows = (Array.isArray(b.ids) ? b.ids.map((id) => all[id]).filter(Boolean) : Object.values(all));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="leads.csv"' });
    return res.end('\uFEFF' + toCsv(rows)); // BOM so Excel reads UTF-8
  }

  if (resource === 'pipeline') {
    const cfg = readJson(CONFIG, {});
    if (req.method === 'POST') {
      const b = await body(req);
      if (typeof b.enabled === 'boolean') {
        setOn(b.enabled);
        if (!b.enabled && busy()) { try { process.kill(Number(readText(LOCK).trim())); } catch {} } // switching off stops a run in progress
      }
      if (Number.isFinite(b.minScore)) cfg.minScore = b.minScore;
      if (Number.isFinite(b.aiPerRun)) cfg.aiPerRun = b.aiPerRun;
      if (b.sources) for (const [k, on] of Object.entries(b.sources)) if (cfg.sources[k] && typeof on === 'boolean') cfg.sources[k].enabled = on;
      if (b.regions) cfg.sources.osm.cities.forEach((c) => { c.enabled = b.regions[c.region] !== false; });
      writeJson(CONFIG, cfg);
      if (b.runNow) { if (busy()) return send(res, 409, { error: 'A run is already in progress.' }); detach(['run.mjs', '--force']); }
    }
    const logLines = readText(path.join(DATA, 'pipeline.log')).trim().split('\n').filter(Boolean).slice(-50).reverse();
    return send(res, 200, { enabled: isOn(), busy: busy(), minScore: cfg.minScore, aiPerRun: cfg.aiPerRun,
      sources: Object.fromEntries(Object.entries(cfg.sources).map(([k, v]) => [k, v.enabled])), health: sourceHealth(cfg), lastRun: loadState().lastRun, models: cfg.llm?.models || [], log: logLines });
  }

  if (resource === 'offer') {
    if (req.method === 'POST') {
      const b = await body(req);
      const cur = readJson(OFFER, {});
      for (const k of ['name', 'email', 'website', 'location', 'headline', 'rates', 'availability', 'signature']) if (typeof b[k] === 'string') cur[k] = b[k].trim();
      for (const k of ['services', 'proof']) if (Array.isArray(b[k])) cur[k] = b[k].map((s) => String(s).trim()).filter(Boolean);
      writeJson(OFFER, cur);
    }
    return send(res, 200, readJson(OFFER, {}));
  }
  send(res, 404, { error: 'unknown endpoint' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(PUBLIC, rel));
    const target = file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(PUBLIC, 'index.html');
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(target)] || 'text/plain', 'Cache-Control': 'no-store' });
    fs.createReadStream(target).pipe(res);
  } catch (e) { send(res, 500, { error: e.message }); }
}).listen(PORT, '127.0.0.1', () => console.log(`Lead Hunter: http://localhost:${PORT}`));
