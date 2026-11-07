// Deterministic website check for outbound leads: no AI, no cost. Each finding is a concrete,
// verifiable problem the pitch can mention, plus a "need" score for how much they need help.
import { UA } from './lib.mjs';
const YEAR = new Date().getFullYear();

// Only claim a problem we're sure a real visitor would see. A fetch from here can fail for reasons
// that have nothing to do with the site (bot protection, geo-blocking, a network blip). A site that
// blocks automated checks is respected, not worked around: it is recorded as "couldn't verify",
// never as "broken", and the human opens it in their own browser.
const BLOCKED = [401, 403, 406, 429, 503];
const isError = (s) => s === 404 || s === 410 || s >= 500;
export const RETRY_MS = Number(process.env.LH_AUDIT_RETRY_MS ?? 3000);

async function load(url) {
  const started = Date.now();
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(20000) });
  return { status: r.status, finalUrl: r.url, html: (await r.text()).slice(0, 2_000_000), ms: Date.now() - started };
}

// OpenStreetMap often lacks a business's website, so "no website listed" is only a hint. Try the
// obvious web addresses for the name and accept one only if the page shows this business's phone
// number or street (a matching name alone is often a different business with the same name).
const TLDS = { UK: ['.co.uk', '.com', '.uk'], UAE: ['.ae', '.com'], Pakistan: ['.pk', '.com.pk', '.com'], 'Saudi Arabia': ['.sa', '.com.sa', '.com'],
  Qatar: ['.qa', '.com'], Kuwait: ['.com.kw', '.com'], Canada: ['.ca', '.com'], Australia: ['.com.au', '.com'] };
const GENERIC = new Set(['the', 'and', 'ltd', 'limited', 'llc', 'co', 'inc']);
export function domainGuesses(name, country) {
  const words = String(name).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/&/g, ' and ')
    .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const core = words.filter((w) => !GENERIC.has(w));
  const slugs = [...new Set([core.join(''), core.join('-'), words.join('')])].filter((x) => x.length >= 4);
  return slugs.flatMap((sl) => (TLDS[country] || ['.com']).map((t) => sl + t));
}
const digits = (s) => String(s || '').replace(/\D/g, '');
export function pageMatches(html, { phone, street }) {
  const text = html.replace(/<[^>]+>/g, ' ');
  const tail = digits(phone).slice(-8);
  if (tail.length === 8 && digits(text).includes(tail)) return 'phone';
  if (street && street.length >= 8 && text.toLowerCase().replace(/\s+/g, ' ').includes(street.toLowerCase())) return 'address';
  return null;
}
export async function findSite({ name, country, phone, street }) {
  const dns = await import('node:dns/promises');
  for (const host of domainGuesses(name, country).slice(0, 9)) {
    try { await dns.lookup(host); } catch { continue; }
    for (const url of [`https://${host}/`, `http://${host}/`]) {
      try {
        const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html' }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
        const by = r.ok && pageMatches((await r.text()).slice(0, 1_000_000), { phone, street });
        if (by) return { url: r.url, by };
        break;
      } catch {}
    }
  }
  return null;
}

// No listed website: say exactly how sure we are. The pitch must not claim "you have no website"
// unless you confirmed it (see confirmNoSite in the app).
export const NO_SITE = { hasWebsite: false, unverified: true, need: 60,
  issues: [{ key: 'none', text: 'No website on its map listing, and none found at the likely web addresses', weight: 60 }] };

