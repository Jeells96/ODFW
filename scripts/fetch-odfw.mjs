// ODFW Auto-Updater v2 — draw reports (XLSX) + harvest statistics (PDF).
// Runs monthly via GitHub Actions. Fails safe: bad parses are never written.
//
//   node scripts/fetch-odfw.mjs          live run
//   node scripts/fetch-odfw.mjs --dry    fetch + parse, write nothing
import * as XLSX from 'xlsx';
import pdfjs from 'pdfjs-dist/legacy/build/pdf.js';
const { getDocument } = pdfjs;

const PROJECT = 'oregon-hunting';
const API_KEY = 'AIzaSyCqbU875vWyWS0dQWr0hoqVRscH2AtU_v4';
const BASE = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const DRAW_PAGE = 'https://myodfw.com/articles/point-summary-reports';
const HARVEST_PAGE = 'https://myodfw.com/articles/big-game-hunting-harvest-statistics';
const CHUNK = 150;
const UA = { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9' };
async function fetchRetry(url, opts) {
  let res = await fetch(url, opts);
  if (!res.ok && res.status !== 404) {
    await new Promise(r => setTimeout(r, 4000));
    res = await fetch(url, opts);
  }
  return res;
}
const DRY = process.argv.includes('--dry');

// ═══ Shared classification (mirrors index.html) ═══════════════════════════════
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
  h.pts100 = pts100; h.minPointsToDraw = minPts;
  h.resOdds = h.residentApps > 0 ? (h.residentDrawn / h.residentApps) * 100 : null;
}

// ═══ Draw report XLSX parser (handles pre-2026 and 2026+ layouts) ═════════════
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

// ═══ Harvest PDF parser (line-based, aggregating, validated) ══════════════════
const ID_RE = /^(\d{3}(?:[A-Z]\d{0,2})?|[A-Z]{2}\d{3}(?:[A-Z]\d{0,2}|-\d)?)$/;
const NUM_RE = /^\d{1,6}$/;

async function pdfToLines(buf) {
  const doc = await getDocument({ data: new Uint8Array(buf), useSystemFonts: true }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const rows = new Map();
    for (const it of tc.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5] / 3) * 3;
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ x: it.transform[4], str: it.str.trim() });
    }
    for (const y of [...rows.keys()].sort((a, b) => b - a)) {
      const items = rows.get(y).sort((a, b) => a.x - b.x);
      lines.push(items.map(i => i.str).join(' ').replace(/\s+/g, ' ').trim());
    }
  }
  return lines;
}

function parseHarvestLines(lines, defaultK) {
  const all = lines.join('\n');
  let k = defaultK;
  if (/6\s*pt\s*\+/i.test(all)) k = 11;
  else if (/4\s*\+\s*pt/i.test(all)) k = 9;
  const agg = new Map();
  for (const raw of lines) {
    const line = raw.trim();
    const pm = line.match(/(\d+)\s*%$/);
    if (!pm) continue;
    const toks = line.replace(/\s*\d+\s*%$/, '').trim().split(/\s+/);
    let id = null, idIdx = -1;
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i];
      if (ID_RE.test(t)) { id = t; idIdx = i; break; }
      if (NUM_RE.test(t)) break;
      if (/^general$/i.test(t) || t === 'w/') break;
    }
    if (!id) continue;
    const nums = [];
    for (let i = idIdx + 1; i < toks.length; i++)
      if (NUM_RE.test(toks[i])) nums.push(Number(toks[i]));
    if (nums.length < k) continue;
    const n = nums.slice(-k);
    let hu, da, al, tb, th, sp, t2, t3, t4, t5, t6;
    if (k === 11) [hu, da, al, tb, th, sp, t2, t3, t4, t5, t6] = n;
    else { [hu, da, al, tb, th, sp, t2, t3, t4] = n.slice(0, 9); t5 = 0; t6 = 0; }
    const cur = agg.get(id) || { huntNum: id, hunters: 0, days: 0, antlerless: 0,
      totalBull: 0, totalHarvest: 0, spike: 0, twoPt: 0, threePt: 0, fourPt: 0, fivePt: 0, sixPlusPt: 0 };
    cur.hunters += hu; cur.days += da; cur.antlerless += al; cur.totalBull += tb;
    cur.totalHarvest += th; cur.spike += sp; cur.twoPt += t2; cur.threePt += t3;
    cur.fourPt += t4; cur.fivePt += t5; cur.sixPlusPt += t6;
    agg.set(id, cur);
  }
  const out = {};
  for (const [id, h] of agg) {
    h.successPct = h.hunters > 0 ? Math.round((h.totalHarvest / h.hunters) * 100) : 0;
    h.antlerValid = (h.spike + h.twoPt + h.threePt + h.fourPt + h.fivePt + h.sixPlusPt) > 0;
    out[id] = h;
  }
  return out;
}

function validateHarvest(out, knownIds) {
  const ids = Object.keys(out);
  // Muzzleloader seasons genuinely have few hunts (often 10-15), so the floor
  // is low; the ID-match check below is what actually guards against garbage.
  if (ids.length < 8) return { ok: false, reason: `only ${ids.length} hunts parsed` };
  const sane = ids.filter(id => out[id].successPct >= 0 && out[id].successPct <= 150).length;
  if (sane / ids.length < 0.9) return { ok: false, reason: 'success rates out of range' };
  if (knownIds && knownIds.size) {
    const match = ids.filter(id => knownIds.has(id)).length;
    if (match / ids.length < 0.4) return { ok: false, reason: `only ${match}/${ids.length} IDs match draw data` };
  }
  return { ok: true, count: ids.length };
}

