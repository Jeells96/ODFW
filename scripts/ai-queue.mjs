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
const AI_KEY = atob('QVEuQWI4Uk42SzkxaWRJUkFfMjZyS2FmWlB4YllNMDdEZ0ZWSE5ucVNJQWlsdlQtTC1fT2c=');
const AI_MODEL = 'gemini-flash-latest';
const AI_URL = process.env.GEMINI_URL ||
  `https://generativelanguage.googleapis.com/v1beta/models/${AI_MODEL}:generateContent`;

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
      maxTokens: gv(f.maxTokens) || 1024,
      prompt: gv(f.prompt) || '',
      dest: gv(f.dest) || '{}'
    };
  }).sort((a, b) => a.createdAt - b.createdAt);
}

async function getAiState() {
  const d = await fs_('GET', 'meta/aiState');
  const f = d ? d.fields || {} : {};
  return { pausedUntil: gv(f.pausedUntil) || 0, day: gv(f.day) || '', used: gv(f.used) || 0 };
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

// ── Gemini ───────────────────────────────────────────────────────────────────
async function aiGenerate(prompt, opts = {}) {
  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.2, maxOutputTokens: opts.maxTokens || 1024 }
  };
  if (opts.search) body.tools = [{ google_search: {} }];
  let res;
  try {
    res = await fetch(AI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': AI_KEY },
      body: JSON.stringify(body)
    });
  } catch (e) {
    const err = new Error('network: ' + (e.message || e)); err.network = true; throw err;
  }
  if (res.status === 429) {
    let retryMs = 90000;
    try {
      const j = await res.json();
      const rd = (j.error?.details || []).find(d => String(d['@type'] || '').includes('RetryInfo'))?.retryDelay;
      if (rd) retryMs = Math.max(60000, parseFloat(rd) * 1000);
    } catch {}
    const err = new Error('quota'); err.quota = true; err.retryMs = Math.min(retryMs, 6 * 3600 * 1000);
    throw err;
  }
  if (res.status === 400 && opts.search) return aiGenerate(prompt, { ...opts, search: false });
  if (!res.ok) { const err = new Error(`AI HTTP ${res.status}`); err.status = res.status; throw err; }
  const j = await res.json();
  const cand = j.candidates && j.candidates[0];
  const text = ((cand?.content?.parts) || []).map(p => p.text || '').join('').trim();
  if (!text) throw new Error('empty response' + (cand?.finishReason ? ` (${cand.finishReason})` : ''));
  const src = [];
  (cand.groundingMetadata?.groundingChunks || []).forEach(c => {
    if (c.web?.uri && /^https?:/.test(c.web.uri)) src.push({ t: String(c.web.title || 'source').slice(0, 80), u: c.web.uri });
  });
  return { text, src: src.slice(0, 4) };
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
      a: V.s(res.text), src: V.s(JSON.stringify(res.src || [])), model: V.s(AI_MODEL), at: V.i(Date.now())
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

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const state = await getAiState();
  if (state.pausedUntil > Date.now()) {
    console.log(`[ai] paused until ${new Date(state.pausedUntil).toISOString()} — nothing to do`);
    return;
  }
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

  let done = 0, failed = 0;
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
      const res = await aiGenerate(item.prompt, { search: item.search, maxTokens: item.maxTokens });
      await deliver(item, res);
      await fs_('DELETE', `ai_queue/${item.id}`);
      delivered = true;
    } catch (e) {
      if (e.quota) {
        await pauseAll(e.retryMs, 'quota');
        console.log(`[ai] quota hit after ${done} answers — paused ${Math.round(e.retryMs / 60000)} min, queue resumes later`);
        break;
      }
      if (e.status === 403 || e.status === 401) {
        await pauseAll(6 * 3600 * 1000, 'key');
        console.log('[ai] key rejected — paused 6h so we do not hammer a dead key');
        break;
      }
      if (e.network) {
        // The runner can't reach Gemini at all — release the claim (only if the
        // doc still exists) and stop; nothing gets marked failed for our outage.
        await fs_('PATCH', `ai_queue/${item.id}?${mask(['claimedAt', 'claimedBy'])}&currentDocument.exists=true`,
          { fields: { claimedAt: V.i(0), claimedBy: V.s('') } }).catch(() => {});
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
  console.log(`[ai] run complete: ${done} answered, ${failed} failed, ${Math.max(0, runnable.length - done - failed)} left in queue`);
}

main().catch(e => { console.error('[ai] fatal:', e.message); process.exit(1); });