export async function auditSite(rawUrl, lookup, opts = {}) {
  if (!rawUrl) {
    const found = lookup?.name ? await findSite(lookup).catch(() => null) : null;
    if (!found) return { ...NO_SITE, checkedAt: new Date().toISOString() };
    return { ...(await auditSite(found.url)), foundBy: found.by };
  }
  const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : `http://${rawUrl}`;
  const unverifiable = (why) => ({ hasWebsite: true, url, unverifiable: true, need: 0, issues: [], note: `Couldn't check the website automatically (${why}). Open it yourself before pitching.` });

  // Listed page is on a big group's site (e.g. bupa.co.uk/dental/...): they don't control it.
  try {
    const u = new URL(url);
    if (u.pathname.split('/').filter(Boolean).length >= 2) return { hasWebsite: true, url, chain: true, need: 0, issues: [], note: 'Listed website is a page on a larger group\'s site, so this branch likely can\'t buy its own. Low priority.' };
  } catch {}

  let status, html = '', finalUrl, ms, confirmed = false;
  try {
    ({ status, html, finalUrl, ms } = await load(url));
  } catch (e) {
    // ENOTFOUND = the domain doesn't exist. EAI_AGAIN is only a temporary DNS hiccup: not proof.
    if (String(e.cause?.code || e.cause?.message || e.message).includes('ENOTFOUND')) {
      return { hasWebsite: true, url, broken: true, need: 90, issues: [{ key: 'broken', text: 'Website address no longer works (the domain does not resolve)', weight: 90 }] };
    }
    return unverifiable('it did not load for our checker');
  }
  if (BLOCKED.includes(status) || /cf-chl|challenge-platform|captcha|access denied/i.test(html.slice(0, 20000))) return unverifiable('the site blocks automated checks');
  if (isError(status)) {
    // The map listing often links to an inner page that has since moved: judge the site by its
    // homepage and mention the dead link as a small finding, never as "your site is broken".
    const u = new URL(url);
    if (u.pathname !== '/' && !opts.root) {
      const home = await auditSite(`${u.origin}/`, undefined, { root: true });
      if (home.broken || home.unverifiable) return home;
      const issues = [...home.issues, { key: 'dead-link', text: `The link on their map listing (${url}) leads to a missing page (HTTP ${status}); their homepage works`, weight: 15 }];
      return { ...home, listedUrl: url, issues, need: Math.min(100, issues.reduce((s, i) => s + i.weight, 0)) };
    }
    // A homepage error is only claimed if it is still there a few seconds later (not a blip).
    await new Promise((r) => setTimeout(r, RETRY_MS));
    try { ({ status, html, finalUrl, ms } = await load(url)); confirmed = true; } catch { return unverifiable('it returned an error and then did not load at all'); }
    if (BLOCKED.includes(status)) return unverifiable('the site blocks automated checks');
  }
  const issues = [];
  const add = (key, text, weight) => issues.push({ key, text, weight });

  if (isError(status)) add('broken', `Homepage returns an error (HTTP ${status}), ${confirmed ? 'again on a second check' : 'on our check'}`, 90);
  // Parked pages often redirect to the marketplace itself (e.g. forsale.godaddy.com, dan.com).
  if (/domain (is )?for sale|buy this domain|parked free|sedoparking|this domain may be for sale/i.test(html) || /<title>[^<]*\bis for sale\b/i.test(html)
    || /^https?:\/\/([^/]*\.)?(forsale\.godaddy\.com|dan\.com|sedo\.com|afternic\.com|hugedomains\.com)/i.test(finalUrl || '')) add('parked', 'Domain is parked / for sale; no real site', 85);
  if (/^http:/i.test(finalUrl)) add('no-https', 'Not secure: no HTTPS, so browsers show a "Not secure" warning', 25);
  if (!/<meta[^>]+name=["']viewport/i.test(html)) add('not-mobile', 'Not mobile-friendly (no responsive viewport)', 30);
  // Load time is measured from wherever this runs, which may be far from the business's customers:
  // only flag clear cases.
  if (ms > 9000) add('very-slow', `Very slow: homepage took ${(ms / 1000).toFixed(1)}s to load in our test`, 20);
  const years = [...html.matchAll(/(?:©|&copy;|copyright)\s*(?:\d{4}\s*[-–]\s*)?((?:19|20)\d{2})/gi)].map((m) => Number(m[1]));
  if (years.length && Math.max(...years) <= YEAR - 2) add('outdated', `Looks unmaintained: copyright says ${Math.max(...years)}`, 15);
  if (!/<title>\s*[^<\s][^<]*<\/title>/i.test(html)) add('no-title', 'Missing page title (hurts Google results)', 10);
  if (!/<meta[^>]+name=["']description["'][^>]+content=["'][^"']{20,}/i.test(html)) add('no-description', 'Missing search description (hurts Google results)', 5);

  const platform = /wix\.com|wixstatic/i.test(html) ? 'Wix' : /squarespace/i.test(html) ? 'Squarespace' : /wp-content|wordpress/i.test(html) ? 'WordPress'
    : /cdn\.shopify|shopify/i.test(html) ? 'Shopify' : /weebly/i.test(html) ? 'Weebly' : /godaddy/i.test(html) ? 'GoDaddy builder' : null;
  const emails = [...new Set([...html.matchAll(/mailto:([^"'?\s>]+)/gi)].map((m) => decodeURIComponent(m[1]).toLowerCase())
    .concat((html.match(/[\w.+-]+@[\w-]+\.[\w.-]{2,}/g) || []).map((e) => e.toLowerCase()))
    .filter((e) => !/\.(png|jpe?g|gif|webp|svg)$|example\.|sentry|wixpress|domain\.com|@2x/.test(e)))].slice(0, 3);

  const need = Math.min(100, issues.reduce((s, i) => s + i.weight, 0));
  return { hasWebsite: true, url, finalUrl, status, ms, https: /^https:/i.test(finalUrl), platform, emails, need, issues, checkedAt: new Date().toISOString() };
}
