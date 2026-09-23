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

// Same files as the page. A league file that fails for another reason than "does not exist" is
// retried; if it still fails the run stops - better no forecasts than forecasts from partial data.
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
const data = await E.loadData(fetchJson);
if (data.failed) throw new Error(`${data.failed} openfootball files could not be fetched - nothing archived`);
if (!data.curFiles.length || !data.played.length) throw new Error('no openfootball data - nothing archived');
E.mergeSnapshot(data, snap);
const now = Date.now();
const st = E.prepare(data, E.todayDay() + 1);

const archPath = join(root, 'data', 'forecasts.json');
const archive = existsSync(archPath) ? JSON.parse(readFileSync(archPath, 'utf8'))
  : { v: 1, about: 'MatchLab forecasts, locked when the match day begins (00:00 UTC) and scored after the match. Written by collector/forecast.mjs.', forecasts: {} };
const settled = E.settleForecasts(archive, data, E.utcDayOf(now));
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
console.log(`issued/updated ${issued}, newly scored ${settled}; archive: ${summary.total} forecasts, `
  + `${summary.settled} scored, ${summary.locked} locked, ${summary.open} open, ${summary.void} void`);
if (summary.settled) console.log(`log-loss ${summary.ll.toFixed(4)}, Brier ${summary.brier.toFixed(4)}, top pick ${(100 * summary.acc).toFixed(1)}%`);
