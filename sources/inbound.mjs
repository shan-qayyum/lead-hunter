// Inbound sources: people actively asking for web/digital work.
// Every source returns normalized leads; failures are logged, collected on `out.errors` for the
// source-health panel, and skipped, never fatal.
import { get, decode, log, sleep } from '../lib.mjs';

const lead = (o) => ({ type: 'inbound', foundAt: new Date().toISOString(), status: 'new', ...o });
const results = () => Object.assign([], { errors: [], attempts: 0 });

// Freelancer.com public API (no auth for active projects).
export async function freelancer(cfg) {
  const out = results();
  for (const q of cfg.queries) {
    out.attempts++;
    try {
      const url = `https://www.freelancer.com/api/projects/0.1/projects/active/?query=${encodeURIComponent(q)}&limit=30&full_description=true&job_details=true&sort_field=time_updated`;
      const d = await (await get(url, { headers: { Accept: 'application/json' } })).json();
      for (const p of d.result?.projects || []) {
        const rate = p.currency?.exchange_rate || 1;
        const usd = { min: Math.round((p.budget?.minimum || 0) * rate), max: Math.round((p.budget?.maximum || p.budget?.minimum || 0) * rate) };
        if (usd.max && usd.max < cfg.minBudgetUSD) continue;
        out.push(lead({
          id: `freelancer:${p.id}`, source: 'Freelancer.com', sourceDetail: `search "${q}"`,
          title: p.title, body: (p.description || p.preview_description || '').slice(0, 6000),
          url: `https://www.freelancer.com/projects/${p.seo_url || p.id}`,
          postedAt: p.time_submitted ? new Date(p.time_submitted * 1000).toISOString() : undefined,
          budget: { ...usd, currency: 'USD', original: `${p.budget?.minimum ?? '?'}–${p.budget?.maximum ?? '?'} ${p.currency?.code || ''}`, kind: p.type },
          skills: (p.jobs || []).map((j) => j.name), bids: p.bid_stats?.bid_count,
          region: p.location?.country?.name || 'Anywhere', contact: { handle: 'Bid on Freelancer.com' },
        }));
      }
    } catch (e) { log('source freelancer', q, 'failed:', e.message); out.errors.push(`"${q}": ${e.message}`); }
    await sleep(1200);
  }
  return out;
}

// Hacker News monthly "Freelancer? Seeking freelancer?" thread: only SEEKING FREELANCER comments.
export async function hn() {
  const out = results();
  out.attempts++;
  try {
    const s = await (await get('https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&query=%22Seeking%20freelancer%22&hitsPerPage=5')).json();
    const thread = s.hits.find((h) => /freelancer\? seeking freelancer/i.test(h.title));
    if (!thread) return out;
    const t = await (await get(`https://hn.algolia.com/api/v1/items/${thread.objectID}`)).json();
    for (const c of t.children || []) {
      const text = decode(c.text || '');
      if (!/^\s*seeking freelancer/i.test(text)) continue;
      out.push(lead({
        id: `hn:${c.id}`, source: 'Hacker News', sourceDetail: thread.title, title: text.split('\n')[0].slice(0, 140),
        body: text.slice(0, 6000), url: `https://news.ycombinator.com/item?id=${c.id}`,
        postedAt: c.created_at, contact: { handle: c.author }, region: 'Unknown',
      }));
    }
  } catch (e) { log('source hn failed:', e.message); out.errors.push(e.message); }
  return out;
}

// Freelancer projects close or get awarded within days. Returns id -> { open, why, bids } for
// the given lead ids (100 per request), so the run can retire posts nobody can bid on any more.
export async function freelancerStatus(ids) {
  const out = new Map();
  for (let i = 0; i < ids.length; i += 100) {
    const batch = ids.slice(i, i + 100);
    try {
      const url = `https://www.freelancer.com/api/projects/0.1/projects/?${batch.map((id) => `projects[]=${encodeURIComponent(id.split(':')[1])}`).join('&')}`;
      const d = await (await get(url, { headers: { Accept: 'application/json' } })).json();
      for (const p of d.result?.projects || []) {
        const open = p.status === 'active' && p.frontend_project_status === 'open';
        const why = open ? null : /award/.test(p.sub_status || '') ? 'awarded to someone' : p.status === 'frozen' ? 'frozen' : 'closed';
        out.set(`freelancer:${p.id}`, { open, why, bids: p.bid_stats?.bid_count });
      }
    } catch (e) { log('source freelancer status check failed:', e.message); }
    await sleep(1200);
  }
  return out;
}
