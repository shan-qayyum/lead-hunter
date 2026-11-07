// AI qualification: inbound requests get a fit score + reply draft; outbound businesses
// get a pitch built only from their real audit findings and your offer.
import { askJson, offer as loadOffer, config } from './lib.mjs';

const offerBlock = (o) => JSON.stringify({ name: o.name, website: o.website, location: o.location, headline: o.headline, services: o.services, proof: o.proof, rates: o.rates || '(not set: do not mention prices)', availability: o.availability });

const RULES = `Hard rules: Use ONLY the freelancer's offer and proof below; never invent clients, numbers, tools or results. Plain, warm, specific English; no clichés ("I hope this finds you well", "I'm passionate", "synergy"). Don't quote prices unless rates are set. Sign off with the freelancer's name.`;

export async function qualifyInbound(lead) {
  const o = loadOffer();
  const { data, model } = await askJson(`You screen freelance leads for a web developer. Decide whether this post is a client who wants web/digital work this freelancer can do, and draft a reply.

FREELANCER OFFER: ${offerBlock(o)}

POST (${lead.source}, ${lead.sourceDetail || ''}):
Title: ${lead.title}
${lead.budget ? `Budget: ${lead.budget.original} (~$${lead.budget.min}-${lead.budget.max} USD, ${lead.budget.kind || ''})` : ''}
${lead.skills?.length ? `Skills: ${lead.skills.join(', ')}` : ''}
Body: ${(lead.body || '').slice(0, 5000)}

SCORING 0-100 = how worth pursuing: real client (not a freelancer advertising, not a commission-only sales job, not a scam), match to the services, clear scope, reasonable budget, recency. relevant=false for anything that isn't a client wanting web/digital/dev work.
${RULES}

Return ONLY JSON: {"relevant": boolean, "score": number, "service": "the service they need, 2-5 words", "summary": "1-2 sentences: what they want", "budgetNote": "short", "redFlags": ["..."], "reply": "proposal/reply message, 80-140 words, references their specifics, ends with one question"}`);
  return { ...data, engine: model };
}

export async function pitchOutbound(lead) {
  const o = loadOffer();
  const a = lead.audit;
  const findings = a.hasWebsite ? a.issues.map((i) => i.text)
    : a.unverified !== false && !a.confirmedNoSite ? ['We could not find a website for this business, but they may have one we missed: do not claim they have no website; ask whether they have one']
      : ['No website (the freelancer checked)'];
  const { data, model } = await askJson(`Write a short, respectful cold outreach message from a web developer to a local business, based ONLY on these verified findings.

FREELANCER OFFER: ${offerBlock(o)}

BUSINESS: ${lead.business.name} (${lead.business.category}) in ${lead.city}, ${lead.country}
Website: ${a.hasWebsite ? `${a.finalUrl || a.url}${a.platform ? ` (built with ${a.platform})` : ''}` : 'none found'}
VERIFIED FINDINGS: ${findings.join('; ')}

The email: 90-140 words, subject line under 8 words, mention 1-2 findings concretely and why they cost the business customers (in plain terms), one relevant proof point from the offer, a low-pressure call to action (e.g. a free 5-minute fix list), and end with a one-line opt-out ("If this isn't useful, just reply 'no' and I won't follow up.").
${RULES}

Return ONLY JSON: {"subject": "", "email": "", "angle": "one line: the main problem you're pitching"}`);
  return { ...data, engine: model };
}

// Outbound score: their need from the audit, nudged by how reachable they are and your region preference.
export function outboundScore(lead) {
  const prefs = config().regionBoost || { West: 5, Gulf: 5 };
  let s = lead.audit?.need ?? 0;
  if (lead.contact?.email || lead.audit?.emails?.length) s += 10;
  if (lead.contact?.phone) s += 5;
  s += prefs[lead.region] || 0;
  // Google Maps reviews say how established they are: a handful means tiny or inactive (unlikely to
  // pay for a website); many means busy, able to pay, and with a reputation worth protecting.
  const reviews = lead.listing?.found && !lead.listing.mismatch ? lead.listing.reviews : null;
  if (reviews != null && reviews < 5) s -= 20;
  else if (reviews >= 50) s += 5;
  return Math.max(0, Math.min(100, s));
}

// Rough pre-AI priority for an inbound post (0-100): fresher, better-paid, less-crowded posts first.
// Only orders the AI queue; the AI's score replaces it once the post is checked.
export function inboundPriority(lead, now = Date.now()) {
  const ageDays = (now - new Date(lead.postedAt || lead.foundAt || now)) / 864e5;
  let p = 50 - Math.min(30, Math.max(0, ageDays) * 6);
  const max = lead.budget?.max || 0;
  if (max >= 1000) p += 15; else if (max >= 500) p += 10; else if (max >= 250) p += 5;
  if (lead.bids > 100) p -= 15; else if (lead.bids > 40) p -= 8; else if (lead.bids != null && lead.bids <= 10) p += 5;
  return Math.round(Math.max(0, Math.min(100, p)));
}

