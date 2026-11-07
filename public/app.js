// Lead Hunter frontend: hash-routed views over the local JSON API. No build step.
const $ = (s, el = document) => el.querySelector(s);
const esc = (s = '') => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const api = async (p, opts = {}) => {
  const r = await fetch('/api/' + p, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body && JSON.stringify(opts.body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
  return data;
};
const enc = encodeURIComponent;
// Optional action, e.g. ['Undo', fn]: the toast then stays longer so there's time to click it.
const toast = (msg, action) => {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t);
  if (action) {
    const b = Object.assign(document.createElement('button'), { className: 'btn mini', textContent: action[0] });
    b.onclick = () => { t.classList.remove('show'); action[1]().catch((err) => toast(err.message)); };
    t.append(' ', b);
  }
  toast.t = setTimeout(() => t.classList.remove('show'), action ? 8000 : 3200);
};
// Downloads go through fetch + a temporary link so the ids can be POSTed (a URL would be too long).
async function exportCsv(ids) {
  const r = await fetch('/api/export', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
  if (!r.ok) return toast('Export failed.');
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(await r.blob()), download: `lead-hunter-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${ids.length} lead${ids.length === 1 ? '' : 's'}.`);
}
const ago = (iso) => { if (!iso) return ''; const d = Math.floor((Date.now() - new Date(iso)) / 864e5); return d <= 0 ? 'today' : d === 1 ? '1 day ago' : `${d} days ago`; };
const usd = (n) => (n || n === 0 ? `$${Number(n).toLocaleString()}` : '');
const since = (iso) => { const m = Math.round((Date.now() - new Date(iso)) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : ago(iso); };
const SOURCE_NAMES = { freelancer: 'Freelancer.com', hn: 'Hacker News', osm: 'Local businesses (OpenStreetMap)' };
// One line per source: did the last run reach it, and if not, why and since when.
const healthLine = (h) => {
  if (!h) return '<span class="health">Not checked yet</span>';
  const last = h.lastOkAt ? `last worked ${since(h.lastOkAt)}` : 'has not worked yet';
  if (h.status === 'paused') return `<span class="health warn">Paused after a rate limit; resumes ${esc(localTime(h.lastError.split(' until ')[1] || h.at))}</span>`;
  if (h.status === 'failing') return `<span class="health bad">Failed ${since(h.at)}: ${esc(h.lastError || 'unknown error')} · ${last}</span>`;
  if (h.status === 'partial') return `<span class="health warn">${h.found} found ${since(h.at)}; ${h.errors} of ${h.attempts} requests failed (${esc(h.lastError || '')})</span>`;
  return `<span class="health ok">${h.found} found ${since(h.at)}</span>`;
};
// One line about the latest run, e.g. "Last check 12 min ago: 15 new, 2 qualified".
const lastRunText = (r) => {
  const bits = [r.added && `${r.added} new`, r.closed && `${r.closed} closed on Freelancer`, r.ruleSkipped && `${r.ruleSkipped} skipped by rule`,
    r.aiChecked && `${r.aiChecked} AI-checked`, r.qualified && `${r.qualified} qualified`].filter(Boolean);
  const problem = r.failed ? `run failed: ${r.failed}` : r.aiDown ? 'the AI endpoint was offline' : r.aiQuotaOut ? 'the AI quota ran out' : '';
  return `Last check ${since(r.finishedAt)}: ${esc(bits.join(', ') || 'nothing new')}${problem ? ` · <span class="health warn">${esc(problem)}</span>` : ''}`;
};
const localTime = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const scoreBadge = (s) => `<span class="score ${s == null ? '' : s >= 70 ? 'hi' : s >= 50 ? 'mid' : 'lo'}">${s ?? '–'}</span>`;
const LABEL = { new: 'Queued', qualified: 'Qualified', skipped: 'Skipped', contacted: 'Contacted', replied: 'Replied', proposal: 'Proposal sent', won: 'Won', lost: 'Lost', dismissed: 'Not a fit', error: 'Error' };
const closedLabel = (l) => `${l.sourceClosed === 'awarded to someone' ? 'Awarded' : 'Closed'} on ${l.source}`;
const pill = (s) => `<span class="pill ${s}">${LABEL[s] || s}</span>`;
const typePill = (t) => `<span class="pill ${t === 'inbound' ? 'in' : 'out'}">${t === 'inbound' ? 'Inbound' : 'Outbound'}</span>`;

const PAGE = 200;
let state = { leads: [], stats: null, health: {}, chat: [], selected: new Set(), limit: PAGE, filters: { status: 'qualified', type: '', source: '', region: '', q: '', minScore: 0, sort: 'score' } };
try { Object.assign(state.filters, JSON.parse(localStorage.getItem('lh.filters') || '{}')); } catch {}
const saveFilters = () => { try { localStorage.setItem('lh.filters', JSON.stringify(state.filters)); } catch {} };

async function load() {
  const d = await api('leads');
  state.leads = d.leads; state.stats = d.stats; state.health = d.health || {}; state.lastRun = d.lastRun; state.aiPerRun = d.aiPerRun || 8;
  $('#c-leads').textContent = d.stats.by.qualified || '';
  $('#c-pipe').textContent = (d.stats.by.contacted + d.stats.by.replied + d.stats.by.proposal) || '';
}

// ---------- views ----------
const item = (l) => `<div class="item" data-lead="${esc(l.id)}" tabindex="0" role="button">${scoreBadge(l.score)}
  <div class="grow"><div class="t ellip">${esc(l.title)}</div><div class="m ellip">${esc(l.source)} · ${esc(l.service || l.sourceDetail || '')}${l.budget?.max ? ` · up to ${usd(l.budget.max)}` : ''}</div></div>
  ${typePill(l.type)}</div>`;
const bars = (obj) => {
  const entries = Object.entries(obj).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  return entries.map(([k, n]) => `<div class="row"><span>${esc(k)}</span><span class="bar"><i style="width:${(n / max) * 100}%"></i></span><span class="n">${n}</span></div>`).join('') || '<div class="empty">Nothing yet.</div>';
};

function overview() {
  const s = state.stats;
  const top = state.leads.filter((l) => l.status === 'qualified' && !l.sourceClosed).sort((a, b) => b.score - a.score).slice(0, 7);
  const steps = [['Found', s.total], ['Qualified', s.by.qualified + s.contacted], ['Contacted', s.contacted], ['Replied', s.replies], ['Won', s.won]];
  const max = Math.max(1, s.total);
  // The AI checks a few leads per hourly run; say how long the queue will take so it's no surprise.
  const waiting = state.leads.filter((l) => l.status === 'new').length, hours = Math.ceil(waiting / Math.max(1, state.aiPerRun));
  const sick = Object.entries(state.health).filter(([, h]) => h.status === 'failing' || h.status === 'paused');
  return `
  <h1>Overview</h1><p class="sub">Freelance leads: people asking for web work (inbound) and businesses that need a better website (outbound).</p>
  ${sick.length ? `<div class="panel source-alert" role="status"><b>Some lead sources need attention.</b> ${sick.map(([k, h]) => `${esc(SOURCE_NAMES[k] || k)}: ${healthLine(h)}`).join(' · ')} <a href="#/settings">Details in Settings</a></div>` : ''}
  <div class="grid tiles">
    <a class="panel tile hl" href="#/leads" data-go-status="qualified"><div class="v">${s.by.qualified}</div><div class="k">Qualified leads to contact</div></a>
    <a class="panel tile" href="#/pipeline"><div class="v">${s.by.contacted + s.by.replied + s.by.proposal}</div><div class="k">Conversations in progress</div></a>
    <a class="panel tile" href="#/pipeline"><div class="v money">${usd(s.pipelineValue) || '$0'}</div><div class="k">Open pipeline value</div></a>
    <a class="panel tile" href="#/pipeline"><div class="v money">${usd(s.wonValue) || '$0'}</div><div class="k">Won · ${s.won} deal${s.won === 1 ? '' : 's'}</div></a>
  </div>
  ${waiting > state.aiPerRun * 3 ? `<p class="m backlog">${waiting} leads are queued for the AI check. At ${state.aiPerRun} per hourly run that's about ${hours} hours (fewer once rules skip the irrelevant ones). If your AI quota allows, raise "AI checks per run" in <a href="#/settings">Settings</a>.</p>` : ''}
  <div class="grid two">
    <div class="panel"><h2>Best leads right now</h2><div class="list">${top.map(item).join('') || '<div class="empty">No qualified leads yet. Switch Lead Hunter on, or run a check in Settings.</div>'}</div>
      ${s.by.qualified > 7 ? `<p><a href="#/leads" data-go-status="qualified">See all ${s.by.qualified} →</a></p>` : ''}</div>
    <div class="grid" style="align-content:start">
      <div class="panel"><h2>Funnel</h2><div class="funnel">${steps.map(([k, n]) => `<div class="row"><span>${k}</span><span class="bar"><i style="width:${(n / max) * 100}%"></i></span><span class="n">${n}</span></div>`).join('')}</div></div>
      <div class="panel"><h2>Qualified leads by region</h2><div class="funnel">${bars(s.regions)}</div></div>
      <div class="panel"><h2>Leads by source</h2><div class="funnel">${bars(s.sources)}</div></div>
    </div>
  </div>`;
}

// Every word must appear somewhere: title, service, place, source, skills, business, summary, notes, post.
const matches = (l, terms) => { const hay = `${l.title} ${l.service || ''} ${l.city || ''} ${l.sourceDetail || ''} ${l.source} ${l.search || ''}`.toLowerCase(); return terms.every((t) => hay.includes(t)); };
function filtered() {
  const f = state.filters, terms = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const groups = { qualified: ['qualified'], new: ['new'], skipped: ['skipped'], active: ['contacted', 'replied', 'proposal'], closed: ['won', 'lost', 'dismissed', 'error'], all: null };
  const list = state.leads.filter((l) => (!groups[f.status] || groups[f.status].includes(l.status))
    && (!f.type || l.type === f.type) && (!f.source || l.source === f.source) && (!f.region || (l.region || 'Unknown') === f.region)
    && (!f.minScore || (l.score ?? -1) >= f.minScore)
    && (!terms.length || matches(l, terms)));
  const by = { score: (a, b) => (b.score ?? -1) - (a.score ?? -1), recent: (a, b) => String(b.postedAt || b.foundAt).localeCompare(String(a.postedAt || a.foundAt)), budget: (a, b) => (b.budget?.max || 0) - (a.budget?.max || 0) };
  return list.sort((a, b) => !!a.sourceClosed - !!b.sourceClosed || (by[f.sort] || by.score)(a, b)); // closed posts sink
}

function leads() {
  const f = state.filters, s = state.stats.by;
  const chips = [['qualified', 'Qualified', s.qualified], ['new', 'Queued', s.new], ['skipped', 'Skipped', s.skipped], ['active', 'In progress', s.contacted + s.replied + s.proposal], ['closed', 'Closed', s.won + s.lost + s.dismissed + s.error], ['all', 'All', state.leads.length]];
  const sources = [...new Set(state.leads.map((l) => l.source))].sort();
  const regions = [...new Set(state.leads.map((l) => l.region || 'Unknown'))].sort();
  const list = filtered(), shown = list.slice(0, state.limit);
  const visible = new Set(list.map((l) => l.id));
  for (const id of state.selected) if (!visible.has(id)) state.selected.delete(id); // selection follows the filters
  const sel = [...state.selected];
  return `
  <h1>Leads</h1><p class="sub">Click a lead for the full brief, the drafted message and the AI assistant.</p>
  <div class="filters"><div class="chips">${chips.map(([k, l, n]) => `<button class="chip ${f.status === k ? 'on' : ''}" data-status="${k}">${l}<span class="n">${n}</span></button>`).join('')}</div></div>
  <div class="filters">
    <input type="search" id="q" placeholder="Search: e.g. shopify london" aria-label="Search leads" value="${esc(f.q)}">
    <select id="type"><option value="">Inbound + outbound</option><option value="inbound" ${f.type === 'inbound' ? 'selected' : ''}>Inbound requests</option><option value="outbound" ${f.type === 'outbound' ? 'selected' : ''}>Outbound businesses</option></select>
    <select id="source"><option value="">All sources</option>${sources.map((x) => `<option ${f.source === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
    <select id="region"><option value="">All regions</option>${regions.map((x) => `<option ${f.region === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select>
    <select id="minScore">${[0, 50, 60, 70, 80].map((n) => `<option value="${n}" ${f.minScore === n ? 'selected' : ''}>${n ? `Score ${n}+` : 'Any score'}</option>`).join('')}</select>
    <select id="sort">${[['score', 'Best first'], ['recent', 'Newest first'], ['budget', 'Biggest budget']].map(([k, v]) => `<option value="${k}" ${f.sort === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
  </div>
  ${list.length ? `<div class="bulk" role="toolbar" aria-label="Bulk actions">
    <span class="m">${sel.length ? `${sel.length} selected` : 'Tick leads to act on several at once'}</span>
    ${sel.length ? '<button class="btn bad" data-bulk="dismissed">Not a fit</button><button class="btn" data-bulk="clear">Clear selection</button>' : ''}
    <button class="btn" data-bulk="export">Export ${sel.length ? `${sel.length} selected` : `all ${list.length}`} to CSV</button></div>
  <table><thead><tr><th class="sel"><input type="checkbox" id="sel-all" aria-label="Select all shown" ${shown.every((l) => state.selected.has(l.id)) ? 'checked' : ''}></th><th>Score</th><th>Lead</th><th class="hide-sm">Type</th><th class="hide-sm">When</th><th>Status</th></tr></thead><tbody>
    ${shown.map((l) => `<tr data-lead="${esc(l.id)}" tabindex="0">
      <td class="sel"><input type="checkbox" data-sel="${esc(l.id)}" aria-label="Select ${esc(l.title)}" ${state.selected.has(l.id) ? 'checked' : ''}></td>
      <td>${scoreBadge(l.score)}</td>
      <td><div class="t">${esc(l.title)}${l.sourceClosed ? ` <span class="pill lost">${esc(closedLabel(l))}</span>` : ''}</div><div class="m">${esc(l.source)}${l.sourceDetail ? ` · ${esc(l.sourceDetail)}` : ''}${l.budget?.max ? ` · ${usd(l.budget.min)}–${usd(l.budget.max)}` : ''}${l.status === 'skipped' && l.skipReason ? ` · ${esc(l.skipReason)}` : ''}${l.type === 'outbound' ? ` · ${l.hasWebsite ? `${l.issues} website issue${l.issues === 1 ? '' : 's'}` : l.noSiteConfirmed ? 'no website (checked)' : l.issues == null ? 'website not checked yet' : 'no website listed (unverified)'}${l.reach.email ? ' · email' : ''}${l.reach.phone ? ' · phone' : ''}` : ''}</div></td>
      <td class="hide-sm">${typePill(l.type)}</td><td class="hide-sm m">${ago(l.postedAt || l.foundAt)}</td><td>${pill(l.status)}</td></tr>`).join('')}
  </tbody></table>${list.length > shown.length ? `<p class="m">Showing ${shown.length} of ${list.length}. <button class="btn mini" data-more>Show ${Math.min(PAGE, list.length - shown.length)} more</button></p>` : `<p class="m">${list.length} lead${list.length === 1 ? '' : 's'}</p>`}`
  : '<div class="panel empty">Nothing matches these filters.</div>'}`;
}

function pipeline() {
  const cols = [['qualified', 'To contact'], ['contacted', 'Contacted'], ['replied', 'Replied'], ['proposal', 'Proposal sent'], ['won', 'Won']];
  const lost = state.leads.filter((l) => l.status === 'lost').length;
  return `
  <h1>Pipeline</h1><p class="sub">Move leads along as conversations progress. Add a deal value to track your pipeline. ${lost ? `${lost} lost.` : ''}</p>
  <div class="board">${cols.map(([s, label]) => {
    const list = state.leads.filter((l) => l.status === s).sort((a, b) => (b.score || 0) - (a.score || 0));
    const total = list.reduce((t, l) => t + (Number(l.value) || 0), 0);
    return `<div class="col"><h2><span>${label}</span><span class="m">${list.length}${total ? ` · ${usd(total)}` : ''}</span></h2>
      ${list.slice(0, 60).map((l) => `<div class="kcard" data-lead="${esc(l.id)}" tabindex="0"><div class="t">${esc(l.title)}</div><div class="m">${esc(l.source)}${l.value ? ` · ${usd(l.value)}` : ''}</div>
        <div class="row"><span class="m">${l.contactedAt ? `contacted ${ago(l.contactedAt)}` : ago(l.postedAt || l.foundAt)}</span>${typePill(l.type)}</div></div>`).join('') || '<div class="m" style="padding:6px">None yet</div>'}
      ${list.length > 60 ? `<div class="m" style="padding:6px">+${list.length - 60} more in Leads</div>` : ''}</div>`;
  }).join('')}</div>`;
}

async function offerView() {
  const o = await api('offer');
  const field = (k, label, hint = '') => `<div class="field"><label for="o-${k}">${label}</label><input type="text" id="o-${k}" value="${esc(o[k] || '')}">${hint ? `<small>${hint}</small>` : ''}</div>`;
  return `
  <h1>My offer</h1><p class="sub">Everything the AI may say about you in pitches and proposals. It never claims anything that isn't here.</p>
  <div class="panel list-edit">
    ${field('name', 'Name')}${field('email', 'Email')}${field('website', 'Portfolio website')}${field('location', 'Location')}
    ${field('headline', 'One-line pitch')}${field('rates', 'Rates', 'e.g. "Business websites from $400; hourly $25". Leave blank and the AI won\'t mention prices.')}
    ${field('availability', 'Availability')}
    <div class="field"><label for="o-services">Services</label><textarea id="o-services">${esc((o.services || []).join('\n'))}</textarea><small>One per line.</small></div>
    <div class="field"><label for="o-proof">Proof points</label><textarea id="o-proof">${esc((o.proof || []).join('\n'))}</textarea><small>Real results only, one per line. Pitches pick the most relevant one.</small></div>
    <div class="field"><label for="o-signature">Signature</label><textarea id="o-signature" rows="2">${esc(o.signature || '')}</textarea></div>
    <div class="actions"><button class="btn primary" id="offer-save">Save offer</button></div>
  </div>`;
}

async function settings() {
  const p = await api('pipeline');
  const names = { freelancer: 'Freelancer.com projects', hn: 'Hacker News freelancer thread', osm: 'Local businesses (OpenStreetMap + website check)' };
  return `
  <h1>Settings</h1><p class="sub">Sources, scoring and the automatic search. Scoring and drafting use your OpenAI-compatible AI endpoint (models tried in order: ${p.models.map(esc).join(' → ') || 'none set'}).</p>
  <div class="grid two">
    <div class="panel">
      <h2>Automatic search</h2>
      <div class="field"><span>Check every hour</span><label class="switch"><input type="checkbox" id="enabled" ${p.enabled ? 'checked' : ''}><span></span></label><small>${p.enabled ? 'On.' : 'Off: nothing runs.'}</small></div>
      <h3>Sources</h3>
      ${Object.entries(names).map(([k, label]) => `<div class="field"><span>${label}</span><label class="switch"><input type="checkbox" data-source="${k}" aria-label="${esc(label)}" ${p.sources[k] ? 'checked' : ''}><span></span></label>${p.sources[k] ? `<small data-health="${k}">${healthLine(p.health[k])}</small>` : ''}</div>`).join('')}
      <h3>Scoring</h3>
      <div class="field"><label for="set-minScore">Qualify at score</label><input type="number" id="set-minScore" min="0" max="100" value="${p.minScore}"><small>Leads at or above this get a drafted message and land in Qualified.</small></div>
      <div class="field"><label for="set-aiPerRun">AI checks per run</label><input type="number" id="set-aiPerRun" min="1" max="40" value="${p.aiPerRun}"><small>Free tiers have rate limits; 8 is a safe default.</small></div>
      <div class="actions"><button class="btn primary" id="save-set">Save settings</button><button class="btn" id="run-now" ${p.busy ? 'disabled' : ''}>Run one check now</button></div>
    </div>
    <div class="panel"><h2>Activity log ${p.busy ? '<span class="pill contacted">Running</span>' : ''}</h2><div class="log">${p.log.map((l) => {
      const m = l.match(/^\[([^\]]+)\]\s*(.*)$/); return m ? `<b>${esc(localTime(m[1]))}</b>  ${esc(m[2])}` : esc(l);
    }).join('\n') || 'No activity yet.'}</div></div>
  </div>`;
}

// ---------- lead drawer ----------
const QUICK = {
  inbound: [['Summarize', 'Summarize what this client wants in 4 bullets, plus anything unclear I should ask.'], ['Write proposal', 'Write a proposal for this job (120-180 words) using only my real offer and proof.'], ['Scope & price', 'Break this into a scope with milestones and suggest a fair price range and timeline.'], ['Questions to ask', 'What 5 questions should I ask this client before quoting?'], ['Red flags?', 'Is this a legitimate client? List any red flags.']],
  outbound: [['Rewrite pitch', 'Rewrite the pitch email to be shorter and more personal (under 110 words).'], ['Explain findings', 'Explain each website finding in plain words: what a visitor experiences and how sure we are.'], ['What to offer', 'Based on the website audit, what exact package should I offer them and at what rough price?'], ['Worth it?', 'Is this lead worth contacting at all? Weigh the evidence and say what I should verify by hand first.']],
};
const md = (s) => esc(s).replace(/^#{1,3} (.*)$/gm, '<b>$1</b>').replace(/^\s*[-*]\s+(.*)$/gm, '• $1').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
const chatMsg = (m, i) => m.role === 'user' ? `<div class="msg me">${esc(m.text)}</div>`
  : `<div class="msg ai"><div class="body">${md(m.text)}</div><div class="msg-foot"><span>${esc(m.model || '')}</span><button class="btn mini" data-act="copy-msg" data-i="${i}">Copy</button><button class="btn mini" data-act="use-pitch" data-i="${i}">Use as message</button></div></div>`;

// "No website" from OpenStreetMap is a hint until you check: say so, and let you settle it.
const noSiteBlock = (a) => a.confirmedNoSite ? '<p class="m">No website: you checked.</p>'
  : `<p class="note" id="nosite-note"><b>Unverified.</b> OpenStreetMap lists no website and none turned up at the likely web addresses, but many businesses have one the map doesn't know about. Search Google Maps before pitching a new site.</p>
    <div class="actions" style="margin:8px 0"><button class="btn" data-act="confirm-nosite">I checked: no website</button>
      <form class="ask" id="site-form" style="margin:0;flex:1;min-width:240px"><input type="text" id="site-url" placeholder="They have one: paste the address" aria-label="Their website address"><button class="btn" type="submit">Check this site</button></form></div>`;

async function openLead(id) {
  const d = $('#drawer');
  d.innerHTML = '<p class="sub">Loading…</p>';
  if (!d.classList.contains('open')) closeLead.returnTo = document.activeElement?.closest('[data-lead]')?.dataset.lead;
  d.classList.add('open'); d.setAttribute('aria-hidden', 'false'); d.inert = false; $('#scrim').hidden = false;
  let l;
  try { l = await api('leads/' + enc(id)); }
  catch (err) {
    d.innerHTML = `<div class="head"><div class="grow"><h1>Lead not found</h1><p class="sub">${esc(err.message === 'unknown lead' ? 'This lead no longer exists. The link may be old.' : err.message)}</p></div><button class="close" aria-label="Close">×</button></div>`;
    d.onclick = (e) => { if (e.target.closest('.close')) closeLead(); };
    return $('.close', d).focus();
  }
  state.chat = l.chat;
  const a = l.audit, c = l.contact || {}, out = l.type === 'outbound';
  const next = { qualified: [['contacted', 'I contacted them', 'good']], contacted: [['replied', 'They replied', 'good']], replied: [['proposal', 'Sent proposal', 'good']], proposal: [['won', 'Won it', 'good'], ['lost', 'Lost', 'bad']] }[l.status] || [];
  const mailto = c.email && l.pitch ? `mailto:${c.email}?subject=${enc(l.pitchSubject || 'Quick idea for your website')}&body=${enc(l.pitch)}` : '';
  d.innerHTML = `
  <div class="head">${scoreBadge(l.score)}
    <div class="grow"><h1>${esc(l.title)}</h1>
      <div class="m">${esc(l.source)}${l.sourceDetail ? ` · ${esc(l.sourceDetail)}` : ''}${l.postedAt ? ` · posted ${ago(l.postedAt)}` : ` · found ${ago(l.foundAt)}`}</div>
      <div style="margin-top:6px">${typePill(l.type)} ${pill(l.status)} ${l.service ? `<span class="pill">${esc(l.service)}</span>` : ''} ${l.budget?.max ? `<span class="pill">${esc(l.budget.original)}</span>` : ''}</div></div>
    <button class="close" aria-label="Close">×</button></div>
  <div class="actions" style="margin:16px 0">
    ${l.url ? `<a class="btn" href="${esc(l.url)}" target="_blank" rel="noopener">${out ? 'Map listing ↗' : 'Open post ↗'}</a>` : ''}
    ${out && a?.hasWebsite ? `<a class="btn" href="${esc(a.finalUrl || a.url)}" target="_blank" rel="noopener">Their website ↗</a>` : ''}
    ${out && a?.hasWebsite && c.website && ['new', 'qualified', 'skipped'].includes(l.status) ? '<button class="btn" data-act="reaudit" title="Check their website again on the next run and redraft the pitch">Re-check website</button>' : ''}
    ${l.mapsUrl ? `<a class="btn" href="${esc(l.mapsUrl)}" target="_blank" rel="noopener">Google Maps ↗</a>` : ''}
    ${next.map(([s, label, cls]) => `<button class="btn ${cls}" data-act="${s}">${label}</button>`).join('')}
    ${['qualified', 'skipped', 'new'].includes(l.status) ? '<button class="btn bad" data-act="dismissed">Not a fit</button>' : ''}
    ${['skipped', 'dismissed', 'error', 'qualified'].includes(l.status) ? '<button class="btn" data-act="requalify">Re-check with AI</button>' : ''}
  </div>
  ${l.error ? `<p class="note">Last error: ${esc(l.error)}</p>` : ''}
  ${l.sourceClosed ? `<p class="note">${esc(closedLabel(l))}: this project was ${esc(l.sourceClosed)} (seen ${ago(l.sourceClosedAt)}). You can't bid on it any more.</p>` : ''}
  ${l.status === 'skipped' && l.skipReason ? `<p class="note">Skipped automatically, without AI: ${esc(l.skipReason)}. Use "Re-check with AI" if that's wrong.</p>` : ''}
  ${l.summaryText ? `<h3>Summary</h3><p>${esc(l.summaryText)}</p>` : ''}
  ${l.redFlags.length ? `<h3>Red flags</h3><ul>${l.redFlags.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : ''}
  ${out ? `<h3>Business</h3><dl class="kv"><dt>Name</dt><dd>${esc(l.business?.name)}</dd><dt>Type</dt><dd>${esc(l.business?.category)}</dd><dt>Where</dt><dd>${esc(l.business?.address || '')}${l.country ? `, ${esc(l.country)}` : ''}</dd>
      <dt>Email</dt><dd>${c.email ? `<a href="mailto:${esc(c.email)}">${esc(c.email)}</a>` : '<span class="m">not found</span>'}</dd><dt>Phone</dt><dd>${c.phone ? esc(c.phone) : '<span class="m">not found</span>'}</dd></dl>
    <h3>Website check</h3>${a ? (a.hasWebsite ? `<p class="m">${esc(a.finalUrl || a.url)}${a.platform ? ` · ${esc(a.platform)}` : ''}${a.ms ? ` · loaded in ${(a.ms / 1000).toFixed(1)}s` : ''}${a.foundBy ? ` · not on the map listing; found at a likely address and matched by ${esc(a.foundBy === 'phone' ? 'phone number' : 'street address')}` : ''}</p>` : noSiteBlock(a))
      + (a.note ? `<p class="note">${esc(a.note)}</p>` : '')
      + (a.issues?.length ? `<ul class="issues">${a.issues.map((i) => `<li><b>✗</b><span>${esc(i.text)}</span></li>`).join('')}</ul>` : a.note ? '' : '<p class="m">No obvious problems found.</p>') : '<p class="m">Not checked yet.</p>'}`
  : `${l.body ? `<h3>The post</h3><div class="desc">${esc(l.body)}</div>` : ''}<dl class="kv" style="margin-top:10px">${c.handle ? `<dt>Posted by</dt><dd>${esc(c.handle)}</dd>` : ''}${l.skills.length ? `<dt>Skills</dt><dd>${esc(l.skills.join(', '))}</dd>` : ''}${l.bids != null ? `<dt>Bids so far</dt><dd>${l.bids}</dd>` : ''}${l.budgetNote ? `<dt>Budget</dt><dd>${esc(l.budgetNote)}</dd>` : ''}</dl>`}
  <h3>${out ? 'Pitch email' : 'Reply / proposal'}</h3>
  ${out && l.pitchSubject ? `<p class="m">Subject: <b>${esc(l.pitchSubject)}</b></p>` : ''}
  <textarea id="pitch" rows="9" placeholder="${l.status === 'new' ? 'Drafted after the AI check.' : 'Write your message here.'}">${esc(l.pitch)}</textarea>
  <div class="actions" style="margin-top:8px"><button class="btn" data-act="save-pitch">Save</button><button class="btn" data-act="copy-pitch">Copy</button>
    ${mailto ? `<a class="btn primary" href="${esc(mailto)}">Open in email</a>` : ''}</div>
  <p class="m">Nothing is sent automatically. Review it, send it yourself, then click "I contacted them".</p>
  <section class="aibar"><div class="aibar-head"><h3>Ask AI about this lead</h3><span class="m">Uses your AI endpoint</span><button class="btn mini" data-act="clear-chat" ${l.chat.length ? '' : 'hidden'}>Clear</button></div>
    <div class="chips">${QUICK[l.type].map(([label], i) => `<button class="chip" data-act="quick" data-i="${i}">${label}</button>`).join('')}</div>
    <div class="chat" id="chat">${l.chat.map(chatMsg).join('')}</div>
    <form class="ask" id="ask-form"><input type="text" id="ask-q" placeholder="Ask anything about this lead" autocomplete="off"><button class="btn primary" type="submit">Ask</button></form></section>
  <h3>Deal</h3><div class="field"><label for="value">Deal value (USD)</label><input type="number" id="value" min="0" value="${l.value ?? ''}"></div>
  <textarea id="notes" rows="3" placeholder="Notes: who you spoke to, what they said, next step…">${esc(l.notes)}</textarea>
  <div class="actions" style="margin-top:8px"><button class="btn" data-act="save-deal">Save deal &amp; notes</button></div>`;
  $('.close', d).focus();

  const askAI = async (q) => {
    const chat = $('#chat'), btn = $('#ask-form button');
    chat.insertAdjacentHTML('beforeend', `<div class="msg me">${esc(q)}</div><div class="msg ai thinking">Thinking…</div>`);
    btn.disabled = true; $('#ask-q').value = '';
    try { const r = await api(`leads/${enc(id)}/chat`, { method: 'POST', body: { question: q } }); state.chat = r.chat; chat.innerHTML = r.chat.map(chatMsg).join(''); $('[data-act=clear-chat]').hidden = false; }
    catch (err) { chat.querySelector('.thinking')?.remove(); chat.insertAdjacentHTML('beforeend', `<div class="msg ai err">${esc(err.message)}</div>`); }
    finally { btn.disabled = false; chat.lastElementChild?.scrollIntoView({ block: 'nearest' }); }
  };
  $('#ask-form').onsubmit = (e) => { e.preventDefault(); const q = $('#ask-q').value.trim(); if (q) askAI(q); };
  const siteForm = $('#site-form');
  if (siteForm) siteForm.onsubmit = async (e) => {
    e.preventDefault();
    const website = $('#site-url').value.trim(); if (!website) return $('#site-url').focus();
    try { await api('leads/' + enc(id), { method: 'POST', body: { website } }); toast('Saved. The next run checks their site and redrafts the pitch.'); await refresh(); openLead(id); }
    catch (err) { toast(err.message); }
  };
  d.onclick = async (e) => {
    if (e.target.closest('.close')) return closeLead();
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    const i = Number(e.target.dataset.i);
    try {
      if (act === 'quick') return askAI(QUICK[l.type][i][1]);
      if (act === 'copy-msg') { await navigator.clipboard.writeText(state.chat[i].text); return toast('Copied.'); }
      if (act === 'use-pitch') { $('#pitch').value = state.chat[i].text; await api('leads/' + enc(id), { method: 'POST', body: { pitch: state.chat[i].text } }); return toast('Saved as your message.'); }
      if (act === 'clear-chat') { await api(`leads/${enc(id)}/chat`, { method: 'DELETE' }); state.chat = []; $('#chat').innerHTML = ''; e.target.hidden = true; return; }
      if (act === 'save-pitch') { await api('leads/' + enc(id), { method: 'POST', body: { pitch: $('#pitch').value } }); return toast('Message saved.'); }
      if (act === 'copy-pitch') { await navigator.clipboard.writeText($('#pitch').value); return toast('Copied.'); }
      if (act === 'save-deal') { await api('leads/' + enc(id), { method: 'POST', body: { value: $('#value').value, notes: $('#notes').value } }); await load(); return toast('Deal saved.'); }
      if (act === 'reaudit') { await api('leads/' + enc(id), { method: 'POST', body: { website: c.website } }); toast('The next run checks their website again and redrafts the pitch.'); await refresh(); return openLead(id); }
      if (act === 'confirm-nosite') { await api('leads/' + enc(id), { method: 'POST', body: { confirmNoSite: true } }); toast('Marked as confirmed: no website.'); await refresh(); return openLead(id); }
      if (act === 'requalify') { await api(`leads/${enc(id)}/requalify`, { method: 'POST' }); toast('Re-checking in the background, a minute or two.'); return; }
      await api('leads/' + enc(id), { method: 'POST', body: { status: act } });
      toast(`Marked as ${LABEL[act].toLowerCase()}.`);
      await refresh(); openLead(id);
    } catch (err) { toast(err.message); }
  };
}
function closeLead() {
  const d = $('#drawer');
  if (!d.classList.contains('open')) return;
  d.classList.remove('open'); d.setAttribute('aria-hidden', 'true'); d.inert = true; $('#scrim').hidden = true;
  const parts = location.hash.split('/');
  if (parts.length > 2) history.replaceState(null, '', '#/' + parts[1]);
  // Back to the row you opened it from, so keyboard users keep their place in the list.
  const id = closeLead.returnTo; closeLead.returnTo = null;
  if (id) $(`#view [data-lead="${CSS.escape(id)}"]`)?.focus();
}

// ---------- routing & events ----------
const VIEWS = { overview, leads, pipeline, offer: offerView, settings };
async function render() {
  const [, view = 'overview', ...rest] = location.hash.split('/');
  const name = VIEWS[view] ? view : 'overview';
  document.querySelectorAll('.nav nav a').forEach((a) => a.classList.toggle('on', a.dataset.view === name));
  $('#view').innerHTML = await VIEWS[name]();
  if (rest.length) openLead(decodeURIComponent(rest.join('/')));
}
async function refresh() { await load(); await render(); }
async function pipeState() {
  try {
    const p = await api('pipeline');
    $('#pipe-state').innerHTML = `<div><span class="dot ${p.busy ? 'busy' : p.enabled ? 'on' : ''}"></span>${p.busy ? 'Searching…' : p.enabled ? 'Lead Hunter is on' : 'Lead Hunter is off'}</div>
      <button class="btn power ${p.enabled ? 'on' : ''}" id="power" data-on="${p.enabled ? 1 : 0}">${p.enabled ? 'Switch off' : 'Switch on'}</button>
      <div class="m">${p.enabled ? 'Checks hourly' : 'Nothing runs'}</div>${p.lastRun && !p.busy ? `<div class="m" id="last-run">${lastRunText(p.lastRun)}</div>` : ''}`;
  } catch {}
}
$('#pipe-state').addEventListener('click', async (e) => {
  const b = e.target.closest('#power'); if (!b) return;
  const on = b.dataset.on !== '1'; b.disabled = true;
  try { await api('pipeline', { method: 'POST', body: { enabled: on } }); toast(on ? 'Lead Hunter is on. It checks every hour.' : 'Lead Hunter is off.'); } catch (err) { toast(err.message); }
  await pipeState(); if (location.hash.includes('settings')) render();
});
$('#view').addEventListener('keydown', (e) => { if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('[data-lead]')) { e.preventDefault(); e.target.click(); } });
$('#view').addEventListener('click', async (e) => {
  const go = e.target.closest('[data-go-status]');
  if (go) { state.filters.status = go.dataset.goStatus; saveFilters(); return; }
  if (e.target.matches('[data-sel], #sel-all')) {
    const ids = e.target.id === 'sel-all' ? filtered().slice(0, state.limit).map((l) => l.id) : [e.target.dataset.sel];
    for (const id of ids) e.target.checked ? state.selected.add(id) : state.selected.delete(id);
    const focusSel = e.target.id ? '#sel-all' : `[data-sel="${CSS.escape(e.target.dataset.sel)}"]`;
    await render(); return $(focusSel)?.focus();
  }
  if (e.target.closest('td.sel, th.sel')) return; // a near-miss on the checkbox shouldn't open the lead
  if (e.target.matches('[data-more]')) { state.limit += PAGE; return render(); }
  const bulk = e.target.closest('[data-bulk]')?.dataset.bulk;
  if (bulk === 'clear') { state.selected.clear(); return render(); }
  if (bulk === 'export') return exportCsv(state.selected.size ? [...state.selected] : filtered().map((l) => l.id));
  if (bulk === 'dismissed') {
    try {
      const { updated, previous } = await api('bulk', { method: 'POST', body: { ids: [...state.selected], status: 'dismissed' } });
      state.selected.clear(); await refresh();
      return toast(`${updated} lead${updated === 1 ? '' : 's'} marked not a fit.`, ['Undo', async () => { await api('bulk', { method: 'POST', body: { restore: previous } }); await refresh(); toast('Restored.'); }]);
    } catch (err) { return toast(err.message); }
  }
  const lead = e.target.closest('[data-lead]');
  if (lead) { history.replaceState(null, '', `#/${location.hash.split('/')[1] || 'overview'}/${enc(lead.dataset.lead)}`); return openLead(lead.dataset.lead); }
  const chip = e.target.closest('[data-status]');
  if (chip) { state.filters.status = chip.dataset.status; state.limit = PAGE; saveFilters(); return render(); }
  if (e.target.id === 'offer-save') {
    const v = (k) => $(`#o-${k}`).value;
    await api('offer', { method: 'POST', body: { name: v('name'), email: v('email'), website: v('website'), location: v('location'), headline: v('headline'), rates: v('rates'), availability: v('availability'), signature: v('signature'),
      services: v('services').split('\n'), proof: v('proof').split('\n') } });
    return toast('Offer saved. New pitches will use it.');
  }
  if (e.target.id === 'save-set') {
    const minScore = Number($('#set-minScore').value), aiPerRun = Number($('#set-aiPerRun').value);
    if (!(minScore >= 0 && minScore <= 100) || !(aiPerRun >= 1 && aiPerRun <= 40)) return toast('Score must be 0–100 and AI checks 1–40.');
    const sources = Object.fromEntries([...document.querySelectorAll('[data-source]')].map((x) => [x.dataset.source, x.checked]));
    await api('pipeline', { method: 'POST', body: { minScore, aiPerRun, sources } });
    toast('Settings saved.'); return render();
  }
  if (e.target.id === 'run-now') {
    try { await api('pipeline', { method: 'POST', body: { runNow: true } }); toast('Checking for new leads now.'); setTimeout(() => { render(); pipeState(); }, 1500); } catch (err) { toast(err.message); }
  }
});
$('#view').addEventListener('change', async (e) => {
  const f = state.filters;
  if (e.target.id === 'enabled') { await api('pipeline', { method: 'POST', body: { enabled: e.target.checked } }); pipeState(); return render(); }
  if (['type', 'source', 'region', 'sort'].includes(e.target.id)) f[e.target.id] = e.target.value;
  else if (e.target.id === 'minScore') f.minScore = Number(e.target.value);
  else return;
  state.limit = PAGE; saveFilters(); render();
});
$('#view').addEventListener('input', (e) => {
  if (e.target.id !== 'q') return;
  state.filters.q = e.target.value; state.limit = PAGE; saveFilters();
  clearTimeout(render.t); render.t = setTimeout(async () => { await render(); const q = $('#q'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); }, 200);
});
$('#scrim').addEventListener('click', closeLead);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return closeLead();
  const d = $('#drawer');
  if (e.key !== 'Tab' || !d.classList.contains('open')) return;
  // Keep Tab inside the open panel (it's modal).
  const f = [...d.querySelectorAll('a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])')].filter((x) => !x.disabled && !x.hidden && x.offsetParent);
  if (!f.length) return;
  if (!d.contains(document.activeElement)) { e.preventDefault(); return f[0].focus(); }
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f.at(-1).focus(); }
  else if (!e.shiftKey && document.activeElement === f.at(-1)) { e.preventDefault(); f[0].focus(); }
});
window.addEventListener('hashchange', render);

await refresh();
pipeState();
setInterval(async () => { if (document.hidden || $('#drawer').classList.contains('open')) return; await load(); if (!document.activeElement?.matches('input, textarea, select')) render(); pipeState(); }, 30000);
