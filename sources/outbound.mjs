// Outbound: businesses that likely need a (better) website, from OpenStreetMap.
import { log, loadState, saveState } from '../lib.mjs';

// One city x category per query, rotating so each run covers new ground (and stays polite
// to the free public Overpass servers).
export async function osm(cfg) {
  const combos = cfg.cities.filter((c) => c.enabled !== false).flatMap((city) => cfg.categories.map((cat) => ({ city, cat })));
  const out = Object.assign([], { errors: [], attempts: 0 });
  if (!combos.length) return out;
  const state = loadState();
  const cursor = state.osmCursor || 0;
  // The server that answered last time goes first: the public mirrors are often down for hours.
  const endpoints = [...new Set([state.osmEndpoint, ...cfg.endpoints].filter((e) => cfg.endpoints.includes(e)))];
  let done = 0, good;
  for (let i = 0; i < cfg.queriesPerRun; i++) {
    const { city, cat } = combos[(cursor + i) % combos.length];
    const [k, v] = cat.tag.split('=');
    const box = [city.lat - 0.12, city.lon - 0.15, city.lat + 0.12, city.lon + 0.15].map((n) => n.toFixed(4)).join(',');
    const query = `[out:json][timeout:25];nwr["${k}"="${v}"]["name"](${box});out tags center ${cfg.perQuery};`;
    out.attempts++;
    const { elements, endpoint, errors } = await overpass(endpoints, query);
    if (!elements) {
      log(`source osm ${cat.label} in ${city.name}: all Overpass servers failed, will retry later`);
      out.errors.push(`${cat.label} in ${city.name}: all map servers failed (${errors.join('; ')})`);
      break;
    }
    done++; good = endpoint;
    let kept = 0;
    for (const el of elements) {
      const t = el.tags || {};
      const contact = {
        phone: t.phone || t['contact:phone'], email: t.email || t['contact:email'],
        website: t.website || t['contact:website'] || t.url,
        facebook: t['contact:facebook'] || t.facebook, instagram: t['contact:instagram'] || t.instagram,
      };
      if (!contact.phone && !contact.email && !contact.website) continue; // no way to reach them
      if (t['brand:wikidata']) continue; // a chain branch: head office owns the website
      const address = [t['addr:housenumber'], t['addr:street'], t['addr:city'] || city.name].filter(Boolean).join(' ');
      out.push({
        id: `osm:${el.type}/${el.id}`, type: 'outbound', source: 'OpenStreetMap', sourceDetail: `${cat.label} · ${city.name}`,
        title: `${t.name} (${cat.label}, ${city.name})`, url: `https://www.openstreetmap.org/${el.type}/${el.id}`,
        mapsUrl: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${t.name} ${city.name}`)}`,
        business: { name: t.name, category: cat.label, address, street: [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ') || undefined, lat: el.lat ?? el.center?.lat, lon: el.lon ?? el.center?.lon },
        contact, region: city.region, country: city.country, city: city.name,
        foundAt: new Date().toISOString(), status: 'new',
      });
      kept++;
    }
    log(`source osm ${cat.label} in ${city.name}: ${elements.length} businesses, ${kept} reachable`);
  }
  // Only move past queries that ran, so a city hit by a server outage is retried next time.
  saveState({ ...loadState(), osmCursor: (cursor + done) % combos.length, ...(good ? { osmEndpoint: good } : {}) });
  return out;
}

async function overpass(endpoints, query) {
  const errors = [];
  for (const ep of endpoints) {
    try {
      const r = await fetch(ep, {
        method: 'POST', body: 'data=' + encodeURIComponent(query), signal: AbortSignal.timeout(45000),
        headers: { 'User-Agent': 'lead-hunter/1.0 (personal use)', 'Content-Type': 'application/x-www-form-urlencoded' },
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return { elements: (await r.json()).elements || [], endpoint: ep };
    } catch (e) {
      const why = e.name === 'TimeoutError' ? 'timed out' : e.message.slice(0, 60);
      log(`overpass ${new URL(ep).host} failed: ${why}`); errors.push(`${new URL(ep).host} ${why}`);
    }
  }
  return { elements: null, errors };
}
