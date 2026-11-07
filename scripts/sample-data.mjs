// Clearly fictional demo leads (example.* domains, phone numbers from ranges reserved for fiction).
// Dates are relative to now so the demo always looks fresh. Used by scripts/setup.mjs --demo.
const ago = (h) => new Date(Date.now() - h * 3600e3).toISOString();

export function sampleLeads() {
  const leads = [
    { id: 'sample-in:1', type: 'inbound', source: 'Freelancer.com', sourceDetail: 'search "website"', title: 'SAMPLE: Five-page WordPress site for a bakery',
      body: 'Sample post. We need a 5-page WordPress site with an online order form and our opening hours.', url: 'https://example.com/posts/1',
      postedAt: ago(5), foundAt: ago(4), status: 'qualified', score: 82, service: 'WordPress website', summary: 'A bakery wants a 5-page site with ordering.',
      budgetNote: 'Fair for the scope', redFlags: [], budget: { min: 250, max: 750, currency: 'USD', original: '250–750 USD' }, skills: ['WordPress', 'PHP'], bids: 8,
      pitch: "Hi, this is a sample drafted reply. It would reference the bakery's order form and hours, and end with one question.", contact: { handle: 'Bid on Freelancer.com' }, region: 'Anywhere', engine: 'sample' },
    { id: 'sample-in:2', type: 'inbound', source: 'Hacker News', sourceDetail: 'Freelancer? Seeking freelancer? (sample)', title: 'SEEKING FREELANCER | Remote | Shopify theme speed fixes (sample)',
      body: 'Sample post. Our Shopify store is slow on mobile; looking for someone to profile and fix theme performance.', url: 'https://example.com/posts/2',
      postedAt: ago(30), foundAt: ago(29), status: 'qualified', score: 64, service: 'Shopify speed fixes', redFlags: ['No budget given'], skills: [], pitch: '', contact: { handle: 'sample_user' }, region: 'Unknown', engine: 'sample' },
    { id: 'sample-in:3', type: 'inbound', source: 'Freelancer.com', sourceDetail: 'search "website"', title: 'SAMPLE: Commission-only sales rep for web agency',
      body: 'Sample post. Commission-only, 20% per closed deal.', url: 'https://example.com/posts/3', postedAt: ago(10), foundAt: ago(9), status: 'skipped',
      skipReason: 'Commission-only or unpaid work', skills: ['Sales'], redFlags: [], contact: {}, region: 'Anywhere' },
    { id: 'sample-in:4', type: 'inbound', source: 'Freelancer.com', sourceDetail: 'search "landing page"', title: 'SAMPLE: Landing page for a gym',
      body: 'Sample post. One landing page with a sign-up form.', url: 'https://example.com/posts/4', postedAt: ago(60), foundAt: ago(58), status: 'qualified', score: 71,
      sourceClosed: 'awarded to someone', sourceClosedAt: ago(2), redFlags: [], skills: ['HTML', 'CSS'], contact: {}, region: 'Anywhere' },
    { id: 'sample-out:1', type: 'outbound', source: 'OpenStreetMap', sourceDetail: 'Dentist · London', title: 'Example Dental Studio (Dentist, London)', url: 'https://example.com/map/1',
      business: { name: 'Example Dental Studio', category: 'Dentist', address: '1 Sample Street London', street: '1 Sample Street' },
      contact: { phone: '+44 20 7946 0001', email: 'hello@dental.example', website: 'http://dental.example' }, region: 'West', country: 'UK', city: 'London',
      foundAt: ago(20), status: 'qualified', score: 75, service: 'Site is not secure and not mobile-friendly',
      listing: { found: true, name: 'Example Dental Studio', rating: 4.6, reviews: 120, unclaimed: false, checkedAt: ago(20) },
      audit: { hasWebsite: true, url: 'http://dental.example', finalUrl: 'http://dental.example/', status: 200, ms: 5200, platform: 'Wix', https: false, need: 60, emails: [],
        issues: [{ key: 'no-https', text: 'Not secure: no HTTPS, so browsers show a "Not secure" warning', weight: 25 }, { key: 'not-mobile', text: 'Not mobile-friendly (no responsive viewport)', weight: 30 }, { key: 'no-description', text: 'Missing search description (hurts Google results)', weight: 5 }], checkedAt: ago(20) },
      pitchSubject: 'Your site shows "Not secure"', pitch: 'Sample pitch. Mentions the two verified findings, one real proof point from the offer, and ends with an opt-out line.', engine: 'sample' },
    { id: 'sample-out:2', type: 'outbound', source: 'OpenStreetMap', sourceDetail: 'Gym · Manchester', title: 'Placeholder Fitness (Gym, Manchester)', url: 'https://example.com/map/2',
      business: { name: 'Placeholder Fitness', category: 'Gym', address: 'Manchester' }, contact: { phone: '+44 161 496 0002' }, region: 'West', country: 'UK', city: 'Manchester',
      foundAt: ago(18), status: 'new', score: 75, audit: { hasWebsite: false, unverified: true, need: 60, issues: [{ key: 'none', text: 'No website on its map listing, and none found at the likely web addresses', weight: 60 }] } },
    { id: 'sample-out:3', type: 'outbound', source: 'OpenStreetMap', sourceDetail: 'Cafe · Toronto', title: 'Demo Coffee House (Cafe, Toronto)', url: 'https://example.com/map/3',
      business: { name: 'Demo Coffee House', category: 'Cafe', address: 'Toronto' }, contact: { phone: '+1 416 555 0103', website: 'https://coffee.example/old-menu.htm' }, region: 'West', country: 'Canada', city: 'Toronto',
      foundAt: ago(16), status: 'skipped', score: 35, skipReason: 'Score 35 is under 50',
      audit: { hasWebsite: true, url: 'https://coffee.example/', listedUrl: 'https://coffee.example/old-menu.htm', https: true, need: 15, issues: [{ key: 'dead-link', text: 'The link on their map listing (https://coffee.example/old-menu.htm) leads to a missing page (HTTP 404); their homepage works', weight: 15 }] } },
    { id: 'sample-out:4', type: 'outbound', source: 'OpenStreetMap', sourceDetail: 'Florist · Sydney', title: 'Sample Blooms (Florist, Sydney)', url: 'https://example.com/map/4',
      business: { name: 'Sample Blooms', category: 'Florist', address: 'Sydney' }, contact: { website: 'https://blooms.example/' }, region: 'West', country: 'Australia', city: 'Sydney',
      foundAt: ago(12), status: 'skipped', skipReason: 'Permanently closed on Google Maps', listing: { found: true, name: 'Sample Blooms', closed: 'permanently', reviews: 14 } },
    { id: 'sample-out:5', type: 'outbound', source: 'OpenStreetMap', sourceDetail: 'Clinic · Dubai', title: 'Mock Health Clinic (Clinic, Dubai)', url: 'https://example.com/map/5',
      business: { name: 'Mock Health Clinic', category: 'Clinic', address: 'Dubai' }, contact: { website: 'https://clinic.example/' }, region: 'Gulf', country: 'UAE', city: 'Dubai',
      foundAt: ago(8), status: 'skipped', score: 0, skipReason: 'Score 0 is under 50',
      audit: { hasWebsite: true, url: 'https://clinic.example/', unverifiable: true, need: 0, issues: [], note: "Couldn't check the website automatically (the site blocks automated checks). Open it yourself before pitching." } },
  ];
  return Object.fromEntries(leads.map((l) => [l.id, l]));
}