// ═══ Season dates + bag limits (eRegulations hunt tables) ═════════════════════
const SEASON_PAGES = [
  { url: 'https://www.eregulations.com/oregon/hunting/buck-deer-seasons', species: 'deer' },
  { url: 'https://www.eregulations.com/oregon/hunting/elk-seasons', species: 'elk' }
];
const strip = s => s.replace(/<br\s*\/?>/gi, ' — ').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

function parseSeasonTables(html, forcedYear) {
  // eRegulations serves HTML <table>s where each cell wraps content in <p> tags:
  //   <td><p>210</p></td> <td><p>Saddle Mtn Unit</p></td> <td><p>One antlerless elk</p></td>
  //   <td><p>Dec. 1 - Mar. 31, 2027</p></td> <td><p>11</p></td> <td><p>707</p></td>
  // Fine print (weapon restrictions, "See NWR pg. 90", subunit notes) rides
  // inside the Hunt Name and Bag Limit cells, split off by <br> or </p><p>.
  const out = {};
  let year = forcedYear || null;

  const idRe = /^(\d{3}(?:[A-Z]\d{0,2})?|[A-Z]{2}\d{3}(?:[A-Z]\d{0,2}|-\d)?)$/;
  // full text of a cell, tags gone
  const cellText = td => td
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/[*\u2020\u2021]/g, '')
    .replace(/\s+/g, ' ').trim();
  // cell split into segments at <br> and paragraph boundaries — first segment is
  // the main value (name / bag limit), later segments are notes
  const cellSegs = td => td
    .replace(/<\/p>\s*<p[^>]*>/gi, '\u0001').replace(/<br\s*\/?>/gi, '\u0001')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').replace(/[*\u2020\u2021]/g, '')
    .split('\u0001').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);

  const tables = html.match(/<table[\s\S]*?<\/table>/gi) || [];
  for (const tbl of tables) {
    const rows = tbl.match(/<tr[\s\S]*?<\/tr>/gi) || [];
    let cols = null;
    for (const row of rows) {
      const rawCells = row.match(/<t[hd][\s\S]*?<\/t[hd]>/gi) || [];
      const cells = rawCells.map(cellText);
      if (!cells.length) continue;
      const hi = cells.findIndex(c => /^hunt\s*#/i.test(c));
      if (hi >= 0) {
        cols = { id: hi,
          name: cells.findIndex(c => /hunt\s*name/i.test(c)),
          bag: cells.findIndex(c => /bag\s*limit/i.test(c)),
          season: cells.findIndex(c => /open\s*season/i.test(c)) };
        if (!year) { const yc = cells.find(c => /20\d{2}\s*tags/i.test(c)); if (yc) year = yc.match(/(20\d{2})/)[1]; }
        continue;
      }
      if (!cols || cols.season < 0) continue;
      const id = (cells[cols.id] || '').split(' ')[0];
      if (!idRe.test(id)) continue;
      const season = (cells[cols.season] || '').trim();
      if (!season || !/[A-Za-z]{3}/.test(season)) continue;
      // bag limit = first segment of the bag cell; the rest are notes
      const bagSegs = cols.bag >= 0 ? cellSegs(rawCells[cols.bag] || '') : [];
      const bag = bagSegs[0] || '';
      const nameSegs = cols.name >= 0 ? cellSegs(rawCells[cols.name] || '') : [];
      // Collect notes: parenthetical/See/weapon-restriction text from name & bag
      // cells (skip the plain unit name itself and the bag limit itself).
      const notes = [...nameSegs.slice(1), ...bagSegs.slice(1)]
        .map(s => s.trim())
        .filter(s => s.length > 3 && /[a-z]/i.test(s));
      // also catch inline parentheticals like "(Shotgun/Muzzleloader Only)" left in the name
      const nameInline = (cells[cols.name] || '').match(/\(([^)]+)\)/g);
      if (nameInline) nameInline.forEach(p => { const t = p.replace(/[()]/g, '').trim(); if (t.length > 3) notes.push(t); });
      if (!out[id]) out[id] = { s: season, b: bag, n: [...new Set(notes)].join(' • ') };
    }
  }
  return { year: year || null, map: out };
}

