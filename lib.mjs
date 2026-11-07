import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
// Secrets and endpoint settings live in .env (git-ignored), loaded here so every entry point sees them.
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
// LH_DATA / LH_CONFIG let the e2e tests run against a throwaway copy.
export const DATA = process.env.LH_DATA || path.join(ROOT, 'data');
export const CONFIG = process.env.LH_CONFIG || path.join(ROOT, 'config.json');
export const OFFER = process.env.LH_OFFER || path.join(ROOT, 'offer.json');
const LEADS = path.join(DATA, 'leads.json');
const STATE = path.join(DATA, 'state.json');
const SWITCH = path.join(DATA, 'switch.json');

export const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
};
export const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`; // per-process, so concurrent writers can't clobber each other
  fs.writeFileSync(tmp, JSON.stringify(v, null, 1));
  fs.renameSync(tmp, p);
};

export const config = () => readJson(CONFIG, {});
export const offer = () => readJson(OFFER, {});
export const loadLeads = () => readJson(LEADS, {});
export const saveLeads = (leads) => writeJson(LEADS, leads);
export const loadState = () => readJson(STATE, {});
export const saveState = (s) => writeJson(STATE, s);
export const isOn = () => readJson(SWITCH, { enabled: false }).enabled === true;
export const setOn = (enabled) => writeJson(SWITCH, { enabled, changedAt: new Date().toISOString() });

// Read-modify-write on the freshest copy; never hold a loadLeads() result across slow work.
export function updateLeads(fn) {
  const leads = loadLeads();
  const result = fn(leads);
  saveLeads(leads);
  return result;
}

// Fields you own in the app. A pipeline run never overwrites them.
const USER_FIELDS = ['notes', 'value', 'chat', 'contactedAt', 'repliedAt', 'proposalAt', 'closedAt', 'pitch'];
export function savePipelineLead(lead, startStatus) {
  updateLeads((leads) => {
    const fresh = leads[lead.id] || {};
    const merged = { ...fresh, ...lead };
    for (const f of USER_FIELDS) if (fresh[f] !== undefined) merged[f] = fresh[f];
    if (fresh.status && fresh.status !== startStatus) merged.status = fresh.status;
    if (!fresh.pitchEdited && lead.pitch !== undefined) merged.pitch = lead.pitch; // AI may refresh an unedited pitch
    leads[lead.id] = merged;
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}`;
  console.log(line);
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(path.join(DATA, 'pipeline.log'), line + '\n');
}

export const decode = (s = '') => String(s)
  .replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&#39;|&#x27;/g, "'").replace(/&#x2F;/g, '/').replace(/&nbsp;/g, ' ')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();

// An honest user agent: sites and APIs can see what is calling them and rate-limit or block it.
export const UA = 'lead-hunter/1.0 (personal lead research; respects robots and rate limits)';
export async function get(url, { timeout = 30000, ua = UA, ...opts } = {}) {
  const r = await fetch(url, { ...opts, headers: { 'User-Agent': ua, 'Accept-Language': 'en-US,en;q=0.9', ...(opts.headers || {}) }, signal: AbortSignal.timeout(timeout), redirect: 'follow' });
  if (r.status === 429) throw new Error('rate limited (429)');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r;
}

// ---------- AI via any OpenAI-compatible chat endpoint ----------
// The key comes from the environment (LLM_API_KEY, e.g. loaded from .env with `node --env-file`),
// never from config.json, so config can be shared without leaking credentials.
const llmKey = () => process.env.LLM_API_KEY || undefined;
export const llmBaseUrl = (llm = config().llm || {}) => process.env.LLM_BASE_URL || llm.baseUrl || 'http://localhost:11434/v1';
// Models that recently answered 429. Free quotas are per model and reset in minutes, so skip
// them for 10 minutes instead of hitting them on every call. Expiry matters because the
// dashboard server (AI bar) is a long-lived process that shares this code.
const COOL_MS = 10 * 60 * 1000;
const coolUntil = new Map();
const cooling = {
  has: (m) => (coolUntil.get(m) || 0) > Date.now(),
  add: (m) => coolUntil.set(m, Date.now() + COOL_MS),
};

// Whether a pid is still running. EPERM means it exists but belongs to a more privileged
// process (e.g. a run started from an admin shell), so it counts as alive.
export function isAlive(pid, kill = (p, s) => process.kill(p, s)) {
  if (!pid) return false;
  try { kill(pid, 0); return true; } catch (e) { return e?.code === 'EPERM'; }
}

async function complete(messages, { json, maxTokens = 4000, temperature = 0.4 } = {}) {
  const llm = config().llm || {};
  const key = llmKey();
  const errors = [];
  // Two tries per model (free models occasionally emit malformed JSON), then the next model.
  for (const model of (llm.models || []).flatMap((m) => [m, m])) {
    if (cooling.has(model)) continue;
    try {
      const r = await fetch(`${llmBaseUrl(llm)}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        // Some free models (Gemma, Gemini 3.6 Flash) reject or blank out under strict JSON mode;
        // they still answer in JSON when asked, and the caller extracts it.
        body: JSON.stringify({ model, max_tokens: maxTokens, temperature, messages,
          ...(json && !(llm.noJsonMode || []).includes(model) ? { response_format: { type: 'json_object' } } : {}) }),
        signal: AbortSignal.timeout((llm.timeoutSec || 120) * 1000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const text = ((await r.json()).choices?.[0]?.message?.content || '').trim();
      if (!text) throw new Error('empty reply');
      if (!json) return { text, model };
      return { data: JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)), model };
    } catch (e) {
      if (/HTTP 429/.test(e.message)) cooling.add(model);
      errors.push(`${model}: ${e.name === 'TimeoutError' ? 'timed out' : e.message.slice(0, 80)}`);
    }
  }
  // Every model rate-limited = quota used up, not a bad lead: callers pause instead of counting a failure.
  const limited = (llm.models || []).every((m) => cooling.has(m)) || (errors.length && errors.every((e) => /429/.test(e)));
  const err = new Error(limited ? 'AI quota used up for now (all models rate-limited); will retry next run'
    : `AI endpoint unavailable (${errors.join(' | ')}). Is it running, and is LLM_BASE_URL right?`);
  err.rateLimited = limited;
  throw err;
}
export const askJson = (prompt, opts) => complete([{ role: 'user', content: prompt }], { ...opts, json: true });
export const chat = (messages, opts) => complete(messages, opts);

// One source's result for the health panel. `out` is the array a source returns, carrying
// errors/attempts (and `skipped` while it's deliberately paused).
export function healthEntry(prev = {}, out, now = new Date().toISOString()) {
  const errors = out.errors?.length || 0, attempts = out.attempts || 0;
  const status = out.skipped ? 'paused' : attempts && errors >= attempts ? 'failing' : errors ? 'partial' : 'ok';
  return { at: now, status, found: out.length, attempts, errors, lastError: out.errors?.at(-1) || out.skipped || undefined,
    lastOkAt: status === 'ok' || status === 'partial' ? now : prev.lastOkAt };
}
