// Listing check for outbound leads, run before the website audit. OpenStreetMap is often years
// out of date: it lists previous owners' websites, businesses that have closed or been bought by a
// chain, and misses websites that exist. The business's public map listing is what customers
// actually see, so it decides which website gets audited and whether the business looks active.
// Everything here except the provider at the bottom is pure and unit-tested.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './lib.mjs';

// Words many unrelated businesses share: they never prove two names are the same business.
const GENERIC = new Set(['the', 'and', 'ltd', 'limited', 'llc', 'inc', 'co', 'company', 'group', 'new', 'london', 'manchester', 'york', 'brooklyn',
  'clinic', 'centre', 'center', 'practice', 'surgery', 'dental', 'dentist', 'dentistry', 'care', 'health', 'medical', 'vets', 'vet', 'veterinary',
  'cafe', 'coffee', 'kitchen', 'restaurant', 'bar', 'grill', 'food', 'salon', 'hair', 'beauty', 'nails', 'barber', 'barbers', 'rooms', 'studio', 'studios',
  'shop', 'store', 'services', 'law', 'solicitors', 'legal', 'accountants', 'associates', 'partners', 'garage', 'motors', 'autos', 'florist', 'flowers', 'hotel']);
const words = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/&/g, ' and ')
  .replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
const digits = (s) => String(s || '').replace(/\D/g, '');

// Same business? A matching phone number settles it; otherwise the names must share a
// distinctive word ("Park Vets" vs "Parkvets" counts, "Smile Dental" vs "Bright Dental" doesn't).
export function sameBusiness(lead, place) {
  const a = digits(lead.phone).slice(-8), b = digits(place.phone).slice(-8);
  if (a.length === 8 && a === b) return true;
  const all = words(lead.name).filter((w) => !GENERIC.has(w));
  const mine = all.filter((w) => w.length >= 3);
  const theirs = words(place.name);
  const joined = theirs.join('');
  // Short words only count joined up: "NU:YU" -> "nuyu", found inside "nuyubodyaesthetics".
  const runs = all.join(' ').split(/\b\w{3,}\b/).map((r) => r.replace(/\s+/g, '')).filter((r) => r.length >= 4);
  const whole = all.join('');
  return mine.some((w) => theirs.includes(w) || joined.includes(w)) || runs.some((r) => joined.includes(r)) || (all.length > 1 && whole.length >= 4 && joined.includes(whole));
}

// Coordinates from a Google Maps place link ("!3d<lat>!4d<lon>", or "@lat,lon" as a fallback).
export function coordsFromUrl(url) {
  const m = String(url).match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) || String(url).match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  return m ? { lat: Number(m[1]), lon: Number(m[2]) } : null;
}
export function km(a, b) {
  const r = (d) => (d * Math.PI) / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lon - a.lon) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
// Map pins for the same shop can sit a few hundred metres apart; branches of a chain are further.
// Past FAR_KM the only match is clearly another business, so this one isn't on Google Maps.
export const MAX_KM = 1.5, FAR_KM = 5;
// Within this distance a different name is the same premises (same building or shopfront).
export const SAME_SPOT_KM = 0.1;

// A "website" that is really a social profile or a booking marketplace means they have no site of
// their own: that's the opportunity, so keep it as a contact channel instead of auditing it.
const SOCIAL = [[/(^|\.)instagram\.com$/, 'Instagram', 'instagram'], [/(^|\.)(facebook|fb)\.com$/, 'Facebook', 'facebook'], [/(^|\.)tiktok\.com$/, 'TikTok', 'tiktok'],
  [/(^|\.)(x|twitter)\.com$/, 'X (Twitter)', 'twitter'], [/(^|\.)linkedin\.com$/, 'LinkedIn', 'linkedin'], [/(^|\.)(linktr\.ee|linkin\.bio|beacons\.ai)$/, 'a link-in-bio page', 'linkInBio'],
  [/(^|\.)(fresha\.com|treatwell\.[a-z.]+|booksy\.com|setmore\.com|vagaro\.com|booking\.com|wa\.me)$/, 'a booking or messaging page', 'bookingPage']];
export function socialSite(url) {
  let h; try { h = new URL(url).hostname.toLowerCase(); } catch { return null; }
  const hit = SOCIAL.find(([re]) => re.test(h));
  return hit ? { label: hit[1], field: hit[2] } : null;
}

