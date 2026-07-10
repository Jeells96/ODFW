// ODFW Auto-Updater — fetches Preference Point Draw Reports from myodfw.com,
// parses them with the same logic as the app, and syncs to Firestore.
// Runs via GitHub Actions (see .github/workflows/odfw-fetch.yml).
//
// Usage:
//   node scripts/fetch-odfw.mjs              live run
//   node scripts/fetch-odfw.mjs --dry        fetch + parse, print plan, write nothing
//   node scripts/fetch-odfw.mjs --local f.xlsx --species deer --year 2026 --dry
//                                            parse a local file (testing)
import * as XLSX from 'xlsx';
import { readFileSync } from 'fs';

const PROJECT = 'oregon-hunting';
const API_KEY = 'AIzaSyCqbU875vWyWS0dQWr0hoqVRscH2AtU_v4';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const SOURCE_PAGE = 'https://myodfw.com/articles/point-summary-reports';
const CHUNK = 150;

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const arg = k => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : null; };

// ── Parsing (mirrors index.html v2.3 exactly) ────────────────────────────────
function weapon(num, name) {
  const n = String(num || '').toUpperCase(), na = String(name || '').toLowerCase();
  if (na.includes('youth')) return 'youth';
  if (na.includes('muzzleload')) return 'muzz';
  if (na.includes('archery') || na.includes('bow') || na.includes('trad')) return 'archery';
  if (/\dT\d*$/.test(n)) return 'youth';
  if (/\dM\d*$/.test(n)) return 'muzz';
  if (/\dR\d*$/.test(n)) return 'archery';
  return 'rifle';
}
function derive(h) {
  h.pointBreakdown.sort((a, b) => b.points - a.points);
  let pts100 = null, minPts = null;
  for (const p of h.pointBreakdown) {
    if (p.resDrawn > 0) minPts = p.points;
    if (p.resApps > 0 && p.resDrawn >= p.resApps) pts100 = p.points;
  }
  h.pts100 = pts100;
  h.minPointsToDraw = minPts;
  h.resOdds = h.residentApps > 0 ? (h.residentDrawn / h.residentApps) * 100 : null;
}
function parseHunts(buf, sp) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  let ws = null;
  for (const n of wb.SheetNames) { if (/draw|point/i.test(n)) { ws = wb.Sheets[n]; break; } }
  if (!ws) ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const joined = (rows[i] || []).map(c => String(c ?? '')).join(' ');
    if (/hunt choice/i.test(joined) || /1st Choice/i.test(joined))
      throw new Error('wrong report type (Applicants by Hunt Choice)');
  }
  const byNum = new Map(); let last = null;
  const isNum = v => typeof v === 'number' && isFinite(v);
  for (const r of rows) {
    if (!r || !r.length) continue;
    const hasId = r[0] !== null && r[0] !== undefined && String(r[0]).trim() !== '';
    const hasName = typeof r[1] === 'string' && r[1].trim() !== '';
    if (hasId && hasName && isNum(r[2])) {
      const key = String(r[0]).trim();
      let h = byNum.get(key);
      if (!h) {
        h = { huntNum: key, huntName: String(r[1]).trim(), tags: Number(r[2]) || 0,
          residentApps: Number(r[3]) || 0, residentDrawn: Number(r[4]) || 0,
          nonResidentApps: Number(r[5]) || 0, nonResidentDrawn: Number(r[6]) || 0,
          totalApps: Number(r[7]) || 0, totalDrawn: Number(r[8]) || 0,
          species: sp, weapon: weapon(key, r[1]), pointBreakdown: [], harvest: null };
        byNum.set(key, h);
      }
      last = h;
      if (isNum(r[12]) && !h.pointBreakdown.some(p => p.points === Number(r[12])))
        h.pointBreakdown.push({ points: Number(r[12]), apps: Number(r[13]) || 0, resApps: Number(r[14]) || 0, resDrawn: Number(r[15]) || 0, nrApps: Number(r[16]) || 0, nrDrawn: Number(r[17]) || 0 });
    } else if (last && isNum(r[12])) {
      if (!last.pointBreakdown.some(p => p.points === Number(r[12])))
        last.pointBreakdown.push({ points: Number(r[12]), apps: Number(r[13]) || 0, resApps: Number(r[14]) || 0, resDrawn: Number(r[15]) || 0, nrApps: Number(r[16]) || 0, nrDrawn: Number(r[17]) || 0 });
    }
  }
  const hunts = [...byNum.values()];
  hunts.forEach(derive);
  if (!hunts.length) throw new Error('no hunts parsed');
  return hunts;
}

