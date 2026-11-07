// Unit checks for the shared helpers (no network). State writes go to a throwaway data folder.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'leadhunter-unit-'));
process.env.LH_DATA = TMP;
process.env.LH_AUDIT_RETRY_MS = '0'; // the homepage-error re-check waits 3 s in real runs
const { isAlive, healthEntry } = await import('../lib.mjs');
const { buildQueue, inboundPriority, inboundRuleSkip, applySourceStatus } = await import('../qualify.mjs');
const { domainGuesses, pageMatches, auditSite } = await import('../audit.mjs');

let n = 0;
const check = (name, fn) => { fn(); n++; };

check('isAlive', () => {
  const throwing = (code) => () => { throw Object.assign(new Error(code), { code }); };
  assert.equal(isAlive(1234, () => true), true, 'signal 0 succeeds -> alive');
  assert.equal(isAlive(1234, throwing('EPERM')), true, 'owned by an admin process -> still alive');
  assert.equal(isAlive(1234, throwing('ESRCH')), false, 'no such process -> dead');
  assert.equal(isAlive(0), false, 'no pid -> not alive');
  assert.equal(isAlive(process.pid), true, 'this process is alive');
});

const NOW = Date.parse('2026-10-31T12:00:00Z');
const daysAgo = (d) => new Date(NOW - d * 864e5).toISOString();
const inb = (id, o = {}) => ({ id, type: 'inbound', status: 'new', postedAt: daysAgo(0), ...o });
const outb = (id, score, o = {}) => ({ id, type: 'outbound', status: 'new', score, audit: {}, foundAt: daysAgo(0), ...o });

check('inboundPriority prefers fresh, well-paid, uncrowded posts', () => {
  assert.ok(inboundPriority(inb('a'), NOW) > inboundPriority(inb('b', { postedAt: daysAgo(4) }), NOW), 'fresher first');
  assert.ok(inboundPriority(inb('a', { budget: { max: 1500 } }), NOW) > inboundPriority(inb('b', { budget: { max: 100 } }), NOW), 'bigger budget first');
  assert.ok(inboundPriority(inb('a', { bids: 3 }), NOW) > inboundPriority(inb('b', { bids: 300 }), NOW), 'fewer bids first');
  const p = inboundPriority(inb('a', { postedAt: daysAgo(90), bids: 500 }), NOW);
  assert.ok(p >= 0 && p <= 100, 'clamped to 0-100');
});

check('buildQueue alternates inbound and outbound so neither starves', () => {
  const leads = [outb('o1', 95), outb('o2', 90), outb('o3', 85), outb('o4', 80), inb('i1'), inb('i2'), inb('i3', { postedAt: daysAgo(3) })];
  const { ai } = buildQueue(leads, { aiPerRun: 6, minScore: 50, now: NOW });
  assert.deepEqual(ai.map((l) => l.id), ['i1', 'o1', 'i2', 'o2', 'i3', 'o3']);
});

check('buildQueue fills from the other kind when one runs out', () => {
  const { ai } = buildQueue([inb('i1'), outb('o1', 90), outb('o2', 70), outb('o3', 60)], { aiPerRun: 4, minScore: 50, now: NOW });
  assert.deepEqual(ai.map((l) => l.id), ['i1', 'o1', 'o2', 'o3']);
  assert.deepEqual(buildQueue([inb('i1'), inb('i2')], { aiPerRun: 5, now: NOW }).ai.map((l) => l.id), ['i1', 'i2']);
});

check('buildQueue skips low outbound by rule (no AI slot) and ignores unaudited / non-new leads', () => {
  const leads = [outb('low', 20), outb('ok', 70), { ...outb('unaudited', 90), audit: undefined }, inb('done', { status: 'qualified' })];
  const { ruleSkip, ai } = buildQueue(leads, { aiPerRun: 8, minScore: 50, now: NOW });
  assert.deepEqual(ruleSkip.map((l) => l.id), ['low']);
  assert.deepEqual(ai.map((l) => l.id), ['ok']);
});

