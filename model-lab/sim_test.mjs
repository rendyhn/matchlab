// MatchLab - how uncertain should a season projection be? Walk-forward test of simulateLeague().
//   node model-lab/sim_test.mjs            (Node 18+, fetches openfootball; cache in model-lab/cache)
// Every four weeks of a season, the model is fitted on the matches before that day only (the
// page's three seasons, Elo carried from 2018 like the collector's snapshot, Understat xG from
// data/latest.json where it has the match), then the rest of the season is simulated and the
// final table scored. Each setting of base / drift (the random walk of team strengths in
// engine.js) is tried on 2024/25; the best is then tested untouched on 2025/26.
// Scores, per team and checkpoint: ranked probability score over the final positions (main),
// log-loss of the actual position, and the Brier score of champion / top places / relegation.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInThisContext } from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
runInThisContext(readFileSync(join(root, 'engine.js'), 'utf8'), { filename: 'engine.js' });
const E = globalThis;
const CACHE = join(root, 'model-lab', 'cache', 'openfootball');
mkdirSync(CACHE, { recursive: true });

async function fetchJson(url) {
  const f = join(CACHE, url.split('/').slice(-2).join('_'));
  if (existsSync(f)) { const t = readFileSync(f, 'utf8'); return t === 'null' ? null : JSON.parse(t); }
  for (let k = 1; ; k++) {
    try {
      const r = await fetch(url);
      if (r.status === 404) { writeFileSync(f, 'null'); return null; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const j = await r.json(); writeFileSync(f, JSON.stringify(j)); return j;
    } catch (e) { if (k >= 3) throw e; await new Promise(res => setTimeout(res, 1500 * k)); }
  }
}
const seasonKey = y => `${y}-${String((y + 1) % 100).padStart(2, '0')}`;
async function files(seasons) {
  const jobs = [];
  for (const s of seasons) {
    for (const l of E.LEAGUES) jobs.push({ s, code: l.code, kind: 'league' });
    for (const c of E.HISTORY_ONLY) jobs.push({ s, code: c, kind: 'history' });
    for (const c of E.CUPS) jobs.push({ s, code: c, kind: 'cup' });
  }
  return Promise.all(jobs.map(async j => Object.assign({}, j, { json: await fetchJson(`${E.BASE}${j.s}/${j.code}.json`) })));
}

const snapPath = join(root, 'data', 'latest.json');
const snap = existsSync(snapPath) ? JSON.parse(readFileSync(snapPath, 'utf8')) : null;
const today = E.todayDay();

// the data the page would have had during season S (complete, so the truth is in it too)
async function seasonData(S) {
  const y = +S.slice(0, 4);
  const three = [S, seasonKey(y - 1), seasonKey(y - 2)];
  const all = []; for (let k = 2018; k <= y; k++) all.push(seasonKey(k));
  const data = E.buildData(await files(three), today, S, three);
  if (snap) E.mergeSnapshot(data, { xg: snap.xg });          // xG only: the rest is this season's
  // Elo from 2018 up to where the three seasons begin, as the collector does
  const full = E.buildData(await files(all), today, S, all);
  const start = E.seasonStart(three[2]);
  const R = E.eloRun(full.played.filter(r => r.day < start), null);
  const ratings = new Map();
  for (const [raw, c3] of data.cmap) { const ca = full.cmap.get(raw); if (ca !== undefined && R.has(ca) && !ratings.has(c3)) ratings.set(c3, R.get(ca)); }
  data.eloStart = { day: start, ratings, n: ratings.size };
  return data;
}

function finalTable(data, code) {
  const rows = E.leagueTable(data, code, Infinity, null);
  const list = [...rows.values()].sort((a, b) => b.pts - a.pts || b.gd - a.gd || b.gf - a.gf || (a.team < b.team ? -1 : 1));
  return new Map(list.map((x, k) => [x.team, k]));
}

const GRID = [];
for (const base of [0, 0.1, 0.2, 0.3]) for (const drift of [0, 0.1, 0.2, 0.3, 0.4]) GRID.push({ base, drift });
const NSIM = +(process.env.NSIM || 2000);

async function runSeason(S) {
  const data = await seasonData(S);
  const truth = new Map(E.LEAGUES.map(l => [l.code, finalTable(data, l.code)]));
  const lgMatches = data.played.filter(r => !r.cup && r.season === S && E.LG[r.comp]);
  const first = lgMatches[0].day, lastDay = lgMatches[lgMatches.length - 1].day;
  const out = GRID.map(() => ({ units: [] }));              // one unit = one league at one checkpoint
  for (let D = first + 35; D < lastDay - 7; D += 28) {
    const sub = Object.assign({}, data, {
      played: data.played.filter(r => r.day < D),
      fixtures: data.played.filter(r => !r.cup && r.season === S && r.day >= D).map(r => ({ day: r.day, h: r.h, a: r.a, comp: r.comp, cup: false })),
    });
    const st = E.prepare(sub, D);
    for (const l of E.LEAGUES) {
      const tr = truth.get(l.code), z = E.ZONES[l.code];
      GRID.forEach((g, gi) => {
        const res = E.simulateLeague(st, l.code, { n: NSIM, base: g.base, drift: g.drift, seed: 7 + D });
        if (res.T !== tr.size) return;
        let rps = 0, ll = 0, bT = 0, bTop = 0, bRel = 0;
        for (const x of res.teams) {
          const k = tr.get(x.team), T = res.T;
          let c = 0, sq = 0;
          for (let p = 0; p < T - 1; p++) { c += x.pos[p]; sq += (c - (p >= k ? 1 : 0)) ** 2; }
          rps += sq / (T - 1);
          ll -= Math.log((x.pos[k] * NSIM + 0.5) / (NSIM + 0.5 * T));
          bT += (x.title - (k === 0 ? 1 : 0)) ** 2;
          bTop += (x.top - (k < z.top ? 1 : 0)) ** 2;
          bRel += (x.rel - (k >= T - z.rel ? 1 : 0)) ** 2;
        }
        const T = res.T;
        out[gi].units.push({ code: l.code, D, rps: rps / T, ll: ll / T, bT: bT / T, bTop: bTop / T, bRel: bRel / T });
      });
    }
    process.stderr.write(`${S} ${E.isoDay(D)} done\n`);
  }
  return out;
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
function summary(res, label) {
  console.log(`\n${label}: ${res[0].units.length} league-checkpoints`);
  console.log('base drift |  RPS     d vs (0,0) +-2se | log-loss | Brier champion top relegation');
  const ref = res[0].units;
  // the paired differences are averaged per league first: checkpoints of one league are correlated
  res.forEach((r, gi) => {
    const g = GRID[gi], u = r.units;
    const perLg = new Map();
    u.forEach((x, k) => { const d = x.rps - ref[k].rps; if (!perLg.has(x.code)) perLg.set(x.code, []); perLg.get(x.code).push(d); });
    const dl = [...perLg.values()].map(mean), md = mean(dl);
    const se = Math.sqrt(dl.reduce((s, v) => s + (v - md) ** 2, 0) / (dl.length - 1) / dl.length);
    console.log(`${g.base.toFixed(1)}  ${g.drift.toFixed(1)}  | ${mean(u.map(x => x.rps)).toFixed(5)} ${(md >= 0 ? '+' : '') + md.toFixed(5)} +-${(2 * se).toFixed(5)} | ${mean(u.map(x => x.ll)).toFixed(4)} | ${mean(u.map(x => x.bT)).toFixed(4)} ${mean(u.map(x => x.bTop)).toFixed(4)} ${mean(u.map(x => x.bRel)).toFixed(4)}`);
  });
}

const val = await runSeason('2024-25');
summary(val, 'Choose on 2024/25');
const best = val.map((r, gi) => [mean(r.units.map(x => x.rps)), gi]).sort((a, b) => a[0] - b[0])[0][1];
console.log(`\nbest on 2024/25: base ${GRID[best].base}, drift ${GRID[best].drift}`);
const test = await runSeason('2025-26');
summary(test, 'Test on 2025/26 (untouched)');