// Turn the text of a Google Maps place panel into facts. Pure, so it's unit-tested without a browser.
export function parseListing({ text = '', name = '', website = null, phone = null }) {
  if (!name || /^results$/i.test(name.trim())) return { found: false };
  // Google's ad label sometimes sits where the place name should be: we don't know what's listed.
  if (/^sponsored$/i.test(name.trim())) return { found: false, ambiguous: true };
  const closed = /permanently closed/i.test(text) ? 'permanently' : /temporarily closed/i.test(text) ? 'temporarily' : null;
  const m = text.match(/(?:^|\n)\s*([0-5][.,]\d)\s*\n?\s*\(([\d,.]+)\)/);
  return {
    found: true, name: name.trim(), closed, website: website || null, phone: phone || null,
    rating: m ? Number(m[1].replace(',', '.')) : null,
    // A place with no reviews shows no rating line at all (and no Reviews tab).
    reviews: m ? Number(m[2].replace(/[,.]/g, '')) : 0,
    unclaimed: /claim this business/i.test(text),
  };
}

// What the listing means for the lead. skip = don't spend an audit or AI call on it.
export function listingVerdict(listing) {
  if (!listing || listing.error) return { skip: null, note: `Google Maps check failed (${listing?.error || 'no result'}); used the map data as-is` };
  if (!listing.found) return { skip: listing.ambiguous ? null : 'Not found on Google Maps: it may have closed or moved. Check by hand before pitching.', note: listing.ambiguous ? 'Google Maps showed several results; used the map data as-is' : null };
  // Another business at the very same spot: this one has most likely closed, been bought or renamed
  // (e.g. a spa that is now a nail bar under a new name). Its old website being dead would look like a great
  // lead, so don't audit it. Elsewhere a different top result proves nothing either way.
  if (listing.mismatch && listing.km != null && listing.km <= SAME_SPOT_KM) {
    return { skip: `Google Maps shows a different business at this address ("${listing.name}"): it has probably closed, been taken over or renamed. Check by hand before pitching.` };
  }
  if (listing.mismatch) return { skip: null, note: `Google Maps' top result was a different business ("${listing.name}"); used the map data as-is` };
  if (listing.closed) return { skip: `${listing.closed === 'permanently' ? 'Permanently' : 'Temporarily'} closed on Google Maps` };
  if (listing.reviews === 0) return { skip: 'No Google reviews: probably very small, new or inactive' };
  return { skip: null };
}

const host = (u) => { try { return new URL(/^https?:\/\//i.test(u) ? u : `http://${u}`).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; } };

// Record a Google Maps check on a lead: skip it, or switch it to the website Google lists. A website
// you entered yourself (websiteFrom 'you') is never replaced. Returns the verdict.
export function applyListing(lead, listing, now = new Date().toISOString()) {
  lead.listing = listing;
  const v = listingVerdict(listing);
  lead.listingNote = v.note || undefined;
  if (v.skip) { Object.assign(lead, { status: 'skipped', skipReason: v.skip, processedAt: now }); return v; }
  if (!listing?.found || listing.mismatch) return v;
  if (listing.phone && !lead.contact?.phone) lead.contact = { ...lead.contact, phone: listing.phone };
  const social = listing.website && socialSite(listing.website);
  if (social) {
    lead.contact = { ...lead.contact, [social.field]: lead.contact?.[social.field] || listing.website };
    listing.socialOnly = social.label;
    return v;
  }
  const g = listing.website;
  if (g && lead.contact?.websiteFrom !== 'you' && host(g) !== host(lead.contact?.website)) {
    lead.contact = { ...lead.contact, website: g, mapWebsite: lead.contact?.website || null, websiteFrom: 'google' };
    v.websiteChanged = true;
  }
  return v;
}

// After the audit: if we found no website and Google links only to a social/booking page, that's a
// confirmed "no website" (Google is what customers see), stated the way the pitch can use it.
export function noteSocialOnly(lead) {
  const s = lead.listing?.socialOnly;
  if (!s || !lead.audit || lead.audit.hasWebsite) return false;
  lead.audit = { ...lead.audit, unverified: false, need: 70, issues: [{ key: 'social-only', text: `No website: their Google listing links to ${s} instead`, weight: 70 }] };
  return true;
}

// Where listing facts come from is pluggable. This public version ships one provider, "fixture",
// which reads recorded listings from a JSON file (used by the demo and the tests). The private
// version read Google Maps in a headless browser; that is deliberately not published, because
// automated access to Google Maps is restricted by Google's terms. A real deployment should use an
// official places API here and map its result to the shape parseListing() returns.
// Config: { "listing": { "provider": "fixture", "file": "sample/listings.json" } }; no provider = no check.

export function listingProvider(cfg = config()) {
  const l = cfg.listing || {};
  if (l.provider === 'fixture' && l.file) {
    const file = path.resolve(ROOT, l.file);
    return async ({ name }) => {
      let all;
      try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { error: `listing fixture unreadable: ${e.message.slice(0, 80)}` }; }
      const raw = all[name];
      if (!raw) return { found: false, checkedAt: new Date().toISOString() };
      const listing = parseListing(raw);
      if (listing.found && !sameBusiness({ name }, listing)) listing.mismatch = true;
      if (raw.km != null) listing.km = raw.km;
      return { ...listing, checkedAt: new Date().toISOString() };
    };
  }
  return null;
}