check('inboundRuleSkip drops non-web and commission-only posts, never web jobs', () => {
  assert.match(inboundRuleSkip(inb('a', { title: 'Hoodie sample maker', skills: ['Graphic Design', 'Fashion Design'] })), /Not web work/);
  assert.match(inboundRuleSkip(inb('a', { title: 'B2B Commission Sales Closer', skills: ['Sales'] })), /Commission/);
  assert.match(inboundRuleSkip(inb('a', { title: 'Sell our websites', body: 'This is commission-only, 20% per deal.' })), /Commission/);
  assert.equal(inboundRuleSkip(inb('a', { title: 'Build a WordPress site', skills: ['WordPress', 'PHP'] })), null);
  assert.equal(inboundRuleSkip(inb('a', { title: 'WordPress landing pages', skills: ['Affiliate Marketing'] })), null, 'web title keeps it');
  assert.equal(inboundRuleSkip(inb('a', { title: 'Payment gateway', skills: ['PHP'], body: 'Transaction fees and commission configuration' })), null, 'commission as a feature is fine');
  assert.equal(inboundRuleSkip(inb('a', { title: 'SEEKING FREELANCER | help needed' })), null, 'no skills (HN): leave to the AI');
  assert.equal(inboundRuleSkip(inb('a', { title: 'Logo', skills: ['Logo Design'], forceAI: true })), null, 'Re-check with AI bypasses rules');
});

check('buildQueue records why a lead was skipped by rule', () => {
  const { ruleSkip, ai } = buildQueue([inb('logo', { title: 'Logo', skills: ['Logo Design'] }), outb('low', 20), inb('web', { title: 'Shopify store', skills: ['Shopify'] })], { minScore: 50, now: NOW });
  assert.deepEqual(ruleSkip.map((l) => [l.id, /Not web|under 50/.test(l.skipReason)]), [['logo', true], ['low', true]]);
  assert.deepEqual(ai.map((l) => l.id), ['web']);
});

check('domainGuesses builds local addresses from the business name', () => {
  assert.deepEqual(domainGuesses("Demo's Barbers", 'UK').slice(0, 3), ['demosbarbers.co.uk', 'demosbarbers.com', 'demosbarbers.uk']);
  assert.ok(domainGuesses('Café Échantillon & Co', 'UAE').includes('cafeechantillon.ae'), 'accents and generic words dropped');
  assert.ok(domainGuesses('The Q9 Sample Collective', 'Pakistan').includes('q9samplecollective.com.pk'));
  assert.deepEqual(domainGuesses('A1', 'UK'), [], 'too short to guess');
});

check('pageMatches only accepts a page showing this business (phone or street)', () => {
  assert.equal(pageMatches('<p>Call us: 020 7946 0123</p>', { phone: '+44 20 7946 0123' }), 'phone');
  assert.equal(pageMatches('<p>Find us at 451  Sample Road, London</p>', { street: '451 Sample Road' }), 'address');
  assert.equal(pageMatches('<title>Sample Nails</title> Othertown', { phone: '+44 20 7946 0123', street: '451 Sample Road' }), null, 'same name elsewhere is not a match');
  assert.equal(pageMatches('<p>123</p>', { phone: '', street: 'Main' }), null, 'too little to match on');
});

check('healthEntry classifies a source run', () => {
  const res = (n, errors, attempts, extra = {}) => Object.assign(Array(n).fill({}), { errors, attempts, ...extra });
  const ok = healthEntry({}, res(5, [], 3), 'T1');
  assert.deepEqual([ok.status, ok.found, ok.lastOkAt], ['ok', 5, 'T1']);
  assert.equal(healthEntry({}, res(2, ['x: HTTP 500'], 3), 'T2').status, 'partial');
  const bad = healthEntry(ok, res(0, ['a', 'b: rate limited (429)'], 2), 'T3');
  assert.deepEqual([bad.status, bad.lastError, bad.lastOkAt], ['failing', 'b: rate limited (429)', 'T1'], 'keeps when it last worked');
  assert.equal(healthEntry(ok, res(0, [], 0, { skipped: 'paused' }), 'T4').status, 'paused');
});