// Posts that are clearly not a paying web job, decided without AI so they don't spend free quota.
// "Re-check with AI" sets forceAI, which bypasses this.
const WEB = /web|wordpress|woocommerce|shopify|wix|squarespace|webflow|html|css|php|javascript|typescript|react|next\.?js|vue|angular|node|laravel|django|seo\b|e-?commerce|landing page|front-?end|back-?end|full[ -]?stack|\bui\b|\bux\b|figma|\bapi\b|mysql|database|app development/i;
const UNPAID = /commission[- ]?(only|based)|commission\b.{0,30}\b(sales|closer|reps?)\b|comisi[oó]n|equity[- ]only|\bunpaid\b|no upfront pay/i;
export function inboundRuleSkip(lead) {
  if (lead.forceAI) return null;
  if (UNPAID.test(`${lead.title} ${(lead.body || '').slice(0, 3000)}`)) return 'Commission-only or unpaid work';
  if (lead.skills?.length && !lead.skills.some((s) => WEB.test(s)) && !WEB.test(lead.title)) return `Not web work (skills: ${lead.skills.slice(0, 4).join(', ')})`;
  return null;
}

// The same request reposted ("Title -- 2") or cross-posted with the same text.
const dupKeys = (l) => {
  const t = String(l.title || '').toLowerCase().replace(/\s*--\s*\d+\s*$/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return [...(t.length >= 8 ? [`t:${t}`] : []), ...((l.body || '').length >= 80 ? [`b:${l.body.slice(0, 200).toLowerCase().replace(/\s+/g, ' ')}`] : [])];
};

// What the next run qualifies. Low outbound, clearly-irrelevant inbound and duplicates are skipped
// by rule (no AI call), so they never use up AI slots. The AI slots alternate inbound and outbound,
// so neither kind can starve the other (outbound audit scores are on a different scale from
// inbound priorities).
export function buildQueue(leads, { aiPerRun = 8, minScore = 50, now = Date.now() } = {}) {
  const fresh = leads.filter((l) => l.status === 'new' && (l.type === 'inbound' || l.audit));
  // Leads already handled, then queued ones oldest first: the first copy seen is the original.
  const seen = new Map(), original = new Map();
  const byAge = (a, b) => String(a.foundAt).localeCompare(String(b.foundAt));
  for (const l of [...leads.filter((x) => x.status !== 'new' && x.type === 'inbound'), ...fresh.filter((x) => x.type === 'inbound').sort(byAge)]) {
    for (const k of dupKeys(l)) if (!seen.has(k)) seen.set(k, l); else if (!original.has(l)) original.set(l, seen.get(k));
  }
  const skipWhy = (l) => (l.type === 'outbound' ? ((l.score ?? 0) < minScore && !l.forceAI ? `Score ${l.score ?? 0} is under ${minScore}` : null)
    : original.has(l) && !l.forceAI ? `Duplicate of "${original.get(l).title.slice(0, 80)}"` : inboundRuleSkip(l));
  const why = new Map(fresh.map((l) => [l, skipWhy(l)]));
  const ruleSkip = fresh.filter((l) => why.get(l)).map((l) => Object.assign(l, { skipReason: why.get(l) }));
  const recent = (a, b) => String(b.postedAt || b.foundAt).localeCompare(String(a.postedAt || a.foundAt));
  const inbound = fresh.filter((l) => l.type === 'inbound' && !why.get(l)).sort((a, b) => inboundPriority(b, now) - inboundPriority(a, now) || recent(a, b));
  const outbound = fresh.filter((l) => l.type === 'outbound' && !why.get(l)).sort((a, b) => b.score - a.score || recent(a, b));
  const ai = [];
  while (ai.length < aiPerRun && (inbound.length || outbound.length)) {
    const pick = ai.length % 2 === 0 ? (inbound.length ? inbound : outbound) : (outbound.length ? outbound : inbound);
    ai.push(pick.shift());
  }
  return { ruleSkip, ai };
}

// Apply a Freelancer status check to a lead. Queued posts that closed are skipped (no AI spent on
// them); qualified ones you haven't contacted yet move to Lost. Contacted ones are only flagged.
export function applySourceStatus(lead, s, now = new Date().toISOString()) {
  if (s.bids != null) lead.bids = s.bids;
  if (s.open || lead.sourceClosed) return false;
  Object.assign(lead, { sourceClosed: s.why, sourceClosedAt: now });
  if (lead.status === 'new') Object.assign(lead, { status: 'skipped', skipReason: `Project ${s.why} on Freelancer.com before it was checked` });
  else if (lead.status === 'qualified') Object.assign(lead, { status: 'lost', closedAt: now, lostReason: `Project ${s.why} on Freelancer.com` });
  return true;
}