async function updateSeasons(details, getYear) {
  let updated = 0;
  const merged = {}; // year -> {huntNum:{s,b}}
  for (const pg of SEASON_PAGES) {
    try {
      console.log('[seasons] fetching', pg.url);
      const res = await fetchRetry(pg.url, { headers: UA });
      console.log(`[seasons] ${pg.species} HTTP ${res.status} ${res.headers.get('content-type')||''}`);
      if (!res.ok) throw new Error(`page ${res.status} (site may be blocking robots)`);
      const now = new Date();
      const regsYear = String(now.getUTCMonth() >= 6 ? now.getUTCFullYear() + 1 : now.getUTCFullYear());
      const rawHtml = await res.text();
      // DIAGNOSTICS: what did the robot actually receive?
      const htmlTables = (rawHtml.match(/<table/gi) || []).length;
      const pipeRows = (rawHtml.match(/^\s*\|.*\|.*$/gm) || []).length;
      const huntHdr = /hunt\s*#/i.test(rawHtml);
      const has210 = /\b210[A-Z]?\d?\b/.test(rawHtml);
      const hasSpike = /spike\s*(?:bull\s*)?elk|spike\s*elk/i.test(rawHtml);
      console.log(`[seasons:diag] ${pg.species}: ${rawHtml.length} chars | <table>:${htmlTables} | pipe-rows:${pipeRows} | "Hunt #":${huntHdr} | has-210:${has210} | has-spike:${hasSpike}`);
      // Prefer the year printed in the "20XX Tags" column; else the calendar guess.
      const tagYear = (rawHtml.match(/(20\d{2})\s*Tags/i) || [])[1];
      const { year, map } = parseSeasonTables(rawHtml, tagYear || regsYear);
      const n = Object.keys(map).length;
      console.log(`[seasons] ${pg.species} parsed ${n} hunts (year ${year})`);
      if (n < 20) { console.log(`[seasons] ${pg.species} SKIPPED — only ${n} rows`); details.push(`${pg.species} season dates: SKIPPED (only ${n} rows found — page format may have changed)`); continue; }
      const yd = await getYear(year);
      if (yd) {
        const known = new Set(yd.hunts.filter(h => h.species === pg.species).map(h => h.huntNum));
        const match = Object.keys(map).filter(id => known.has(id)).length;
        console.log(`[seasons] ${pg.species} ${match}/${n} match draw data`);
        if (known.size && match / n < 0.25) { details.push(`${pg.species} season dates: SKIPPED (only ${match}/${n} match draw data)`); continue; }
      }
      console.log(`[seasons] ${pg.species} ${year}: ${n} hunts, ${Object.values(map).filter(v=>/spike/i.test(v.b)).length} spike ✓`);
      merged[year] = Object.assign(merged[year] || {}, map);
    } catch (e) { console.error('[err] seasons', pg.species, e.message); details.push(`${pg.species} season dates FAILED: ${e.message}`); }
  }
  for (const [year, map] of Object.entries(merged)) {
    const json = JSON.stringify(map);
    const cur = await fs_('GET', `years/${year}/seasons/all`);
    if (cur && gv(cur.fields?.data) === json) { console.log(`[seasons] ${year} current`); continue; }
    if (DRY) { details.push(`${year} season dates: would load ${Object.keys(map).length}`); continue; }
    await fs_('PATCH', `years/${year}/seasons/all`, { fields: { data: V.s(json), updatedAt: V.t(new Date()) } });
    details.push(`${year} season dates: ${Object.keys(map).length} hunts`);
    updated++;
  }
  return updated;
}

// ═══ Applicants by Hunt Choice (2nd/3rd-choice demand) ════════════════════════
function parseChoices(buf, minRows = 20) {
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });
  let idx = null;
  const out = {};
  for (const r of rows) {
    if (!r) continue;
    const cells = r.map(c => String(c ?? '').trim());
    if (idx === null) {
      const hi = cells.findIndex(c => /hunt\s*number/i.test(c));
      if (hi >= 0) {
        idx = { id: hi,
          c1: cells.findIndex(c => /1st/i.test(c)), c2: cells.findIndex(c => /2nd/i.test(c)),
          c3: cells.findIndex(c => /3rd/i.test(c)), c4: cells.findIndex(c => /4th/i.test(c)),
          c5: cells.findIndex(c => /5th/i.test(c)), lop: cells.findIndex(c => /lop/i.test(c)),
          tot: cells.findIndex(c => /total/i.test(c)) };
      }
      continue;
    }
    const id = cells[idx.id];
    if (!id || !/^(\d{3}[A-Z]?\d{0,2}|[LMN]\d{1,3}[A-Z]?\d{0,2}|[A-Z]{2}\d{3}(?:[A-Z]\d{0,2}|-\d)?)$/.test(id)) continue;
    const num = i => i >= 0 ? (Number(r[i]) || 0) : 0;
    out[id] = { c1: num(idx.c1), c2: num(idx.c2), c3: num(idx.c3), c4: num(idx.c4), c5: num(idx.c5), lop: num(idx.lop), tot: num(idx.tot) };
  }
  if (Object.keys(out).length < minRows) throw new Error('too few hunts parsed from choice report');
  return out;
}

function findChoiceReports(html, pageUrl) {
  const found = [];
  for (const a of anchors(html, pageUrl)) {
    if (!/\.xlsx/i.test(a.url)) continue;
    const fname = decodeURIComponent(a.url.split('/').pop() || '');
    if (!/applicants[\s_-]*by[\s_-]*hunt[\s_-]*choice/i.test(fname)) continue;
    if (/premium/i.test(fname)) continue; // premium files handled separately (findPremiumReports)
    const ym = fname.match(/(20\d{2})/); if (!ym) continue;
    let species = null;
    if (/elk/i.test(fname)) species = 'elk';
    else if (/deer/i.test(fname) && !/antlerless/i.test(fname)) species = 'deer';
    if (!species) continue;
    found.push({ url: a.url, fname, year: ym[1], species });
  }
  const best = {};
  for (const f of found) if (!best[f.species + f.year]) best[f.species + f.year] = f;
  return Object.values(best);
}