check('applySourceStatus retires closed Freelancer posts, moves untouched qualified ones to Lost, refreshes bids', () => {
  const q = inb('q', { status: 'new', bids: 3 });
  assert.equal(applySourceStatus(q, { open: true, bids: 9 }, 'T'), false); assert.equal(q.bids, 9);
  assert.equal(applySourceStatus(q, { open: false, why: 'awarded to someone', bids: 12 }, 'T'), true);
  assert.deepEqual([q.status, q.sourceClosed, q.bids, /awarded/.test(q.skipReason)], ['skipped', 'awarded to someone', 12, true]);
  assert.equal(applySourceStatus(q, { open: false, why: 'closed' }, 'T2'), false, 'only flagged once');
  const w = inb('w', { status: 'qualified' });
  applySourceStatus(w, { open: false, why: 'closed' }, 'T');
  assert.deepEqual([w.status, w.sourceClosed, w.closedAt, /closed/.test(w.lostReason)], ['lost', 'closed', 'T', true], 'untouched qualified leads move to Lost');
  const c = inb('c', { status: 'contacted' });
  applySourceStatus(c, { open: false, why: 'closed' }, 'T');
  assert.equal(c.status, 'contacted', 'leads you already contacted keep their status');
});

check('buildQueue skips reposts and cross-posts, keeping the first copy', () => {
  const body = 'We need a five page website for our plumbing company with a quote form and Google reviews on the homepage.';
  const leads = [
    inb('done', { status: 'qualified', title: 'Custom website build', foundAt: daysAgo(3) }),
    inb('repost', { title: 'Custom Website Build -- 2', foundAt: daysAgo(1) }),
    inb('first', { title: 'Plumber site', body, foundAt: daysAgo(2) }),
    inb('cross', { title: 'Need plumbing website', body, foundAt: daysAgo(1) }),
    inb('forced', { title: 'Custom website build', forceAI: true, foundAt: daysAgo(0) }),
  ];
  const { ruleSkip, ai } = buildQueue(leads, { now: NOW });
  assert.deepEqual(ruleSkip.map((l) => [l.id, l.skipReason]), [['repost', 'Duplicate of "Custom website build"'], ['cross', 'Duplicate of "Plumber site"']]);
  assert.deepEqual(ai.map((l) => l.id).sort(), ['first', 'forced']);
  assert.ok(!('duplicateOf' in leads[1]), 'no object references stored on leads');
});