// ── Firestore REST helpers (open rules — API key only) ───────────────────────
async function fs_(method, path, body) {
  const url = `${BASE}/${path}${path.includes('?') ? '&' : '?'}key=${API_KEY}`;
  const res = await fetch(url, {
    method, headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
const V = {
  s: v => ({ stringValue: String(v) }),
  i: v => ({ integerValue: String(v) }),
  t: d => ({ timestampValue: d.toISOString() })
};
const gv = f => f == null ? null
  : 'stringValue' in f ? f.stringValue
  : 'integerValue' in f ? Number(f.integerValue)
  : 'timestampValue' in f ? f.timestampValue : null;

async function loadExistingHunts(year) {
  const doc = await fs_('GET', `years/${year}`);
  if (!doc) return { exists: false, hunts: [], chunkCount: 0 };
  const chunkCount = Number(gv(doc.fields?.chunkCount) || 0);
  let hunts = [];
  for (let ci = 0; ci < chunkCount; ci++) {
    const cd = await fs_('GET', `years/${year}/chunks/${ci}`);
    if (cd) hunts = hunts.concat(JSON.parse(gv(cd.fields?.hunts) || '[]'));
  }
  return { exists: true, hunts, chunkCount };
}

async function writeYear(year, hunts, oldChunkCount) {
  const chunks = [];
  for (let i = 0; i < hunts.length; i += CHUNK) chunks.push(hunts.slice(i, i + CHUNK));
  await fs_('PATCH', `years/${year}`, { fields: {
    year: V.s(year), huntCount: V.i(hunts.length), chunkCount: V.i(chunks.length), updatedAt: V.t(new Date())
  }});
  for (let ci = 0; ci < chunks.length; ci++)
    await fs_('PATCH', `years/${year}/chunks/${ci}`, { fields: { hunts: V.s(JSON.stringify(chunks[ci])) } });
  for (let ci = chunks.length; ci < oldChunkCount; ci++)
    await fs_('DELETE', `years/${year}/chunks/${ci}`).catch(() => {});
}

async function getMeta(year, key) {
  const d = await fs_('GET', `years/${year}/pdfMeta/${key}`);
  return d ? { fileName: gv(d.fields?.fileName), source: gv(d.fields?.source) } : null;
}
async function setMeta(year, key, fileName, huntCount) {
  await fs_('PATCH', `years/${year}/pdfMeta/${key}`, { fields: {
    fileName: V.s(fileName), huntCount: V.i(huntCount), uploadedAt: V.t(new Date()), source: V.s('auto')
  }});
}
async function setStatus(summary, details) {
  await fs_('PATCH', `meta/autoUpdate`, { fields: {
    lastRun: V.t(new Date()), lastRunStr: V.s(new Date().toLocaleDateString('en-US')),
    summary: V.s(summary), details: V.s(details.join(' | ') || '—')
  }});
}

// ── Link discovery on the ODFW point summary page ────────────────────────────
function findReports(html, pageUrl) {
  const found = [];
  const re = /href\s*=\s*["']([^"']*\.xlsx[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let url = m[1];
    try { url = new URL(url, pageUrl).href; } catch { continue; }
    const fname = decodeURIComponent(url.split('/').pop() || '');
    if (!/preference[\s_-]*point[\s_-]*draw[\s_-]*report/i.test(fname)) continue;
    const ym = fname.match(/(20\d{2})/);
    if (!ym) continue;
    const year = ym[1];
    let species = null;
    if (/elk/i.test(fname)) species = 'elk';
    else if (/deer/i.test(fname) && !/antlerless/i.test(fname)) species = 'deer';
    if (!species) continue; // skip antelope, sheep, goat, bear, antlerless deer
    found.push({ url, fname, year, species });
  }
  // Newest year wins per species
  const best = {};
  for (const f of found) {
    const k = f.species + f.year;
    if (!best[k]) best[k] = f;
  }
  return Object.values(best);
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const details = [];
  let updated = 0;

  // Local test mode
  if (arg('--local')) {
    const hunts = parseHunts(readFileSync(arg('--local')), arg('--species') || 'deer');
    console.log(`[local] parsed ${hunts.length} ${arg('--species')} hunts for ${arg('--year')}`);
    console.log('[local] sample:', JSON.stringify(hunts[0]).slice(0, 220));
    if (DRY) return;
    const year = arg('--year');
    const { hunts: existing, chunkCount } = await loadExistingHunts(year);
    const merged = existing.filter(h => h.species !== (arg('--species') || 'deer')).concat(hunts);
    await writeYear(year, merged, chunkCount);
    await setMeta(year, (arg('--species') === 'elk' ? 'elkPoints' : 'deerPoints'), arg('--local').split('/').pop(), hunts.length);
    console.log(`[local] wrote ${merged.length} hunts to Firestore year ${year}`);
    return;
  }

  console.log('[fetch]', SOURCE_PAGE);
  const res = await fetch(SOURCE_PAGE, { headers: { 'User-Agent': 'Mozilla/5.0 (ODFW-planner-bot; personal use)' } });
  if (!res.ok) throw new Error(`page fetch failed: ${res.status}`);
  const reports = findReports(await res.text(), SOURCE_PAGE);
  console.log(`[fetch] found ${reports.length} draw report link(s)`);
  reports.forEach(r => console.log(`  ${r.year} ${r.species}: ${r.fname}`));

  if (!reports.length) {
    details.push('no draw report links found on page — layout may have changed');
    if (!DRY) await setStatus('checked ODFW — no reports found', details);
    return;
  }

  for (const r of reports) {
    const key = r.species === 'elk' ? 'elkPoints' : 'deerPoints';
    try {
      const meta = await getMeta(r.year, key);
      if (meta && meta.fileName === r.fname) {
        console.log(`[skip] ${r.year} ${key}: already loaded (${r.fname})`);
        details.push(`${r.year} ${r.species}: up to date`);
        continue;
      }
      if (meta && meta.source !== 'auto') {
        // A manual upload exists with a different filename — don't clobber it
        // unless the ODFW file is clearly the same year's official report.
        console.log(`[note] ${r.year} ${key}: manual upload present (${meta.fileName}); replacing with official ${r.fname}`);
      }
      console.log(`[dl] ${r.url}`);
      const fres = await fetch(r.url, { headers: { 'User-Agent': 'Mozilla/5.0 (ODFW-planner-bot; personal use)' } });
      if (!fres.ok) throw new Error(`download failed: ${fres.status}`);
      const buf = Buffer.from(await fres.arrayBuffer());
      const hunts = parseHunts(buf, r.species);
      console.log(`[parse] ${r.year} ${r.species}: ${hunts.length} hunts`);
      if (DRY) { details.push(`${r.year} ${r.species}: would load ${hunts.length} hunts`); continue; }
      const { hunts: existing, chunkCount } = await loadExistingHunts(r.year);
      const merged = existing.filter(h => h.species !== r.species).concat(hunts);
      await writeYear(r.year, merged, chunkCount);
      await setMeta(r.year, key, r.fname, hunts.length);
      details.push(`${r.year} ${r.species}: loaded ${hunts.length} hunts`);
      updated++;
    } catch (e) {
      console.error(`[err] ${r.year} ${r.species}:`, e.message);
      details.push(`${r.year} ${r.species}: ERROR ${e.message}`);
    }
  }

  const summary = updated ? `loaded ${updated} new report(s)` : 'checked ODFW — data already current';
  console.log('[done]', summary);
  if (!DRY) await setStatus(summary, details);
}

main().catch(async e => {
  console.error('[fatal]', e);
  try { if (!DRY) await setStatus('run failed: ' + e.message, []); } catch {}
  process.exit(1);
});
