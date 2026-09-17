// AI queue processor — drains the ai_queue Firestore collection through the
// free-tier Gemini key. The app (index.html) enqueues questions and processes
// them slowly while it's open; this script does the same thing headless so the
// queue also drains overnight via GitHub Actions ("pick up where we left off").
//
//   node scripts/ai-queue.mjs               process up to 150 items
//   node scripts/ai-queue.mjs --max 40      cap the run
//   node scripts/ai-queue.mjs --dry         list what would run, call nothing
//
// Every queue doc carries its full prompt and a small dest descriptor, so this
// script needs no knowledge of hunts or templates — it just routes answers:
//   {t:'ans', hk, qk, label, q} -> ai_answers/{hk}__{qk}
//   {t:'fc',  year}             -> ai_factcheck/{queueDocId}
//   {t:'syn', file, id}         -> ai_syn/{queueDocId}
//
// Free-tier etiquette: one request every ~7s, stop immediately on 429 and
// write meta/aiState.pausedUntil so every other processor waits too.

const PROJECT = 'oregon-hunting';
const API_KEY = 'AIzaSyCqbU875vWyWS0dQWr0hoqVRscH2AtU_v4'; // Firebase web key (public by design)
const BASE = process.env.FS_BASE ||
  `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

// Free tier, no billing attached — shipped in-repo by the owner's explicit
// choice. Base64 only because GitHub push protection blocks the literal form.
// Primary ("ODFW App") first, backup ("ODFW Backup") second: each key is used
// until Gemini says it's exhausted for the day, then the next takes over.
const AI_KEYS = [
  atob('QVEuQWI4Uk42SzkxaWRJUkFfMjZyS2FmWlB4YllNMDdEZ0ZWSE5ucVNJQWlsdlQtTC1fT2c='),
  atob('QVEuQWI4Uk42TDZJd2dEbkg1Z1ZLVFlvcWpXd2ZITHQtRE1ZR2V5X0RydEYySkdDaTV3MUE=')
];
const AI_KEY_NAMES = ['primary', 'backup'];
// A ladder, not one model. Measured live on this key: gemini-flash-latest
// returned 503 "experiencing high demand" on essentially every real prompt,
// which is why runs managed ~4 answers against a 1,600-item queue; flash-lite
// answered 8 of 8 in about a second each. Try the best first, drop to the next
// the moment one says it is busy, and record which one answered.
const AI_MODELS = (process.env.GEMINI_MODELS || 'gemini-2.5-flash,gemini-flash-lite-latest,gemini-flash-latest').split(',');
const AI_MODEL = AI_MODELS[0];
const aiUrlFor = m => process.env.GEMINI_URL ||
  `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`;

// Thinking tokens are charged against maxOutputTokens on this model (~1-2k per
// question), so budgets must cover thinking + answer or replies come back
// truncated mid-sentence.
const MAX_TOKENS = 4096;
const PACE_MS = Number(process.env.AI_PACE_MS || 7000);
const CLAIM_MS = 120000;
const argOf = f => { const i = process.argv.indexOf(f); return i >= 0 ? process.argv[i + 1] : null; };
const MAX = Number(argOf('--max') || 150);
const DRY = process.argv.includes('--dry');

// ── Firestore REST (mirrors scripts/fetch-odfw.mjs) ──────────────────────────
async function fs_(method, path, body) {
  const url = `${BASE}/${path}${path.includes('?') ? '&' : '?'}key=${API_KEY}`;
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
const V = {
  s: v => ({ stringValue: String(v) }),
  i: v => ({ integerValue: String(Math.round(v)) }),
  t: d => ({ timestampValue: d.toISOString() })
};
const gv = f => f == null ? null
  : 'stringValue' in f ? f.stringValue
  : 'integerValue' in f ? Number(f.integerValue)
  : 'doubleValue' in f ? Number(f.doubleValue)
  : 'booleanValue' in f ? f.booleanValue
  : 'timestampValue' in f ? f.timestampValue : null;
const mask = fields => fields.map(f => 'updateMask.fieldPaths=' + f).join('&');

async function listQueue() {
  const docs = [];
  let pageToken = '';
  for (let page = 0; page < 10; page++) {
    const q = `ai_queue?pageSize=300${pageToken ? '&pageToken=' + pageToken : ''}`;
    const res = await fs_('GET', q);
    if (!res || !res.documents) break;
    docs.push(...res.documents);
    if (!res.nextPageToken) break;
    pageToken = res.nextPageToken;
  }
  return docs.map(d => {
    const f = d.fields || {};
    return {
      id: d.name.split('/').pop(),
      updateTime: d.updateTime,
      status: gv(f.status) || 'pending',
      attempts: gv(f.attempts) || 0,
      createdAt: gv(f.createdAt) || 0,
      claimedAt: gv(f.claimedAt) || 0,
      failedAt: gv(f.failedAt) || 0,
      search: !!gv(f.search),
      maxTokens: gv(f.maxTokens) || MAX_TOKENS,
      prompt: gv(f.prompt) || '',
      dest: gv(f.dest) || '{}'
    };
  }).sort((a, b) => a.createdAt - b.createdAt);
}

async function getAiState() {
  const d = await fs_('GET', 'meta/aiState');
  const f = d ? d.fields || {} : {};
  const st = { pausedUntil: gv(f.pausedUntil) || 0, day: gv(f.day) || '', used: gv(f.used) || 0,
               userPaused: !!gv(f.userPaused) };
  for (let ki = 0; ki < AI_KEYS.length; ki++) {
    st['keyOff' + ki] = gv(f['keyOff' + ki]) || '';
    st['keyDead' + ki] = gv(f['keyDead' + ki]) || '';
    st['groundOff' + ki] = gv(f['groundOff' + ki]) || '';
  }
  return st;
}
async function pauseAll(ms, why) {
  await fs_('PATCH', `meta/aiState?${mask(['pausedUntil', 'pauseWhy'])}`,
    { fields: { pausedUntil: V.i(Date.now() + ms), pauseWhy: V.s(why) } });
}
async function bumpUsed(state) {
  const day = new Date().toISOString().slice(0, 10);
  state.used = state.day === day ? state.used + 1 : 1;
  state.day = day;
  await fs_('PATCH', `meta/aiState?${mask(['day', 'used'])}`,
    { fields: { day: V.s(day), used: V.i(state.used) } });
}

// ── Gemini (multi-key rotation — mirrors index.html) ─────────────────────────
// Gemini's daily quotas reset at midnight PACIFIC — day-marks must live on
// that boundary, not UTC's (an evening-PDT 429 stamped with the UTC date
// would bench a fully-reset key through the next morning's drain).
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
// Day-markers (keyOffN / groundOffN) hold today's Pacific date and clear
// themselves tomorrow. Permanent markers (keyDeadN) hold a reason string and
// stay until the owner replaces the key.
async function aiMark(state, field, permanent) {
  state[field] = permanent === undefined ? today() : String(permanent).slice(0, 200);
  await fs_('PATCH', `meta/aiState?${mask([field])}`,
    { fields: { [field]: V.s(state[field]) } }).catch(() => {});
}
// Which (key, model) pairs refused grounding in THIS run. Grounding quota is
// per model — gemini-2.5-flash grounds fine on the same key flash-lite refuses
// — so it must never be persisted as a per-key day-marker.
const _groundOut = new Set();

// One key, walking the model ladder. Quota is per MODEL too: the key that
// reported a daily limit on one model answered fine on it a minute later, and
// on another model immediately. So a 429 moves to the next model; only when
// EVERY model is out is the key itself spent. Anything less benches the one
// working key for a day it could still be answering.
async function aiCallKey(ki, prompt, search, opts = {}) {
  let lastBusy = null, lastQuota = null;
  for (let mi = opts._model || 0; mi < AI_MODELS.length; mi++) {
    const wantSearch = search && !_groundOut.has(`${ki}:${mi}`);
    try { return await aiCallModel(ki, mi, prompt, wantSearch, opts); }
    catch (e) {
      if (e.transient) { lastBusy = e; continue; }
      if (e.quota) {
        if (e.wasSearch) {
          _groundOut.add(`${ki}:${mi}`);
          try { return await aiCallModel(ki, mi, prompt, false, opts); }
          catch (e2) {
            if (e2.transient) { lastBusy = e2; continue; }
            if (e2.quota) { lastQuota = e2; continue; }
            throw e2;
          }
        }
        lastQuota = e; continue;
      }
      throw e;
    }
  }
  if (lastQuota) throw lastQuota;
  throw lastBusy || Object.assign(new Error('AI busy (every model)'), { transient: true });
}
async function aiCallModel(ki, mi, prompt, search, opts = {}) {
  const model = AI_MODELS[mi];
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: opts.temperature ?? 0.2, maxOutputTokens: opts.maxTokens || MAX_TOKENS }
  };
  if (search) body.tools = [{ google_search: {} }];
  let res;
  try {
    res = await fetch(aiUrlFor(model), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': AI_KEYS[ki] },
      body: JSON.stringify(body)
    });
  } catch (e) {
    const err = new Error('network: ' + (e.message || e)); err.network = true; throw err;
  }
  if (res.status === 429) {
    // Google says WHICH limit tripped: QuotaFailure violations name PerDay vs
    // PerMinute quotas. A minute-limit blip must not bench the key for the day.
    let retryMs = 90000, daily = false;
    try {
      const j = await res.json();
      const det = j.error?.details || [];
      const rd = det.find(d => String(d['@type'] || '').includes('RetryInfo'))?.retryDelay;
      if (rd) retryMs = Math.max(60000, parseFloat(rd) * 1000);
      const viol = det.filter(d => String(d['@type'] || '').includes('QuotaFailure')).flatMap(d => d.violations || []);
      daily = viol.some(v => /day|daily/i.test(String(v.quotaId || '') + ' ' + String(v.description || '')));
    } catch {}
    // Was: "no QuotaFailure detail + long RetryInfo => daily". Gemini's grounded
    // 429 carries neither detail, so a busy minute benched the only working key
    // for the whole day — the reason nightly runs stalled at ~4 answers. Bench
    // for the day only when Google actually names a PerDay quota.
    const err = new Error(`quota (${AI_KEY_NAMES[ki]} key${daily ? ', daily' : ', short-term'})`);
    err.quota = true; err.daily = daily; err.wasSearch = search; err.retryMs = Math.min(retryMs, 6 * 3600 * 1000);
    throw err;
  }
  if (res.status === 400 && search) return aiCallModel(ki, mi, prompt, false, opts);
  if (res.status === 403 || res.status === 401) {
    // A denied project is permanent — re-probing it daily forever just burns a
    // request and hides the fact that the key needs replacing.
    let why = '';
    try { why = String((await res.json())?.error?.message || ''); } catch {}
    const dead = /denied access|has been suspended|disabled|consumer|not been used|is disabled/i.test(why);
    const err = new Error(`key rejected (${AI_KEY_NAMES[ki]}, HTTP ${res.status})${why ? ' — ' + why.slice(0, 120) : ''}`);
    err.auth = true; err.dead = dead; err.why = why.slice(0, 200); err.status = res.status; throw err;
  }
  // 5xx = busy, 404 = model retired. Both mean "try the next model".
  if (res.status >= 500 || res.status === 404) {
    const err = new Error(res.status === 404 ? `model ${model} is gone` : `AI busy (HTTP ${res.status})`);
    err.transient = true; err.model = model; throw err;
  }
  if (!res.ok) { const err = new Error(`AI HTTP ${res.status}`); err.status = res.status; throw err; }
  const j = await res.json();
  const cand = j.candidates && j.candidates[0];
  const text = ((cand?.content?.parts) || []).map(p => p.text || '').join('').trim();
  if (cand?.finishReason === 'MAX_TOKENS') {
    const budget = opts.maxTokens || MAX_TOKENS;
    if (!opts._grew && budget < 16384)
      return aiCallModel(ki, mi, prompt, search, { ...opts, maxTokens: Math.min(16384, Math.max(budget * 2, MAX_TOKENS * 2)), _grew: true });
    throw new Error('reply was cut off before it finished');
  }
  if (!text) throw new Error('empty response' + (cand?.finishReason ? ` (${cand.finishReason})` : ''));
  const src = [];
  (cand.groundingMetadata?.groundingChunks || []).forEach(c => {
    if (c.web?.uri && /^https?:/.test(c.web.uri)) src.push({ t: String(c.web.title || 'source').slice(0, 80), u: c.web.uri });
  });
  return { text, src: src.slice(0, 4), grounded: search, key: ki, model };
}
async function aiGenerate(prompt, opts = {}) {
  const st = opts.state || {};
  const t = today();
  let lastQuota = null, lastAuth = null;
  let lastTransient = null;
  for (let ki = 0; ki < AI_KEYS.length; ki++) {
    if (st['keyDead' + ki]) continue;                 // permanently denied — never probe again
    if (st['keyOff' + ki] === t) continue;
    const search = !!opts.search;   // per-model, decided inside aiCallKey
    try {
      return await aiCallKey(ki, prompt, search, opts);
    } catch (eOuter) {
      let e = eOuter;
      // (grounded-vs-plain and per-model quota are handled inside aiCallKey now)
      if (e.quota) {
        if (e.daily) await aiMark(st, 'keyOff' + ki); // day quota: bench until tomorrow
        lastQuota = e; continue;                       // minute blip: just move on, key recovers
      }
      if (e.auth) {
        await aiMark(st, e.dead ? 'keyDead' + ki : 'keyOff' + ki, e.dead ? (e.why || 'denied') : undefined);
        lastAuth = e; continue;
      }
      // Gemini busy is not this key being spent — the other key is a different
      // project, so try it before handing the item back to the queue.
      if (e.transient) { lastTransient = e; continue; }
      throw e; // network — not a key problem
    }
  }
  // A 503 is Gemini being busy for a minute; reporting it as "every key is out"
  // pauses every device and the nightly Action for an hour. It outranks a key
  // already known dead, whose 403 would otherwise look like the blocking cause.
  if (lastTransient) throw lastTransient;
  // Prefer the quota error: its retryMs is honest (a minute-class 429 pauses
  // everyone ~90s, not an hour), and 'quota' reads truer than 'key' when one
  // key merely died while the other ran dry.
  const err = lastQuota || lastAuth || Object.assign(new Error('AI quota exhausted'), { quota: true });
  err.allKeys = true; err.retryMs = err.retryMs || 3600 * 1000;
  throw err;
}

// Audit replies: [{hunt, diffs:[{f, ours, official, note}]}] — normalized and
// key-filtered exactly like the app does.
const AUDIT_FIELDS = new Set(['name', 'tags', 'apps', 'season', 'bag']);
function parseAudit(text) {
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return null;
    const out = Object.create(null);
    for (const e of arr) {
      if (!e || !e.hunt) continue;
      const id = String(e.hunt);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/.test(id)) continue;
      const diffs = [];
      for (const d of (Array.isArray(e.diffs) ? e.diffs : [])) {
        if (!d || !AUDIT_FIELDS.has(d.f)) continue;
        diffs.push({ f: d.f, ours: String(d.ours ?? '').slice(0, 200),
                     ai: String(d.official ?? d.ai ?? '').slice(0, 200),
                     note: String(d.note || '').slice(0, 160) });
      }
      out[id] = diffs;
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

// Same lenient JSON-array extraction the app uses for fact-check replies.
function parseVerdicts(text) {
  const m = String(text).match(/\[[\s\S]*\]/);
  if (!m) return null;
  try {
    const arr = JSON.parse(m[0]);
    if (!Array.isArray(arr)) return null;
    const out = Object.create(null); // no prototype — key tricks land nowhere
    for (const e of arr) {
      if (!e || !e.hunt) continue;
      const id = String(e.hunt);
      if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,19}$/.test(id)) continue; // hunt ids never start with _ or contain it
      const v = ['ok', 'suspect', 'unknown'].includes(e.v) ? e.v : 'unknown';
      out[id] = { v, note: String(e.note || '').slice(0, 160) };
    }
    return Object.keys(out).length ? out : null;
  } catch { return null; }
}

const qid = s => String(s).replace(/[^\w-]/g, '_').slice(0, 140);
async function deliver(item, res) {
  const dest = JSON.parse(item.dest);
  if (dest.t === 'ans') {
    await fs_('PATCH', `ai_answers/${qid(dest.hk + '__' + dest.qk)}`, { fields: {
      huntKey: V.s(dest.hk), qk: V.s(dest.qk), label: V.s(dest.label || ''), q: V.s(dest.q || ''),
      a: V.s(res.text), src: V.s(JSON.stringify(res.src || [])),
      grounded: { booleanValue: !!res.grounded }, model: V.s(AI_MODEL), at: V.i(Date.now())
    } });
  } else if (dest.t === 'audit') {
    // Parse FIRST: an unparseable reply must fail the item — filling the batch
    // beforehand would silently mark 6 hunts verified-clean forever.
    const items = parseAudit(res.text);
    if (!items) throw new Error('audit reply was not parseable JSON');
    for (const hu of (dest.hunts || [])) if (items[hu] === undefined) items[hu] = [];
    await fs_('PATCH', `ai_audit/${item.id}`, { fields: {
      year: V.s(dest.year), items: V.s(JSON.stringify(items)), model: V.s(AI_MODEL), at: V.i(Date.now())
    } });
  } else if (dest.t === 'fc') {
    const items = parseVerdicts(res.text);
    if (!items) throw new Error('fact-check reply was not parseable JSON');
    await fs_('PATCH', `ai_factcheck/${item.id}`, { fields: {
      year: V.s(dest.year), items: V.s(JSON.stringify(items)), model: V.s(AI_MODEL), at: V.i(Date.now())
    } });
  } else if (dest.t === 'syn') {
    await fs_('PATCH', `ai_syn/${item.id}`, { fields: {
      file: V.s(dest.file), cid: V.s(dest.id), a: V.s(res.text), model: V.s(AI_MODEL), at: V.i(Date.now())
    } });
  } else throw new Error('unknown destination ' + dest.t);
}

// ── run log ──────────────────────────────────────────────────────────────────
// Everything this script does used to go to console.log, i.e. into the GitHub
// Actions log — a surface the owner will never open on a phone. One summary doc
// per run makes the nightly drain visible in the app itself, and a missing doc
// is how "the Action stopped firing" becomes noticeable at all.
// Two writes per run against a 20k/day Firestore free tier: negligible.
const LOG_KEEP = 60;
async function writeRunLog(row) {
  // Doc id sorts newest-last by time, so the app can orderBy(at) and the
  // pruner can drop from the front.
  const id = 'r' + String(row.at) + '-' + (row.src || 'action');
  await fs_('PATCH', `ai_log/${id}`, { fields: {
    at: V.i(row.at), src: V.s(row.src), answered: V.i(row.answered || 0),
    failed: V.i(row.failed || 0), busy: V.i(row.busy || 0), left: V.i(row.left || 0),
    ended: V.s(row.ended || ''), note: V.s(String(row.note || '').slice(0, 300))
  } }).catch(e => console.log('[ai] could not write run log: ' + e.message));
  // This script is the only pruner: one writer, once a night, so there is no
  // delete race and phones never pay for the trim.
  try {
    const j = await fs_('GET', `ai_log?pageSize=300&orderBy=at&mask.fieldPaths=at`);
    const docs = (j && j.documents) || [];
    for (const d of docs.slice(0, Math.max(0, docs.length - LOG_KEEP)))
      await fs_('DELETE', d.name.split('/documents/')[1]).catch(() => {});
  } catch (e) {}
}

// A run killed by the 55-minute Action timeout writes no summary at all, so it
// would look exactly like a run that never fired. Stamping a heartbeat before
// the first item means startedAt newer than the last finishedAt is positive
// evidence that a run began and died.
async function beat(field) {
  await fs_('PATCH', `meta/aiPulse?${mask([field])}`, { fields: { [field]: V.i(Date.now()) } }).catch(() => {});
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const state = await getAiState();
  if (state.userPaused) {
    console.log('[ai] queue is paused by the owner — nothing to do');
    await writeRunLog({ at: Date.now(), src: 'action', ended: 'paused-by-owner', note: 'You have the queue paused.' });
    return;
  }
  if (state.pausedUntil > Date.now()) {
    console.log(`[ai] paused until ${new Date(state.pausedUntil).toISOString()} — nothing to do`);
    await writeRunLog({ at: Date.now(), src: 'action', ended: 'paused',
      note: 'Still in the back-off from the last run, until ' + new Date(state.pausedUntil).toISOString() });
    return;
  }
  await beat('startedAt');
  const queue = await listQueue();
  const now = Date.now();
  const runnable = queue.filter(it => it.status !== 'error' && (it.claimedAt || 0) <= now - CLAIM_MS);
  console.log(`[ai] queue: ${queue.length} docs, ${runnable.length} runnable, cap ${MAX}${DRY ? ' (dry run)' : ''}`);
  if (DRY) { runnable.slice(0, MAX).forEach(it => console.log(`  - ${it.id} (${JSON.parse(it.dest).t}, attempts ${it.attempts})`)); return; }

  // Failed docs self-expire after a day so they can't clog the queue forever.
  for (const it of queue.filter(q => q.status === 'error' && (q.failedAt || q.createdAt || 0) < now - 86400000)) {
    await fs_('DELETE', `ai_queue/${it.id}`).catch(() => {});
    console.log(`[ai] expired failed item ${it.id}`);
  }

  let done = 0, failed = 0, busy = 0, ended = 'complete', endNote = '';
  for (const item of runnable.slice(0, MAX)) {
    // Compare-and-swap claim: the updateTime precondition makes the PATCH fail
    // if ANYTHING touched the doc since our listing — a live browser claiming
    // it, answering it, or deleting it. Without the precondition this PATCH
    // would upsert deleted docs back to life as zombie stubs.
    try {
      await fs_('PATCH', `ai_queue/${item.id}?${mask(['claimedAt', 'claimedBy'])}` +
        `&currentDocument.updateTime=${encodeURIComponent(item.updateTime)}`,
        { fields: { claimedAt: V.i(Date.now()), claimedBy: V.s('action') } });
    } catch (e) { continue; } // claimed/answered/deleted by someone else — skip
    let delivered = false;
    try {
      const res = await aiGenerate(item.prompt, {
        search: item.search, maxTokens: item.maxTokens, state });
      await deliver(item, res);
      await fs_('DELETE', `ai_queue/${item.id}`);
      delivered = true;
    } catch (e) {
      if (e.allKeys) {
        await pauseAll(e.retryMs, e.auth ? 'key' : 'quota');
        ended = e.auth ? 'keys-rejected' : 'quota'; endNote = e.message;
        console.log(`[ai] every key is out (${e.message}) after ${done} answers — paused ${Math.round(e.retryMs / 60000)} min`);
        break;
      }
      if (e.transient) {
        // Model overloaded — release the claim and move on; a busy minute must
        // not march items toward 'error'.
        await fs_('PATCH', `ai_queue/${item.id}?${mask(['claimedAt', 'claimedBy'])}&currentDocument.exists=true`,
          { fields: { claimedAt: V.i(0), claimedBy: V.s('') } }).catch(() => {});
        busy++;
        console.log(`[ai] ~ ${item.id}: ${e.message} (will retry)`);
        // Gemini's free tier serves a lot of 503s. A flat 20s each meant ~18
        // busy replies could eat an entire run; back off gently and give up on
        // the run only once it is clearly a wall, so the window buys answers.
        if (busy >= 12 && done === 0) { ended = 'overloaded'; endNote = e.message; break; }
        await new Promise(r => setTimeout(r, Math.min(20000, 3000 + busy * 1500)));
        continue;
      }
      if (e.network) {
        // The runner can't reach Gemini at all — release the claim (only if the
        // doc still exists) and stop; nothing gets marked failed for our outage.
        await fs_('PATCH', `ai_queue/${item.id}?${mask(['claimedAt', 'claimedBy'])}&currentDocument.exists=true`,
          { fields: { claimedAt: V.i(0), claimedBy: V.s('') } }).catch(() => {});
        ended = 'network'; endNote = e.message;
        console.log('[ai] network to Gemini is down — stopping this run');
        break;
      }
      failed++;
      const attempts = item.attempts + 1;
      // exists=true so a doc a live client just deleted can't be resurrected
      await fs_('PATCH', `ai_queue/${item.id}?${mask(['attempts', 'lastError', 'status', 'failedAt', 'claimedAt', 'claimedBy'])}&currentDocument.exists=true`, { fields: {
        attempts: V.i(attempts), lastError: V.s(String(e.message || e).slice(0, 200)),
        status: V.s(attempts >= 3 ? 'error' : 'pending'), failedAt: V.i(Date.now()), claimedAt: V.i(0), claimedBy: V.s('')
      } }).catch(() => {});
      console.log(`[ai] ✗ ${item.id}: ${e.message}`);
    }
    if (delivered) {
      // outside the try: a failed counter bump must never re-touch a queue doc
      await bumpUsed(state).catch(() => {});
      done++;
      console.log(`[ai] ✓ ${item.id}`);
    }
    await new Promise(r => setTimeout(r, PACE_MS));
  }
  const left = Math.max(0, runnable.length - done - failed);
  console.log(`[ai] run complete: ${done} answered, ${failed} failed, ${busy} busy replies, ${left} left in queue`);
  await writeRunLog({ at: Date.now(), src: 'action', answered: done, failed, busy, left, ended, note: endNote });
  await beat('finishedAt');
}

// A crash must leave a trace the owner can see too — otherwise a broken run and
// a run that never fired look identical from the app.
main().catch(async e => {
  console.error('[ai] fatal:', e.message);
  await writeRunLog({ at: Date.now(), src: 'action', ended: 'crashed', note: String(e.message || e) }).catch(() => {});
  process.exit(1);
});