await (async () => {
  // A dead page from the map listing is not a broken site; a homepage error must still be there on a second
  // check; a site that blocks automated checks is "couldn't verify", never "broken".
  const http = await import('node:http');
  const page = '<html><head><meta name="viewport" content="width=device-width"><title>Sample Gym</title><meta name="description" content="Personal training studio in Sampletown, London"></head><body>Hi</body></html>';
  const srv = http.createServer((req, res) => {
    if (req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html' }); return res.end(page); }
    res.writeHead(404, { 'Content-Type': 'text/html' }); res.end('<title>Not found</title>');
  }).listen(0, '127.0.0.1');
  const down = http.createServer((req, res) => { res.writeHead(500); res.end('oops'); }).listen(0, '127.0.0.1');
  const guarded = http.createServer((req, res) => { res.writeHead(403); res.end('Access denied'); }).listen(0, '127.0.0.1');
  let hits = 0;
  const blip = http.createServer((req, res) => {
    if (hits++ === 0) { res.writeHead(502); return res.end('bad gateway'); }
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(page);
  }).listen(0, '127.0.0.1');
  await new Promise((r) => setTimeout(r, 100));
  const base = `http://127.0.0.1:${srv.address().port}`;
  const a = await auditSite(`${base}/old-gym.htm`);
  assert.ok(!a.broken && !a.issues.some((i) => i.key === 'broken'), `dead listing link must not be called broken: ${JSON.stringify(a.issues)}`);
  assert.ok(a.issues.some((i) => i.key === 'dead-link' && i.text.includes('homepage works')), 'dead link should be a small finding');
  assert.equal(a.listedUrl, `${base}/old-gym.htm`);
  const b = await auditSite(`http://127.0.0.1:${down.address().port}/`);
  assert.ok(b.issues.some((i) => i.key === 'broken' && /second check/.test(i.text)), `homepage error should be confirmed by a second check: ${JSON.stringify(b)}`);
  const g = await auditSite(`http://127.0.0.1:${guarded.address().port}/`);
  assert.ok(g.unverifiable && !g.issues.length && /blocks automated checks/.test(g.note), `a blocked check must be "couldn't verify": ${JSON.stringify(g)}`);
  const c = await auditSite(`http://127.0.0.1:${blip.address().port}/`);
  assert.ok(!c.issues.some((i) => i.key === 'broken'), `a one-off error must not be called broken: ${JSON.stringify(c.issues)}`);
  srv.close(); down.close(); guarded.close(); blip.close();
  n++;
})();

// Listing check: panel shapes as recorded from real listings, with fictional names and numbers.
const listingMod = await import('../listing.mjs');
const { parseListing, sameBusiness, coordsFromUrl, km, listingVerdict, applyListing } = listingMod;
const { outboundScore } = await import('../qualify.mjs');

check('parseListing reads rating, reviews, closed and unclaimed', () => {
  const bar = parseListing({ name: 'Sample Food & Bar', text: 'Sample Food & Bar\n4.7\n(80)·£10–20\nGreek restaurant\nOverview\nMenu\nReviews\nAbout', website: 'http://www.samplefood.example/' });
  assert.deepEqual([bar.found, bar.rating, bar.reviews, bar.unclaimed], [true, 4.7, 80, false]);
  assert.equal(parseListing({ name: 'Example Orthodontics', text: '4.8\n(1,161)\nOrthodontist' }).reviews, 1161, 'thousands separator');
  const bare = parseListing({ name: 'DEMO DENTAL CENTER', text: 'DEMO DENTAL CENTER\nDentist\nDirections\nClaim this business\nAdd website\nWrite a review' });
  assert.deepEqual([bare.reviews, bare.unclaimed], [0, true], 'no rating line = no reviews');
  assert.equal(parseListing({ name: 'Old Cafe', text: 'Old Cafe\n4.1\n(12)\nPermanently closed' }).closed, 'permanently');
  assert.equal(parseListing({ name: 'Results', text: 'Results\nSponsored' }).found, false, 'a results list is not a place');
  assert.equal(parseListing({ name: '', text: "Google Maps can't find X" }).found, false);
});

check('sameBusiness: distinctive word or phone, not generic words', () => {
  assert.ok(sameBusiness({ name: 'Lake Vets' }, { name: 'Lakevets' }));
  assert.ok(sameBusiness({ name: 'Exampleton Physiotherapy Clinic' }, { name: 'Exampleton Physiotherapy Clinic - Physiosample' }));
  assert.ok(sameBusiness({ name: 'Demoran & Company' }, { name: 'Demoran & Co' }));
  assert.ok(!sameBusiness({ name: 'Smile Dental Clinic' }, { name: 'Bright Dental Clinic' }), 'shared generic words only');
  assert.ok(sameBusiness({ name: 'Totally Different', phone: '+44 20 7946 0456' }, { name: 'Other', phone: '020 7946 0456' }), 'same phone');
});

check('coordinates and distance separate branches of a chain', () => {
  const c = coordsFromUrl('https://www.google.com/maps/place/X/@40.6,-73.9,17z/data=!3m1!4b1!4m6!3m5!8m2!3d40.6200001!4d-73.9500002!16s');
  assert.deepEqual(c, { lat: 40.6200001, lon: -73.9500002 }, '!3d/!4d preferred over @');
  assert.deepEqual(coordsFromUrl('https://www.google.com/maps/search/x/@51.55,-0.14,11z'), { lat: 51.55, lon: -0.14 });
  assert.equal(coordsFromUrl('https://example.com'), null);
  assert.ok(km({ lat: 51.4098856, lon: -0.2244311 }, { lat: 51.4098856, lon: -0.2244311 }) < 0.01);
  const twoBranches = km({ lat: 51.4097, lon: -0.2244 }, { lat: 51.4513, lon: 0.0546 });
  assert.ok(twoBranches > 15 && twoBranches < 25, `about 20 km, got ${twoBranches}`);
});

check('listingVerdict skips closed, missing and review-less businesses only', () => {
  assert.match(listingVerdict({ found: true, closed: 'permanently', reviews: 40 }).skip, /Permanently closed/);
  assert.match(listingVerdict({ found: false }).skip, /Not found on Google Maps/);
  assert.match(listingVerdict({ found: true, reviews: 0 }).skip, /No Google reviews/);
  assert.equal(listingVerdict({ found: true, reviews: 2 }).skip, null, 'few reviews lowers the score instead');
  assert.equal(listingVerdict({ found: true, mismatch: true, name: 'Other' }).skip, null, 'a different business is not evidence');
  assert.equal(listingVerdict({ error: 'timeout' }).skip, null, 'a failed check never skips');
});

check('a different business at the same spot means replaced or renamed (a spa that became a nail bar)', () => {
  const v = listingVerdict({ found: true, mismatch: true, name: 'Newname Nails Bar', km: 0.02, reviews: 102 });
  assert.match(v.skip, /Newname Nails Bar/);
  assert.match(v.skip, /check by hand/i);
  assert.equal(listingVerdict({ found: true, mismatch: true, name: 'Sample Wellness', km: 2.07, reviews: 65 }).skip, null, 'a different spot is still not evidence');
  assert.equal(listingVerdict({ found: true, mismatch: true, name: 'Other', km: null }).skip, null, 'unknown distance is not evidence');
  // Google's ad label is not a business name (one lead's name was read as "Sponsored").
  const ad = parseListing({ name: 'Sponsored', text: 'Sponsored\nSome Other Place\n4.5\n(20)' });
  assert.equal(ad.found, false);
  assert.equal(listingVerdict(ad).skip, null, 'an ad in the way is not proof the business is gone');
});

check('applyListing switches to the website Google lists, never over one you entered', () => {
  const bar = { status: 'new', contact: { phone: '+447700900123', website: 'https://www.previous-owner.example/' } };
  const v = applyListing(bar, { found: true, reviews: 80, website: 'http://www.samplefood.example/' });
  assert.ok(v.websiteChanged && bar.contact.website === 'http://www.samplefood.example/' && bar.contact.mapWebsite === 'https://www.previous-owner.example/' && bar.contact.websiteFrom === 'google');
  const same = { status: 'new', contact: { website: 'https://samplefood.example' } };
  assert.ok(!applyListing(same, { found: true, reviews: 80, website: 'http://www.samplefood.example/' }).websiteChanged, 'www/http differences are the same site');
  const mine = { status: 'new', contact: { website: 'https://real.example/', websiteFrom: 'you' } };
  applyListing(mine, { found: true, reviews: 9, website: 'https://other.example/' });
  assert.equal(mine.contact.website, 'https://real.example/');
  const vets = { status: 'new', contact: { website: 'https://www.lakevets.example/' } };
  applyListing(vets, { found: true, reviews: 0, unclaimed: true }, '2026-11-02T00:00:00Z');
  assert.deepEqual([vets.status, vets.processedAt], ['skipped', '2026-11-02T00:00:00Z']);
  assert.match(vets.skipReason, /No Google reviews/);
  const other = { status: 'new', contact: { website: 'https://a.example/' } };
  applyListing(other, { found: true, mismatch: true, reviews: 300, website: 'https://b.example/' });
  assert.equal(other.contact.website, 'https://a.example/', 'never take a website from a different business');
});

check('a social or booking page is not a website', () => {
  const { socialSite, noteSocialOnly } = listingMod;
  assert.deepEqual(socialSite('https://www.instagram.com/sample.nails.example/'), { label: 'Instagram', field: 'instagram' });
  assert.equal(socialSite('https://www.fresha.com/a/salon')?.field, 'bookingPage');
  assert.equal(socialSite('https://samplecollective.example/'), null);
  assert.equal(socialSite('https://notinstagram.com.evil.example/'), null, 'host must really be instagram');
  const nails = { status: 'new', contact: { phone: '+442079460789' } };
  const v = applyListing(nails, { found: true, reviews: 577, website: 'https://www.instagram.com/sample.nails.example/' });
  assert.ok(!v.websiteChanged && !nails.contact.website && nails.contact.instagram === 'https://www.instagram.com/sample.nails.example/' && nails.listing.socialOnly === 'Instagram');
  nails.audit = { hasWebsite: false, unverified: true, need: 60, issues: [{ key: 'none', text: 'No website on its map listing', weight: 60 }] };
  assert.ok(noteSocialOnly(nails));
  assert.deepEqual([nails.audit.unverified, nails.audit.need, nails.audit.issues[0].text], [false, 70, 'No website: their Google listing links to Instagram instead']);
  assert.ok(!noteSocialOnly({ listing: { socialOnly: 'Instagram' }, audit: { hasWebsite: true, issues: [] } }), 'a real site found elsewhere is kept');
});

check('short-word names match as a whole (QX:ZY -> QXZY Body Aesthetics)', () => {
  assert.ok(sameBusiness({ name: 'QX:ZY Beauty Rooms' }, { name: 'QXZY Body Aesthetics' }));
  assert.ok(!sameBusiness({ name: 'QX:ZY Beauty Rooms' }, { name: 'Que Zee Clinic' }));
  assert.ok(!sameBusiness({ name: 'A B' }, { name: 'AB Plumbing' }), 'too short to trust');
  assert.ok(!sameBusiness({ name: 'Sample Shape Studio' }, { name: 'SF Studios London' }), '"studio" alone is not evidence');
  assert.ok(sameBusiness({ name: 'Exampleton Barbers' }, { name: 'Exampleton Barbers Ltd' }));
});

check('outboundScore uses Google reviews', () => {
  const base = { audit: { need: 60 }, contact: { phone: '1' }, region: 'West' };
  const plain = outboundScore(base);
  assert.equal(outboundScore({ ...base, listing: { found: true, reviews: 2 } }), plain - 20, 'tiny or inactive');
  assert.equal(outboundScore({ ...base, listing: { found: true, reviews: 161 } }), Math.min(100, plain + 5), 'established');
  assert.equal(outboundScore({ ...base, listing: { found: true, reviews: 2, mismatch: true } }), plain, 'mismatch ignored');
  assert.equal(outboundScore({ audit: { need: 5 }, contact: {}, listing: { found: true, reviews: 1 } }), 0, 'never negative');
});

await (async () => {
  // Listing facts come from a pluggable provider; none configured = no check at all.
  const { listingProvider } = listingMod;
  assert.equal(listingProvider({}), null);
  const lookup = listingProvider({ listing: { provider: 'fixture', file: 'sample/listings.json' } });
  const dental = await lookup({ name: 'Example Dental Studio' });
  assert.deepEqual([dental.found, dental.reviews, dental.website, !!dental.mismatch], [true, 120, 'http://dental.example/', false]);
  assert.equal((await lookup({ name: 'Not In The Fixture' })).found, false);
  assert.equal(listingVerdict(await lookup({ name: 'Sample Blooms' })).skip, 'Permanently closed on Google Maps');
  const broken = listingProvider({ listing: { provider: 'fixture', file: 'sample/missing.json' } });
  assert.match((await broken({ name: 'x' })).error, /unreadable/);
  assert.equal(listingVerdict(await broken({ name: 'x' })).skip, null, 'a failed check never skips a lead');
  n++;
})();

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`unit: ${n}/${n} passed`);