// ═══ Public land % (regs unit-map pages) ══════════════════════════════════════
const LAND_PAGES = [
  'https://www.eregulations.com/oregon/hunting/western-oregon-unit-map',
  'https://www.eregulations.com/oregon/hunting/eastern-oregon-unit-map'
];
function parsePublicLand(html) {
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  const out = { byArea: {}, byName: {} };
  // Herd-area style: "EH01: 46% public lands" / "JT01: 50% public land"
  let m;
  const areaRe = /\b([A-Z]{2}\d{2})\s*:\s*(\d{1,3})\s*%\s*public\s*land/gi;
  while ((m = areaRe.exec(text))) out.byArea[m[1].toUpperCase()] = Number(m[2]);
  // Heading style: <h#>Unit Name</h#> ... "42% public lands"
  const secRe = /<h[2-4][^>]*>([^<]{2,60})<\/h[2-4]>([\s\S]{0,600}?)(\d{1,3})\s*%\s*public\s*land/gi;
  while ((m = secRe.exec(html))) {
    const name = m[1].replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim().toUpperCase()
      .replace(/\s*\(.*$/, '').replace(/\bUNIT\b/g, '').trim();
    if (name && !/GENERAL|SEASON|MAP|OREGON/.test(name)) out.byName[name] = Number(m[3]);
  }
  return out;
}
async function updatePublicLand(details) {
  const merged = { byArea: {}, byName: {} };
  let got = 0;
  for (const url of LAND_PAGES) {
    try {
      const res = await fetchRetry(url, { headers: UA });
      console.log(`[land] ${url.split('/').pop()} HTTP ${res.status}`);
      if (!res.ok) throw new Error(`page ${res.status} (site may be blocking robots)`);
      const rawHtml = await res.text();
      // DIAGNOSTICS: does "public land" even appear, and in what shape?
      const hits = (rawHtml.match(/public\s*land/gi) || []).length;
      const pctHits = (rawHtml.match(/\d{1,3}\s*%\s*public\s*land/gi) || []).length;
      const tables = (rawHtml.match(/<table/gi) || []).length;
      console.log(`[land:diag] ${url.split('/').pop()}: ${rawHtml.length} chars | "public land":${hits} | "N% public land":${pctHits} | <table>:${tables}`);
      const pi = rawHtml.search(/\d{1,3}\s*%\s*public\s*land/i);
      if (pi >= 0) console.log(`[land:sample] ...${rawHtml.slice(Math.max(0, pi - 180), pi + 60).replace(/\s+/g, ' ')}...`);
      else if (hits > 0) { const wi = rawHtml.search(/public\s*land/i); console.log(`[land:sample] (no % pattern) ...${rawHtml.slice(Math.max(0, wi - 120), wi + 80).replace(/\s+/g, ' ')}...`); }
      else console.log(`[land:sample] "public land" not present on this page at all`);
      const p = parsePublicLand(rawHtml);
      console.log(`[land] parsed byArea:${Object.keys(p.byArea).length} byName:${Object.keys(p.byName).length}`);
      Object.assign(merged.byArea, p.byArea); Object.assign(merged.byName, p.byName);
      got += Object.keys(p.byArea).length + Object.keys(p.byName).length;
    } catch (e) { console.error('[land] err', e.message); details.push('public land page failed: ' + e.message); }
  }
  if (got < 20) { console.log(`[land] SKIPPED — only ${got} entries`); details.push(`public land %: SKIPPED (only ${got} entries found)`); return 0; }
  const json = JSON.stringify(merged);
  const cur = await fs_('GET', `meta/publicLand`);
  if (cur && gv(cur.fields?.data) === json) return 0;
  if (DRY) { details.push(`public land %: would load ${got} entries`); return 0; }
  await fs_('PATCH', `meta/publicLand`, { fields: { data: V.s(json), updatedAt: V.t(new Date()) } });
  console.log(`[land] loaded ${got} entries ✓`);
  details.push(`public land %: ${got} units/areas`);
  return 1;
}

// ═══ Unit boundary export (writes units.geojson / deer_areas.geojson for the app)
import { writeFileSync, existsSync, readFileSync as rfs } from 'fs';
const WMU_ITEM = '8bfaa3a4e10e49dd9b0cc95693977e37'; // Oregon GEOHub: Wildlife Management Units

function decimate(coords, eps) { // thin dense rings; keep shape, shrink file
  const out = [coords[0]];
  for (let i = 1; i < coords.length - 1; i++) {
    const [x1, y1] = out[out.length - 1], [x2, y2] = coords[i];
    if (Math.abs(x2 - x1) + Math.abs(y2 - y1) > eps) out.push(coords[i]);
  }
  out.push(coords[coords.length - 1]);
  return out.map(([x, y]) => [Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4]);
}
function slimFeature(f, nameField, eps) {
  const g = f.geometry; if (!g) return null;
  const doPoly = rings => rings.map(r => decimate(r, eps)).filter(r => r.length > 3);
  let geom = null;
  if (g.type === 'Polygon') { const r = doPoly(g.coordinates); if (r.length) geom = { type: 'Polygon', coordinates: r }; }
  else if (g.type === 'MultiPolygon') { const p = g.coordinates.map(doPoly).filter(x => x.length); if (p.length) geom = { type: 'MultiPolygon', coordinates: p }; }
  if (!geom) return null;
  return { type: 'Feature', properties: { name: String(f.properties?.[nameField] ?? '').trim() }, geometry: geom };
}
async function fetchLayerGeoJSON(layerUrl, nameField) {
  const feats = []; let offset = 0;
  for (let page = 0; page < 40; page++) {
    const u = `${layerUrl}/query?where=1%3D1&outFields=${encodeURIComponent(nameField)}&returnGeometry=true&outSR=4326&f=geojson&resultOffset=${offset}&resultRecordCount=200`;
    const gj = await (await fetch(u, { headers: UA })).json();
    if (!gj.features || !gj.features.length) break;
    feats.push(...gj.features);
    if (!gj.properties?.exceededTransferLimit && gj.features.length < 200) break;
    offset += gj.features.length;
  }
  return feats;
}
async function resolveItemLayer(itemId) {
  const item = await (await fetch(`https://www.arcgis.com/sharing/rest/content/items/${itemId}?f=json`, { headers: UA })).json();
  if (!item?.url) throw new Error('item has no service url');
  const base = item.url.replace(/\/$/, '') + (/(Feature|Map)Server$/i.test(item.url) ? '/0' : '');
  const meta = await (await fetch(base + '?f=json', { headers: UA })).json();
  const fields = (meta.fields || []).map(f => f.name);
  const nameField = fields.find(f => /unit.*name|area.*name|name.*unit/i.test(f)) || fields.find(f => /^(unit|name|area)$/i.test(f)) || fields.find(f => /name/i.test(f));
  if (!nameField) throw new Error('no name field on layer');
  return { base, nameField };
}
async function exportBoundaries(details) {
  // WMUs
  try {
    const { base, nameField } = await resolveItemLayer(WMU_ITEM);
    const feats = await fetchLayerGeoJSON(base, nameField);
    const slim = feats.map(f => slimFeature(f, nameField, 0.004)).filter(Boolean);
    if (slim.length < 40) throw new Error(`only ${slim.length} units`);
    const gj = JSON.stringify({ type: 'FeatureCollection', features: slim });
    const changed = !existsSync('units.geojson') || rfs('units.geojson', 'utf8') !== gj;
    if (changed && !DRY) writeFileSync('units.geojson', gj);
    console.log(`[geo] units.geojson: ${slim.length} units, ${(gj.length / 1024).toFixed(0)} KB${changed ? '' : ' (unchanged)'}`);
    if (changed) details.push(`unit boundaries: ${slim.length} units`);
  } catch (e) { console.error('[geo] WMU export failed:', e.message); details.push('unit boundaries FAILED: ' + e.message); }
  // 2026 Deer Hunt Areas — discover via ArcGIS search (try several phrasings)
  try {
    const queries = [
      'title:("Deer Hunt Area" OR "Deer Hunt Areas") Oregon type:"Feature Service"',
      'owner:ODFW_ArcGIS_Online deer hunt area type:"Feature Service"',
      '"Deer Hunt Area" Oregon ODFW',
      'Oregon deer hunt boundaries type:"Feature Service"'
    ];
    let hit = null, tried = [];
    for (const q of queries) {
      const sr = await (await fetch(`https://www.arcgis.com/sharing/rest/search?f=json&num=15&q=${encodeURIComponent(q)}`, { headers: UA })).json();
      const results = sr.results || [];
      tried.push(`"${q.slice(0, 30)}"→${results.length}`);
      hit = results.find(r => /deer.*hunt.*area/i.test(r.title) && r.url && /feature/i.test(r.type || ''));
      if (hit) { console.log(`[geo] deer area layer found: "${hit.title}" (${hit.id})`); break; }
    }
    if (!hit) { console.log(`[geo] deer hunt area layer not found. Searches: ${tried.join(', ')}`); details.push('deer hunt area boundaries: layer not found in ArcGIS (searched 4 ways)'); return; }
    const { base, nameField } = await resolveItemLayer(hit.id);
    const feats = await fetchLayerGeoJSON(base, nameField);
    const slim = feats.map(f => slimFeature(f, nameField, 0.004)).filter(Boolean);
    if (slim.length < 10) throw new Error(`only ${slim.length} areas`);
    const gj = JSON.stringify({ type: 'FeatureCollection', features: slim });
    const changed = !existsSync('deer_areas.geojson') || rfs('deer_areas.geojson', 'utf8') !== gj;
    if (changed && !DRY) writeFileSync('deer_areas.geojson', gj);
    console.log(`[geo] deer_areas.geojson: ${slim.length} areas from "${hit.title}"${changed ? '' : ' (unchanged)'}`);
    if (changed) details.push(`deer hunt area boundaries: ${slim.length} areas`);
  } catch (e) { console.error('[geo] deer areas export failed:', e.message); details.push('deer area boundaries: not available (' + e.message + ')'); }
}

// ═══ Firestore REST ═══════════════════════════════════════════════════════════
async function fs_(method, path, body) {
  const url = `${BASE}/${path}${path.includes('?') ? '&' : '?'}key=${API_KEY}`;
  const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Firestore ${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}
const V = { s: v => ({ stringValue: String(v) }), i: v => ({ integerValue: String(v) }), t: d => ({ timestampValue: d.toISOString() }) };
const gv = f => f == null ? null : 'stringValue' in f ? f.stringValue : 'integerValue' in f ? Number(f.integerValue) : 'timestampValue' in f ? f.timestampValue : null;

async function loadYear(year) {
  const doc = await fs_('GET', `years/${year}`);
  if (!doc) return null;
  const chunkCount = Number(gv(doc.fields?.chunkCount) || 0);
  let hunts = [];
  for (let ci = 0; ci < chunkCount; ci++) {
    const cd = await fs_('GET', `years/${year}/chunks/${ci}`);
    if (cd) hunts = hunts.concat(JSON.parse(gv(cd.fields?.hunts) || '[]'));
  }
  return { hunts, chunkCount };
}
async function writeYearHunts(year, hunts, oldChunkCount) {
  const chunks = [];
  for (let i = 0; i < hunts.length; i += CHUNK) chunks.push(hunts.slice(i, i + CHUNK));
  await fs_('PATCH', `years/${year}`, { fields: { year: V.s(year), huntCount: V.i(hunts.length), chunkCount: V.i(chunks.length), updatedAt: V.t(new Date()) } });
  for (let ci = 0; ci < chunks.length; ci++)
    await fs_('PATCH', `years/${year}/chunks/${ci}`, { fields: { hunts: V.s(JSON.stringify(chunks[ci])) } });
  for (let ci = chunks.length; ci < oldChunkCount; ci++)
    await fs_('DELETE', `years/${year}/chunks/${ci}`).catch(() => {});
}
async function getHarvestDoc(year) {
  const d = await fs_('GET', `years/${year}/harvest/all`);
  return d ? JSON.parse(gv(d.fields?.data) || '{}') : {};
}
async function setHarvestDoc(year, data) {
  await fs_('PATCH', `years/${year}/harvest/all`, { fields: { data: V.s(JSON.stringify(data)), updatedAt: V.t(new Date()) } });
}
async function getMeta(year, key) {
  const d = await fs_('GET', `years/${year}/pdfMeta/${key}`);
  return d ? { fileName: gv(d.fields?.fileName), source: gv(d.fields?.source) } : null;
}
async function setMeta(year, key, fileName, huntCount) {
  await fs_('PATCH', `years/${year}/pdfMeta/${key}`, { fields: { fileName: V.s(fileName), huntCount: V.i(huntCount), uploadedAt: V.t(new Date()), source: V.s('auto') } });
}
async function setStatus(summary, details) {
  await fs_('PATCH', `meta/autoUpdate`, { fields: {
    lastRun: V.t(new Date()), lastRunStr: V.s(new Date().toLocaleDateString('en-US')),
    summary: V.s(summary), details: V.s(details.join(' | ') || '—')
  } });
}

// ═══ Link discovery ═══════════════════════════════════════════════════════════
function anchors(html, pageUrl) {
  const out = [];
  const re = /<a[^>]+href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let url = m[1];
    try { url = new URL(url.replace(/ /g, '%20'), pageUrl).href; } catch { continue; }
    out.push({ url, text: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() });
  }
  return out;
}

function findDrawReports(html, pageUrl) {
  const found = [];
  for (const a of anchors(html, pageUrl)) {
    if (!/\.xlsx/i.test(a.url)) continue;
    const fname = decodeURIComponent(a.url.split('/').pop() || '');
    if (!/preference[\s_-]*point[\s_-]*draw[\s_-]*report/i.test(fname)) continue;
    const ym = fname.match(/(20\d{2})/); if (!ym) continue;
    let species = null;
    if (/elk/i.test(fname)) species = 'elk';
    else if (/deer/i.test(fname) && !/antlerless/i.test(fname)) species = 'deer';
    if (!species) continue;
    found.push({ url: a.url, fname, year: ym[1], species });
  }
  const best = {};
  for (const f of found) if (!best[f.species + f.year]) best[f.species + f.year] = f;
  return Object.values(best);
}

function findPremiumReports(html, pageUrl) {
  const found = [];
  for (const a of anchors(html, pageUrl)) {
    if (!/\.xlsx/i.test(a.url)) continue;
    const fname = decodeURIComponent(a.url.split('/').pop() || '');
    if (!/premium/i.test(fname)) continue;
    if (!/applicants[\s_-]*by[\s_-]*hunt[\s_-]*choice/i.test(fname)) continue; // choice files only
    const ym = fname.match(/(20\d{2})/); if (!ym) continue;
    let series = null;
    if (/elk/i.test(fname)) series = 'elk';
    else if (/pronghorn|antelope/i.test(fname)) series = 'pronghorn';
    else if (/deer/i.test(fname)) series = 'deer';
    if (!series) continue;
    found.push({ url: a.url, fname, year: ym[1], series });
  }
  const best = {};
  for (const f of found) if (!best[f.series + f.year]) best[f.series + f.year] = f;
  return Object.values(best);
}

function findHarvestReports(html, pageUrl) {
  const found = [];
  for (const a of anchors(html, pageUrl)) {
    if (!/\.pdf/i.test(a.url)) continue;
    const t = a.text.toLowerCase();
    if (/public vs private|antlerless|damage|bear|cougar|sheep|goat|pronghorn/.test(t)) continue;
    const ym = a.text.match(/(20\d{2})/); if (!ym) continue;
    const year = ym[1];
    if (Number(year) < 2022) continue;
    let species = null;
    if (/elk/.test(t)) species = 'elk';
    else if (/deer/.test(t)) species = 'deer';
    if (!species) continue;
    let wep = null;
    if (/archery/.test(t)) wep = 'Archery';
    else if (/muzzleloader|\bml\b/.test(t)) wep = 'Muzz';
    else if (/any legal weapon|rifle|\balw\b|100 series/.test(t)) wep = 'Rifle';
    if (!wep) continue;
    const key = species + wep + 'Harvest'; // elkRifleHarvest, deerMuzzHarvest, ...
    const fname = decodeURIComponent(a.url.split('/').pop() || '');
    found.push({ url: a.url, fname, year, species, key: key.charAt(0).toLowerCase() + key.slice(1), label: a.text });
  }
  const best = {};
  for (const f of found) if (!best[f.key + f.year]) best[f.key + f.year] = f;
  return Object.values(best);
}

// ═══ Main ═════════════════════════════════════════════════════════════════════
async function main() {
  const details = [];
  let updated = 0, failed = 0;
  const yearCache = new Map();
  const getYear = async y => { if (!yearCache.has(y)) yearCache.set(y, await loadYear(y)); return yearCache.get(y); };

  // ── Draw reports ──
  try {
    console.log('[draw] fetching', DRAW_PAGE);
    const res = await fetch(DRAW_PAGE, { headers: UA });
    if (!res.ok) throw new Error(`page ${res.status}`);
    const reports = findDrawReports(await res.text(), DRAW_PAGE);
    console.log(`[draw] found ${reports.length} report link(s)`);
    for (const r of reports) {
      const key = r.species === 'elk' ? 'elkPoints' : 'deerPoints';
      try {
        const meta = await getMeta(r.year, key);
        if (meta && meta.fileName === r.fname) { console.log(`[skip] ${r.year} ${key} current`); continue; }
        console.log(`[dl] ${r.fname}`);
        const fres = await fetch(r.url, { headers: UA });
        if (!fres.ok) throw new Error(`download ${fres.status}`);
        const hunts = parseHunts(Buffer.from(await fres.arrayBuffer()), r.species);
        console.log(`[parse] ${r.year} ${r.species}: ${hunts.length} hunts`);
        if (DRY) { details.push(`${r.year} ${r.species} draw: would load ${hunts.length}`); continue; }
        const existing = (await getYear(r.year)) || { hunts: [], chunkCount: 0 };
        const merged = existing.hunts.filter(h => h.species !== r.species).concat(hunts);
        await writeYearHunts(r.year, merged, existing.chunkCount);
        yearCache.set(r.year, { hunts: merged, chunkCount: Math.ceil(merged.length / CHUNK) });
        await setMeta(r.year, key, r.fname, hunts.length);
        details.push(`${r.year} ${r.species} draw: ${hunts.length} hunts`);
        updated++;
      } catch (e) { console.error(`[err] draw ${r.year} ${r.species}:`, e.message); details.push(`${r.year} ${r.species} draw FAILED: ${e.message}`); failed++; }
    }
  } catch (e) { console.error('[err] draw page:', e.message); details.push('draw page unreachable: ' + e.message); failed++; }

  // ── Harvest PDFs ──
  try {
    console.log('[harvest] fetching', HARVEST_PAGE);
    const res = await fetch(HARVEST_PAGE, { headers: UA });
    if (!res.ok) throw new Error(`page ${res.status}`);
    const reports = findHarvestReports(await res.text(), HARVEST_PAGE);
    // only the two most recent years listed — older data rarely changes
    const years = [...new Set(reports.map(r => r.year))].sort().reverse().slice(0, 2);
    const wanted = reports.filter(r => years.includes(r.year));
    console.log(`[harvest] found ${reports.length} link(s); processing years ${years.join(', ')}`);
    for (const r of wanted) {
      try {
        const yd = await getYear(r.year);
        if (!yd) { console.log(`[skip] ${r.year} ${r.key}: no draw data for that year yet`); continue; }
        const meta = await getMeta(r.year, r.key);
        if (meta && meta.source !== 'auto') { console.log(`[skip] ${r.year} ${r.key}: manual upload present — leaving it alone`); continue; }
        if (meta && meta.fileName === r.fname) { console.log(`[skip] ${r.year} ${r.key} current`); continue; }
        console.log(`[dl] ${r.fname || r.url}`);
        const fres = await fetch(r.url, { headers: UA });
        if (!fres.ok) throw new Error(`download ${fres.status}`);
        const lines = await pdfToLines(await fres.arrayBuffer());
        const parsed = parseHarvestLines(lines, r.species === 'elk' ? 11 : 9);
        const knownIds = new Set(yd.hunts.filter(h => h.species === r.species).map(h => h.huntNum));
        const v = validateHarvest(parsed, knownIds);
        if (!v.ok) { console.error(`[reject] ${r.year} ${r.key}: ${v.reason}`); details.push(`${r.year} ${r.label}: NEEDS MANUAL UPLOAD (${v.reason})`); failed++; continue; }
        console.log(`[parse] ${r.year} ${r.key}: ${v.count} hunts, validated`);
        if (DRY) { details.push(`${r.year} ${r.key}: would load ${v.count}`); continue; }
        const harvestAll = await getHarvestDoc(r.year);
        harvestAll[r.key] = parsed;
        await setHarvestDoc(r.year, harvestAll);
        await setMeta(r.year, r.key, r.fname || r.url.split('/').pop(), v.count);
        details.push(`${r.year} ${r.key}: ${v.count} hunts`);
        updated++;
      } catch (e) { console.error(`[err] harvest ${r.year} ${r.key}:`, e.message); details.push(`${r.year} ${r.label || r.key} FAILED: ${e.message}`); failed++; }
    }
  } catch (e) { console.error('[err] harvest page:', e.message); details.push('harvest page unreachable: ' + e.message); failed++; }

  // ── Applicants by Hunt Choice (from the same draw report page) ──
  try {
    const res = await fetch(DRAW_PAGE, { headers: UA });
    if (res.ok) {
      const drawPageHtml = await res.text();

      const reports = findChoiceReports(drawPageHtml, DRAW_PAGE);
      console.log(`[choices] found ${reports.length} choice report link(s)`);
      for (const r of reports) {
        const key = r.species === 'elk' ? 'elkChoices' : 'deerChoices';
        try {
          const yd = await getYear(r.year);
          if (!yd) { console.log(`[skip] ${r.year} ${key}: no draw data yet`); continue; }
          const meta = await getMeta(r.year, key);
          if (meta && meta.fileName === r.fname) { console.log(`[skip] ${r.year} ${key} current`); continue; }
          const fres = await fetch(r.url, { headers: UA });
          if (!fres.ok) throw new Error(`download ${fres.status}`);
          const parsed = parseChoices(Buffer.from(await fres.arrayBuffer()));
          // Regular choices are 3-digit / herd-area IDs only. Drop any L/M/N
          // premium hunts that may have leaked in from a mis-matched file.
          for (const id of Object.keys(parsed)) if (/^[LMN]\d/.test(id)) delete parsed[id];
          console.log(`[parse] ${r.year} ${key}: ${Object.keys(parsed).length} hunts`);
          if (DRY) { details.push(`${r.year} ${key}: would load`); continue; }
          const doc = await fs_('GET', `years/${r.year}/choices/all`);
          let all = doc ? JSON.parse(gv(doc.fields?.data) || '{}') : {};
          // one-time cleanup: remove previously-leaked premium keys from the cloud
          for (const id of Object.keys(all)) if (/^[LMN]\d/.test(id)) delete all[id];
          Object.assign(all, parsed); // deer 1xx and elk 2xx hunt numbers never collide
          await fs_('PATCH', `years/${r.year}/choices/all`, { fields: { data: V.s(JSON.stringify(all)), updatedAt: V.t(new Date()) } });
          await setMeta(r.year, key, r.fname, Object.keys(parsed).length);
          details.push(`${r.year} ${r.species} choices: ${Object.keys(parsed).length} hunts`);
          updated++;
        } catch (e) { console.error(`[err] choices ${r.year}:`, e.message); details.push(`${r.year} ${r.species} choices FAILED: ${e.message}`); failed++; }
      }

      // ── Premium hunts (L/M/N series) — separate files, same choice format ──
      const premReports = findPremiumReports(drawPageHtml, DRAW_PAGE);
      console.log(`[premium] found ${premReports.length} premium report link(s): ${premReports.map(r => r.year + ' ' + r.series).join(', ') || 'NONE'}`);
      for (const r of premReports) {
        const key = `premium_${r.series}`; // premium_deer / premium_elk / premium_pronghorn
        try {
          const meta = await getMeta(r.year, key);
          if (meta && meta.fileName === r.fname) { console.log(`[skip] ${r.year} ${key} current`); continue; }
          const fres = await fetch(r.url, { headers: UA });
          if (!fres.ok) throw new Error(`download ${fres.status}`);
          const parsed = parseChoices(Buffer.from(await fres.arrayBuffer()), 5);
          const ids = Object.keys(parsed);
          const seriesLetter = { deer: 'L', elk: 'M', pronghorn: 'N' }[r.series];
          const kept = {};
          for (const id of ids) if (id[0] === seriesLetter) kept[id] = parsed[id];
          console.log(`[premium] ${r.year} ${r.series}: ${Object.keys(kept).length} ${seriesLetter}-series hunts (of ${ids.length} rows)`);
          if (!Object.keys(kept).length) { console.log(`[premium] ${r.year} ${r.series}: no ${seriesLetter}-series rows, skipping`); continue; }
          if (DRY) { details.push(`${r.year} ${key}: would load ${Object.keys(kept).length}`); continue; }
          const doc = await fs_('GET', `years/${r.year}/premium/all`);
          const all = doc ? JSON.parse(gv(doc.fields?.data) || '{}') : {};
          Object.assign(all, kept);
          await fs_('PATCH', `years/${r.year}/premium/all`, { fields: { data: V.s(JSON.stringify(all)), updatedAt: V.t(new Date()) } });
          await setMeta(r.year, key, r.fname, Object.keys(kept).length);
          details.push(`${r.year} premium ${r.series}: ${Object.keys(kept).length} hunts`);
          updated++;
        } catch (e) { console.error(`[err] premium ${r.year} ${r.series}:`, e.message); details.push(`${r.year} premium ${r.series} FAILED: ${e.message}`); failed++; }
      }
    }
  } catch (e) { details.push('choice reports unreachable: ' + e.message); }

  // ── Public land % ──
  try { updated += await updatePublicLand(details); }
  catch (e) { details.push('public land failed: ' + e.message); failed++; }

  // ── Unit boundary files for the in-app map ──
  try { await exportBoundaries(details); }
  catch (e) { details.push('boundary export failed: ' + e.message); }

  // ── Season dates + bag limits ──
  try { updated += await updateSeasons(details, getYear); }
  catch (e) { console.error('[err] seasons:', e.message); details.push('season dates unreachable: ' + e.message); failed++; }

  let summary;
  if (updated) summary = `loaded ${updated} new report(s)` + (failed ? `, ${failed} need attention` : '');
  else if (failed) summary = `no new data loaded — ${failed} item(s) need attention`;
  else summary = 'no new data — everything is current';
  console.log('[done]', summary);
  if (!DRY) await setStatus(summary, details);
}

main().catch(async e => {
  console.error('[fatal]', e);
  try { if (!DRY) await setStatus('update run failed: ' + e.message, []); } catch {}
  process.exit(1);
});
