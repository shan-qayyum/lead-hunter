// First-run setup: copy the example config and offer into place (never overwriting yours).
//   node scripts/setup.mjs          config.json + offer.json from the examples
//   node scripts/setup.mjs --demo   ...and seed data/leads.json with fictional sample leads
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sampleLeads } from './sample-data.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const copyOnce = (from, to) => {
  const dest = path.join(ROOT, to);
  if (fs.existsSync(dest)) return console.log(`kept your ${to}`);
  fs.copyFileSync(path.join(ROOT, from), dest);
  console.log(`created ${to} from ${from}`);
};
copyOnce('config.example.json', 'config.json');
copyOnce('offer.example.json', 'offer.json');
if (process.argv.includes('--demo')) {
  const leads = path.join(ROOT, 'data', 'leads.json');
  if (fs.existsSync(leads)) console.log('kept your data/leads.json (demo data is only added to an empty data folder)');
  else {
    fs.mkdirSync(path.dirname(leads), { recursive: true });
    fs.writeFileSync(leads, JSON.stringify(sampleLeads(), null, 1));
    console.log('seeded data/leads.json with fictional sample leads');
  }
}
