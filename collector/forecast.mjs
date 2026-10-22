// MatchLab - forecast archive (the live track record). Runs on GitHub after the collector:
//   node collector/forecast.mjs
// Every fixture of the next 7 days gets a forecast from engine.js - exactly the code the page runs.
// A forecast is updated on each run until its match day begins (00:00 UTC), then locked for good,
// and scored once the result is in. Writes data/forecasts.json (the archive, committed to the
// repository, so its git history shows every change) and data/track.js (the summary the page shows).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
// run engine.js as the browser does - a plain script that puts the engine on the global object
runInThisContext(readFileSync(join(root, 'engine.js'), 'utf8'), { filename: 'engine.js' });
const E = globalThis;

// Same data as the page: the snapshot the collector has just written, plus this month's ESPN results.
// A request is retried; a competition-month that still fails keeps the snapshot's rows (minutes old).
async function fetchJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) return null;
      if (r.ok) return await r.json();
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url}: ${e.message}`);
      await new Promise(res => setTimeout(res, 2000 * attempt));
    }
  }
}

const snapPath = join(root, 'data', 'latest.json');
const snap = existsSync(snapPath) ? JSON.parse(readFileSync(snapPath, 'utf8')) : null;
const data = await E.loadData(fetchJson, null, snap);
if (!data || !data.curComps.length || !data.played.length) throw new Error('no match data in the snapshot - nothing archived');
if (data.failed) console.log(`${data.failed} live ESPN requests failed - the snapshot's rows are used for them`);
E.mergeSnapshot(data, snap);
const now = Date.now();
const st = E.prepare(data, E.todayDay() + 1);

const archPath = join(root, 'data', 'forecasts.json');
const archive = existsSync(archPath) ? JSON.parse(readFileSync(archPath, 'utf8'))
  : { v: 1, about: 'MatchLab forecasts, locked when the match day begins (00:00 UTC) and scored after the match. Written by collector/forecast.mjs.', forecasts: {} };
// v6 -> v7: v6 named clubs as openfootball does ("FC Bayern München"), v7 as ESPN does ("Bayern Munich").
// A v6 forecast still open (its match day has not begun) is replaced by v7's own; a locked one is
// scored against the ESPN result of the same competition within a day whose club names share a word.
const today = E.utcDayOf(now);
let migrated = 0;
{
  const byCompDay = new Map();
  for (const r of data.played) { const k = `${r.comp}|${r.day}`; if (!byCompDay.has(k)) byCompDay.set(k, []); byCompDay.get(k).push(r); }
  const shares = (a, b) => { const ta = E.toks(a); for (const t of E.toks(b)) if (ta.has(t)) return true; return false; };
  for (const e of Object.values(archive.forecasts)) {
    if (e.res || e.void || (e.model || 'v6') !== 'v6') continue;
    const d = E.parseDay(e.d);
    if (d > today) { e.void = 'replaced by the v7 forecast (not locked yet)'; migrated++; continue; }
    let hit = null;
    for (const k of [0, -1, 1]) for (const r of byCompDay.get(`${e.comp}|${d + k}`) || []) if (!hit && shares(e.h, r.h) && shares(e.a, r.a)) hit = r;
    if (!hit) continue;
    const o = hit.hg > hit.ag ? 0 : hit.hg === hit.ag ? 1 : 2, s = E.scoreOne(e.p, o), r4 = v => Math.round(v * 1e4) / 1e4;
    e.res = [hit.hg, hit.ag]; e.o = o; e.played = E.isoDay(hit.day); e.ll = r4(s.ll); e.br = r4(s.br); e.rps = r4(s.rps);
    if (e.mkt) e.mll = r4(E.scoreOne(e.mkt, o).ll);
    migrated++;
  }
}
const settled = E.settleForecasts(archive, data, today);
const issued = E.issueForecasts(archive, st, now);
archive.updated = new Date(now).toISOString().slice(0, 19) + 'Z';

// one forecast per line, oldest match first: small, readable git diffs
const entries = Object.entries(archive.forecasts).sort((a, b) => (a[1].d < b[1].d ? -1 : a[1].d > b[1].d ? 1 : a[0] < b[0] ? -1 : 1));
const head = Object.fromEntries(Object.entries(archive).filter(([k]) => k !== 'forecasts'));
writeFileSync(archPath, JSON.stringify(head).slice(0, -1) + ',"forecasts":{\n'
  + entries.map(([k, v]) => JSON.stringify(k) + ':' + JSON.stringify(v)).join(',\n') + '\n}}\n');

const summary = E.trackSummary(archive, now);
writeFileSync(join(root, 'data', 'track.js'), 'window.MATCHLAB_TRACK=' + JSON.stringify(summary) + ';\n');

console.log(`engine ${E.ENGINE_VERSION} (settings ${E.CFG_HASH}), data ${snap ? snap.generated : 'none'}, `
  + `Elo history ${data.eloStart ? data.eloStart.n + ' teams' : 'missing'}`);
if (migrated) console.log(`v6 forecasts migrated to ESPN results: ${migrated}`);
console.log(`issued/updated ${issued}, newly scored ${settled}; archive: ${summary.total} forecasts, `
  + `${summary.settled} scored, ${summary.locked} locked, ${summary.open} open, ${summary.void} void`);
if (summary.settled) console.log(`log-loss ${summary.ll.toFixed(4)}, Brier ${summary.brier.toFixed(4)}, top pick ${(100 * summary.acc).toFixed(1)}%`);
