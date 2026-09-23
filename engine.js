/* ==================================================================
   MatchLab engine - everything that turns match data into forecasts, with no page code in it.
   The same file runs in the page (index.html), in the page's backtest worker and on GitHub
   (collector/forecast.mjs, Node), so the archived forecasts come from exactly the code the page
   runs. All of it lives in one function so the worker can be given its source text.
   ================================================================== */
function matchlabEngine(root) {
'use strict';

const ENGINE_VERSION = 'v6';

/* ------------------------------------------------------------------ config */
const BASE = 'https://raw.githubusercontent.com/openfootball/football.json/master/';
const LEAGUES = [
  { code: 'en.1', name: 'Premier League', short: 'PL', top: true },
  { code: 'es.1', name: 'La Liga', short: 'LALIGA', top: true },
  { code: 'de.1', name: 'Bundesliga', short: 'BUNDES', top: true },
  { code: 'it.1', name: 'Serie A', short: 'SERIE A', top: true },
  { code: 'fr.1', name: 'Ligue 1', short: 'LIGUE 1', top: true },
  { code: 'nl.1', name: 'Eredivisie', short: 'EREDIV', top: true },
  { code: 'pt.1', name: 'Liga Portugal', short: 'PORTUGAL', top: true },
  { code: 'en.2', name: 'Championship', short: 'CHAMP', top: false },
];
const HISTORY_ONLY = ['es.2', 'de.2', 'it.2', 'fr.2'];   // history of promoted clubs
// The link between league strengths. Files openfootball has not published yet (404) are still
// requested so they are used as soon as they appear; those 404s are expected and handled.
const CUPS = ['uefa.cl'];
const UCL = 'uefa.cl';
const SECOND_TIER = new Set(['en.2'].concat(HISTORY_ONLY));
const LG = Object.fromEntries(LEAGUES.map(l => [l.code, l]));
// Every setting below was checked by nested walk-forward validation in model-lab/lab.py
// (model-lab/RESULTS.md): chosen on 2022/23-2023/24, then tested untouched on 2024/25-2026/27.
//   halfLife/sigma/tau/homeSd/xgWeight: the grid's best values on 2022/23-2023/24 beat these by
//     0.0007 there (noise, +-0.0010) and lost 0.0003 on the test seasons - the v1 values stay.
//   Dixon-Coles rho vs plain Poisson: Poisson is worse by 0.0008 (+-0.0004) on the test seasons.
//   xG as 60% of the fit's targets vs a separate xG model blended on log rates: equal (+0.0001 +-0.0003).
//   Elo blend 35% (eloWeight, chosen on 2022/23-2023/24): -0.0020 (+-0.0012) log-loss on the test
//     seasons, better in each of them; needs Elo history back to 2018 (snapshot.elo from the collector).
//   A recalibration layer on top gained -0.0004 (+-0.0012) on the test seasons - not used.
const CFG = {
  halfLife: 240, sigma: 0.5, tau: 0.5, homeSd: 0.1, maxIter: 400, tol: 1e-5, xgWeight: 0.6,
  eloK: 20, eloHfa: 70, eloNewTop: 1500, eloNewSecond: 1350, eloWeight: 0.35, eloMapDays: 730,
};
// short fingerprint of the settings, stored with every archived forecast
const CFG_HASH = (() => {
  const s = ENGINE_VERSION + JSON.stringify(CFG);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16).padStart(8, '0');
})();

/* ------------------------------------------------------------------ dates (integer day numbers, UTC) */
const DAYMS = 86400000;
const parseDay = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d) / DAYMS; };
const todayDay = () => { const n = new Date(); return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()) / DAYMS; };
const utcDayOf = ms => Math.floor(ms / DAYMS);
const dayDate = d => new Date(d * DAYMS);
const isoDay = d => dayDate(d).toISOString().slice(0, 10);
const mondayOf = d => d - ((d + 3) % 7);           // 1 Jan 1970 was a Thursday
function seasonKeyOf(day) {
  const dt = dayDate(day); const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1;
  const s = m >= 7 ? y : y - 1;
  return `${s}-${String((s + 1) % 100).padStart(2, '0')}`;
}
const seasonStart = key => Date.UTC(+key.slice(0, 4), 6, 1) / DAYMS;
const prevSeason = key => { const s = +key.slice(0, 4) - 1; return `${s}-${String((s + 1) % 100).padStart(2, '0')}`; };

/* ------------------------------------------------------------------ team identity */
const cleanName = n => n.replace(/\s*\([A-Z]{3}\)\s*$/, '').trim();
// openfootball renames clubs between seasons and divisions ("VfL Bochum 1848" in the Bundesliga,
// "VfL Bochum" in 2. Bundesliga; "Deportivo La Coruña" / "RC Deportivo La Coruña"), which would
// split a club's history in two. Mirror of canonical_names() in collector/collect.py - keep identical.
const STOP = new Set(['fc', 'cf', 'afc', 'ac', 'as', 'sc', 'sv', 'ss', 'ssc', 'us', 'rc', 'rcd', 'cd', 'ud', 'sd', 'ca', 'cs', 'fk', 'vfb', 'vfl',
  'tsg', 'bc', 'calcio', 'club', 'de', 'del', 'la', 'le', 'the', 'and', 'e', 'ogc', 'osc', 'sco', 'aj', 'cfc', 'sad', 'futebol',
  'clube', 'football', 'balompie', 'hove', 'i']);
const SYN = { munich: 'munchen', inter: 'internazionale', man: 'manchester', utd: 'united', wolves: 'wolverhampton',
  spurs: 'tottenham', psg: 'paris', gladbach: 'monchengladbach', bilbao: 'athletic', sporting: 'sporting',
  koln: 'koln', cologne: 'koln', nurnberg: 'nurnberg', rome: 'roma', turin: 'torino', naples: 'napoli',
  milano: 'milan', saint: 'st', brighton: 'brighton', nottm: 'nottingham', sheff: 'sheffield', qpr: 'queens',
  'west brom': 'west bromwich', atletico: 'atletico', atl: 'atletico', bayern: 'bayern', leverkusen: 'leverkusen' };
const RESERVE = new Set(['b', 'ii', 'iii', 'u23', 'u21', 'u19', 'jong', 'castilla', 'reserves', 'atletic']);
const fold = s => s.normalize('NFKD').replace(/[^\x00-\x7f]/g, '').toLowerCase();
function toks(name) {
  const s = fold(name).replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9 ]+/g, ' ');
  const out = new Set();
  for (const w of s.split(/\s+/)) {
    if (!w || STOP.has(w) || /^[0-9]+$/.test(w)) continue;
    out.add(Object.prototype.hasOwnProperty.call(SYN, w) ? SYN[w] : w);
  }
  return out;
}
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// records: [name, season, comp, day]. Two names are one club when they come from the same country,
// one's name tokens contain the other's, reserve markers agree ("Real Sociedad B" is not
// "Real Sociedad") and they never appear in the same season. Returns Map name -> current name.
function canonicalNames(records) {
  const info = new Map();
  for (const [name, season, comp, day] of records) {
    if (!info.has(name)) info.set(name, { seasons: new Set(), countries: new Set(), last: 0 });
    const x = info.get(name);
    x.seasons.add(season); if (day > x.last) x.last = day;
    if (comp !== UCL) x.countries.add(comp.split('.')[0]);
  }
  const names = [...info.keys()].sort(cmpStr);
  const tok = new Map(names.map(n => [n, toks(n)]));
  for (const n of names) if (!info.get(n).countries.size) info.get(n).countries.add('cup');
  const inter = (a, b) => { let k = 0; for (const v of a) if (b.has(v)) k++; return k; };
  const meets = (a, b) => { for (const v of a) if (b.has(v)) return true; return false; };
  const reserveOf = t => [...t].filter(v => RESERVE.has(v)).sort().join(' ');
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    const a = names[i], ta = tok.get(a); if (!ta.size) continue;
    for (let j = i + 1; j < names.length; j++) {
      const b = names[j], tb = tok.get(b); if (!tb.size) continue;
      const k = inter(ta, tb);
      if (k !== ta.size && k !== tb.size) continue;                 // neither contains the other
      if (reserveOf(ta) !== reserveOf(tb)) continue;                 // "Real Sociedad B" is not "Real Sociedad"
      const ia = info.get(a), ib = info.get(b);
      if (!meets(ia.countries, ib.countries) || meets(ia.seasons, ib.seasons)) continue;
      pairs.push([-k / Math.max(ta.size, tb.size), a, b]);
    }
  }
  pairs.sort((x, y) => x[0] - y[0] || cmpStr(x[1], y[1]) || cmpStr(x[2], y[2]));
  const parent = new Map(names.map(n => [n, n]));
  const group = new Map(names.map(n => [n, { seasons: new Set(info.get(n).seasons), countries: new Set(info.get(n).countries) }]));
  const find = n => { while (parent.get(n) !== n) n = parent.get(n); return n; };
  for (const [, a, b] of pairs) {
    const ra = find(a), rb = find(b);
    if (ra === rb) continue;
    const ga = group.get(ra), gb = group.get(rb);
    if (meets(ga.seasons, gb.seasons) || !meets(ga.countries, gb.countries)) continue;
    parent.set(rb, ra);
    for (const s of gb.seasons) ga.seasons.add(s);
    for (const c of gb.countries) ga.countries.add(c);
  }
  const members = new Map();
  for (const n of names) { const r = find(n); if (!members.has(r)) members.set(r, []); members.get(r).push(n); }
  const out = new Map();
  for (const ms of members.values()) {
    let canon = ms[0];
    for (const n of ms) { const a = info.get(n).last, b = info.get(canon).last; if (a > b || (a === b && n > canon)) canon = n; }
    for (const n of ms) out.set(n, canon);
  }
  return out;
}

/* ------------------------------------------------------------------ data */
// Full-time score, or null. Since 2025/26 openfootball writes a 0-0 as
// "score": [0, 0] instead of {"ft": [0, 0]}. Without this every 0-0 of the current season
// is lost: the model overestimates goals and underestimates draws.
// The list form is trusted only when the match date has passed.
function scoreFt(sc, day, today) {
  let ft = null;
  if (sc && !Array.isArray(sc) && Array.isArray(sc.ft)) ft = sc.ft;
  else if (Array.isArray(sc) && day < today) ft = sc;
  if (!ft || ft.length !== 2) return null;
  const a = +ft[0], b = +ft[1];
  return Number.isInteger(a) && Number.isInteger(b) && a >= 0 && b >= 0 ? [a, b] : null;
}

// fetchJson(url) -> parsed JSON, or null when the file does not exist; it throws on a network error.
async function loadData(fetchJson, onProgress) {
  const today = todayDay();
  const cur = seasonKeyOf(today);
  const seasons = [cur, prevSeason(cur), prevSeason(prevSeason(cur))];
  const jobs = [];
  for (const s of seasons) {
    for (const l of LEAGUES) jobs.push({ s, code: l.code, kind: 'league' });
    for (const c of HISTORY_ONLY) jobs.push({ s, code: c, kind: 'history' });
    for (const c of CUPS) jobs.push({ s, code: c, kind: 'cup' });
  }
  let done = 0;
  const got = await Promise.all(jobs.map(async j => {
    try {
      return Object.assign({}, j, { json: await fetchJson(`${BASE}${j.s}/${j.code}.json`) });
    } catch (e) {
      return Object.assign({}, j, { json: null, err: true });
    } finally {
      if (onProgress) onProgress(++done, jobs.length);
    }
  }));
  return buildData(got, today, cur, seasons);
}

function buildData(got, today, cur, seasons) {
  const files = [], records = [];
  for (const g of got) {
    if (!g.json || !Array.isArray(g.json.matches)) continue;
    files.push({ s: g.s, code: g.code, kind: g.kind, n: g.json.matches.length });
    for (const m of g.json.matches) {
      if (!m.team1 || !m.team2 || !m.date) continue;
      const day = parseDay(m.date);
      records.push([cleanName(m.team1), g.s, g.code, day], [cleanName(m.team2), g.s, g.code, day]);
    }
  }
  const cmap = canonicalNames(records);
  const played = [], fixtures = [];
  const teamLeague = new Map();          // this season's team -> league
  for (const g of got) {
    if (!g.json || !Array.isArray(g.json.matches)) continue;
    for (const m of g.json.matches) {
      if (!m.team1 || !m.team2 || !m.date) continue;
      const h = cmap.get(cleanName(m.team1)), a = cmap.get(cleanName(m.team2));
      const day = parseDay(m.date);
      const ft = scoreFt(m.score, day, today);
      if (g.kind === 'league' && g.s === cur) { teamLeague.set(h, g.code); teamLeague.set(a, g.code); }
      const rec = { day, time: m.time || '', h, a, comp: g.code, season: g.s, cup: g.kind === 'cup', round: m.round || '' };
      if (ft) {
        rec.hg = ft[0]; rec.ag = ft[1]; played.push(rec);
      } else if (g.kind === 'league' && g.s === cur) {
        fixtures.push(rec);
      }
    }
  }
  played.sort((x, y) => x.day - y.day);
  fixtures.sort((x, y) => x.day - y.day || x.time.localeCompare(y.time));
  const curFiles = files.filter(f => f.s === cur && f.kind === 'league');
  let merged = 0; for (const [k, v] of cmap) if (k !== v) merged++;
  return { cur, seasons, played, fixtures, teamLeague, files, curFiles, cmap, merged,
    failed: got.filter(g => g.err).length, ofCount: played.length };
}

// Adds what openfootball does not have, from the collector's snapshot (data/latest.js):
// football-data.org results (Champions League, any league result openfootball has not entered yet),
// official tables, Understat xG, bookmaker odds and Elo ratings back to 2018. Optional.
function mergeSnapshot(data, snap) {
  data.snap = snap || null;
  data.odds = new Map(); data.standings = {}; data.xgN = 0; data.extraN = 0; data.cupTeams = new Set(); data.eloStart = null;
  if (!snap) return;
  const cn = n => data.cmap.get(n) || n;
  const today = todayDay();
  const ofCupSeasons = new Set(data.played.filter(r => r.cup).map(r => r.season));
  const near = new Map();              // season|comp|h|a -> [days] of openfootball league matches
  for (const r of data.played) if (!r.cup) {
    const k = `${r.season}|${r.comp}|${r.h}|${r.a}`;
    if (!near.has(k)) near.set(k, []);
    near.get(k).push(r.day);
  }
  for (const e of snap.extra || []) {
    const day = parseDay(e.d), h = cn(e.h), a = cn(e.a);
    if (e.cup) { if (ofCupSeasons.has(e.season)) continue; }            // openfootball caught up: no double count
    else {
      const ds = near.get(`${e.season}|${e.comp}|${h}|${a}`) || [];
      if (ds.some(d => Math.abs(d - day) <= 3)) continue;
    }
    data.played.push({ day, time: '', h, a, comp: e.comp, season: e.season, cup: !!e.cup, round: e.stage || '', hg: e.hg, ag: e.ag, src: e.src });
    data.extraN++;
  }
  data.played.sort((x, y) => x.day - y.day);
  const xg = new Map();
  for (const [k, v] of Object.entries(snap.xg || {})) { const [d, h, a] = k.split('|'); xg.set(`${d}|${cn(h)}|${cn(a)}`, v); }
  for (const r of data.played) {
    const v = xg.get(`${isoDay(r.day)}|${r.h}|${r.a}`);
    if (v) { r.xh = v[0]; r.xa = v[1]; data.xgN++; }
  }
  // Champions League: this season's clubs and upcoming matches
  for (const e of snap.extra || []) if (e.cup && e.season === data.cur) { data.cupTeams.add(cn(e.h)); data.cupTeams.add(cn(e.a)); }
  for (const f of snap.cupFixtures || []) {
    const h = cn(f.h), a = cn(f.a);
    data.cupTeams.add(h); data.cupTeams.add(a);
    const day = parseDay(f.d);
    if (day >= today) data.fixtures.push({ day, time: f.time ? f.time + ' UTC' : '', h, a, comp: UCL, season: f.season, cup: true, round: f.stage || '' });
  }
  data.fixtures.sort((x, y) => x.day - y.day || x.time.localeCompare(y.time));
  for (const t of data.cupTeams) if (!data.teamLeague.has(t)) data.teamLeague.set(t, UCL);
  for (const o of snap.odds || []) if (parseDay(o.d) >= today - 1) data.odds.set(`${cn(o.h)}|${cn(o.a)}`, o);
  data.standings = {};
  for (const [code, t] of Object.entries(snap.standings || {})) data.standings[code] = Object.assign({}, t, { table: (t.table || []).map(r => Object.assign({}, r, { team: cn(r.team) })) });
  // Elo ratings where the page's three seasons begin, computed by the collector from 2018 on
  const el = snap.elo;
  if (el && el.ratings && el.start && parseDay(el.start) === seasonStart(data.seasons[2])) {
    const alias = el.alias || {}, ratings = new Map();
    const members = new Map();
    for (const [raw, c] of data.cmap) { if (!members.has(c)) members.set(c, []); members.get(c).push(raw); }
    for (const [team, raws] of members) {
      for (const n of [team].concat(raws)) {
        const k = Object.prototype.hasOwnProperty.call(el.ratings, n) ? n : alias[n];
        if (k !== undefined && Object.prototype.hasOwnProperty.call(el.ratings, k)) { ratings.set(team, el.ratings[k]); break; }
      }
    }
    for (const t of data.cupTeams) if (!ratings.has(t) && Object.prototype.hasOwnProperty.call(el.ratings, t)) ratings.set(t, el.ratings[t]);
    data.eloStart = { day: parseDay(el.start), ratings, n: ratings.size };
  }
}

/* ------------------------------------------------------------------ model: Dixon-Coles
   Hierarchical, time-decayed Dixon-Coles.
     log E[home goals] = mu + home[competition] + att[home] - def[away]
     log E[away goals] = mu + att[away] - def[home]
   att/def shrink to the team's league mean (sd sigma), league means shrink
   to 0 (sd tau), home advantage per competition shrinks to a shared value.
   Match weight = 2^(-age / half-life). Low-score dependence (rho) as in Dixon-Coles.
   ------------------------------------------------------------------ */
function teamIndex(played, extra) {
  const set = new Set();
  for (const r of played) { set.add(r.h); set.add(r.a); }
  for (const t of extra) set.add(t);
  const teams = [...set].sort();
  return { teams, idx: new Map(teams.map((t, i) => [t, i])) };
}

function fitModel(played, asof, TI, init) {
  const rows = [];
  for (const r of played) { if (r.day < asof) rows.push(r); else break; }
  const T = TI.teams.length, n = rows.length;
  const compList = [...new Set(rows.map(r => r.comp))].sort();
  const ci = new Map(compList.map((c, i) => [c, i])); const C = compList.length;
  const leagueOf = new Map();
  for (const r of rows) if (!r.cup) { leagueOf.set(r.h, r.comp); leagueOf.set(r.a, r.comp); }
  const lgList = [...new Set([...leagueOf.values(), 'other'])].sort();
  const li = new Map(lgList.map((l, i) => [l, i])); const L = lgList.length;
  const tl = new Int32Array(T);
  for (let i = 0; i < T; i++) tl[i] = li.get(leagueOf.get(TI.teams[i]) || 'other');
  const H = new Int32Array(n), A = new Int32Array(n), CC = new Int32Array(n);
  const X = new Float64Array(n), Y = new Float64Array(n), W = new Float64Array(n);
  const GX = new Float64Array(n), GY = new Float64Array(n);     // real scores: rho is estimated on these
  const k = Math.LN2 / CFG.halfLife, xw = CFG.xgWeight || 0;
  for (let m = 0; m < n; m++) {
    const r = rows[m];
    H[m] = TI.idx.get(r.h); A[m] = TI.idx.get(r.a); CC[m] = ci.get(r.comp);
    GX[m] = r.hg; GY[m] = r.ag;
    // targets: goals, or a blend of goals and xG where Understat has the match
    X[m] = xw > 0 && r.xh !== undefined ? (1 - xw) * r.hg + xw * r.xh : r.hg;
    Y[m] = xw > 0 && r.xa !== undefined ? (1 - xw) * r.ag + xw * r.xa : r.ag;
    W[m] = Math.exp(-k * (asof - r.day));
  }
  const att = init ? Float64Array.from(init.att) : new Float64Array(T);
  const dfn = init ? Float64Array.from(init.dfn) : new Float64Array(T);
  const home = new Float64Array(C).fill(0.25);
  if (init) compList.forEach((c, i) => { if (init.ci.has(c)) home[i] = init.home[init.ci.get(c)]; });
  let mu = init ? init.mu : 0.2;
  const LA = new Float64Array(L), LD = new Float64Array(L), cntL = new Float64Array(L);
  for (let i = 0; i < T; i++) cntL[tl[i]]++;
  if (init) for (let i = 0; i < T; i++) { LA[tl[i]] += att[i]; LD[tl[i]] += dfn[i]; }
  if (init) for (let l = 0; l < L; l++) { const den = cntL[l] / CFG.sigma ** 2 + 1 / CFG.tau ** 2; LA[l] = LA[l] / CFG.sigma ** 2 / den; LD[l] = LD[l] / CFG.sigma ** 2 / den; }
  const s2 = CFG.sigma ** 2, t2 = CFG.tau ** 2, h2 = CFG.homeSd ** 2;
  const lam = new Float64Array(n), nu = new Float64Array(n);
  const g = new Float64Array(T), hs = new Float64Array(T);
  const gc = new Float64Array(C), hc = new Float64Array(C);
  const gl = new Float64Array(L), hl = new Float64Array(L), dl = new Float64Array(L);
  const compute = () => {
    for (let m = 0; m < n; m++) {
      lam[m] = Math.exp(mu + home[CC[m]] + att[H[m]] - dfn[A[m]]);
      nu[m] = Math.exp(mu + att[A[m]] - dfn[H[m]]);
    }
  };
  let it = 0;
  for (; it < CFG.maxIter; it++) {
    let maxStep = 0;
    compute();
    g.fill(0); hs.fill(0);
    for (let m = 0; m < n; m++) {
      const w = W[m];
      g[H[m]] += w * (X[m] - lam[m]); g[A[m]] += w * (Y[m] - nu[m]);
      hs[H[m]] += w * lam[m]; hs[A[m]] += w * nu[m];
    }
    for (let i = 0; i < T; i++) {
      const st = (g[i] - (att[i] - LA[tl[i]]) / s2) / (hs[i] + 1 / s2);
      att[i] += st; if (Math.abs(st) > maxStep) maxStep = Math.abs(st);
    }
    compute();
    g.fill(0); hs.fill(0);
    for (let m = 0; m < n; m++) {
      const w = W[m];
      g[A[m]] -= w * (X[m] - lam[m]); g[H[m]] -= w * (Y[m] - nu[m]);
      hs[A[m]] += w * lam[m]; hs[H[m]] += w * nu[m];
    }
    for (let i = 0; i < T; i++) {
      const st = (g[i] - (dfn[i] - LD[tl[i]]) / s2) / (hs[i] + 1 / s2);
      dfn[i] += st; if (Math.abs(st) > maxStep) maxStep = Math.abs(st);
    }
    LA.fill(0); LD.fill(0);
    for (let i = 0; i < T; i++) { LA[tl[i]] += att[i]; LD[tl[i]] += dfn[i]; }
    for (let l = 0; l < L; l++) { const den = cntL[l] / s2 + 1 / t2; LA[l] = LA[l] / s2 / den; LD[l] = LD[l] / s2 / den; }
    // att+c & mu-c (also def+c & mu+c) changes no prediction; only the N(0, tau) prior on the
    // league means sees it, and it is smallest at c = their mean. Without this the iterations crawl.
    let cA = 0, cD = 0;
    for (let l = 0; l < L; l++) { cA += LA[l]; cD += LD[l]; }
    cA /= L; cD /= L;
    for (let i = 0; i < T; i++) { att[i] -= cA; dfn[i] -= cD; }
    for (let l = 0; l < L; l++) { LA[l] -= cA; LD[l] -= cD; }
    mu += cA - cD;
    // Move a whole league (its teams and its mean together): the team priors do not change, one Newton step.
    compute();
    gl.fill(0); hl.fill(0);
    for (let m = 0; m < n; m++) {
      const w = W[m], lh = tl[H[m]], la = tl[A[m]];
      gl[lh] += w * (X[m] - lam[m]); gl[la] += w * (Y[m] - nu[m]);
      hl[lh] += w * lam[m]; hl[la] += w * nu[m];
    }
    for (let l = 0; l < L; l++) { dl[l] = (gl[l] - LA[l] / t2) / (hl[l] + 1 / t2); LA[l] += dl[l]; }
    for (let i = 0; i < T; i++) att[i] += dl[tl[i]];
    compute();
    gl.fill(0); hl.fill(0);
    for (let m = 0; m < n; m++) {
      const w = W[m], lh = tl[H[m]], la = tl[A[m]];
      gl[la] -= w * (X[m] - lam[m]); gl[lh] -= w * (Y[m] - nu[m]);
      hl[la] += w * lam[m]; hl[lh] += w * nu[m];
    }
    for (let l = 0; l < L; l++) { dl[l] = (gl[l] - LD[l] / t2) / (hl[l] + 1 / t2); LD[l] += dl[l]; }
    for (let i = 0; i < T; i++) dfn[i] += dl[tl[i]];
    compute();
    let h0 = 0; for (let c = 0; c < C; c++) h0 += home[c]; h0 /= Math.max(1, C);
    gc.fill(0); hc.fill(0);
    for (let m = 0; m < n; m++) { gc[CC[m]] += W[m] * (X[m] - lam[m]); hc[CC[m]] += W[m] * lam[m]; }
    for (let c = 0; c < C; c++) home[c] += (gc[c] - (home[c] - h0) / h2) / (hc[c] + 1 / h2);
    compute();
    let num = 0, den = 0;
    for (let m = 0; m < n; m++) { num += W[m] * ((X[m] - lam[m]) + (Y[m] - nu[m])); den += W[m] * (lam[m] + nu[m]); }
    if (den > 0) mu += num / den;
    if (maxStep < CFG.tol) { it++; break; }
  }
  // Dixon-Coles rho: profile likelihood on the 0-0, 1-0, 0-1, 1-1 scores
  compute();
  let best = -Infinity, rho = 0;
  for (let q = -50; q <= 20; q++) {
    const r = q * 0.005; let ll = 0, ok = true;
    for (let m = 0; m < n; m++) {
      const x = GX[m], y = GY[m];
      if (x > 1 || y > 1) continue;
      const t = x === 0 && y === 0 ? 1 - lam[m] * nu[m] * r : x === 0 ? 1 + lam[m] * r : y === 0 ? 1 + nu[m] * r : 1 - r;
      if (t <= 0) { ok = false; break; }
      ll += W[m] * Math.log(t);
    }
    if (ok && ll > best) { best = ll; rho = r; }
  }
  return { att, dfn, home, ci, compList, mu, rho, iters: it, n, asof, leagueOf, fit: { H, A, CC, W, tl, L, lgList, cntL } };
}

// Score probabilities up to a size where the Poisson tail left out is below 1e-10 (at least 10 goals).
function goalsCap(l) { let k = 10; const lim = Math.max(l, 0.01); while (k < 40) { let p = Math.exp(-lim), c = p; for (let i = 1; i <= k; i++) { p *= lim / i; c += p; } if (1 - c < 1e-10) break; k += 2; } return k; }
function poissonVec(l, maxg) {
  const v = new Float64Array(maxg + 1); v[0] = Math.exp(-l);
  for (let k = 1; k <= maxg; k++) v[k] = v[k - 1] * l / k;
  return v;
}
function homeAdv(M, comp) {
  if (M.ci.has(comp)) return M.home[M.ci.get(comp)];
  let s = 0; for (const h of M.home) s += h; return s / Math.max(1, M.home.length);
}
// 1X2 from two goal rates, Dixon-Coles adjusted; grid[i][j] = P(home i, away j) when wanted
function dcProbs(lam, nu, rho, wantGrid) {
  const maxg = Math.max(goalsCap(lam), goalsCap(nu));
  const px = poissonVec(lam, maxg), py = poissonVec(nu, maxg);
  const G = wantGrid ? [] : null;
  let tot = 0, pH = 0, pD = 0;
  for (let i = 0; i <= maxg; i++) {
    const row = wantGrid ? new Float64Array(maxg + 1) : null;
    for (let j = 0; j <= maxg; j++) {
      let p = px[i] * py[j];
      if (i === 0 && j === 0) p *= 1 - lam * nu * rho; else if (i === 0 && j === 1) p *= 1 + lam * rho;
      else if (i === 1 && j === 0) p *= 1 + nu * rho; else if (i === 1 && j === 1) p *= 1 - rho;
      tot += p; if (i > j) pH += p; else if (i === j) pD += p;
      if (row) row[j] = p;
    }
    if (G) G.push(row);
  }
  if (G) for (const row of G) for (let j = 0; j < row.length; j++) row[j] /= tot;
  return { pH: pH / tot, pD: pD / tot, pA: 1 - (pH + pD) / tot, grid: G, maxg };
}
function dcRates(M, hi, ai, comp, neutral) {
  const hc = neutral ? 0 : homeAdv(M, comp);
  return [Math.exp(M.mu + hc + M.att[hi] - M.dfn[ai]), Math.exp(M.mu + M.att[ai] - M.dfn[hi])];
}

/* ------------------------------------------------------------------ model: Elo
   Goal-margin Elo, frozen for a week at a time (Monday to Sunday) like the model's weekly refits:
   every match of a week is rated with the ratings from before that week, then the week's results
   are applied. Starts from the collector's ratings (history back to 2018) when the snapshot has
   them. Mirror of elo_run() in collector/collect.py. Sets r.edr = R_home - R_away before the match. */
function eloRun(played, start) {
  const R = new Map(start ? start.ratings : []);
  let k = 0;
  while (k < played.length) {
    const wk = mondayOf(played[k].day); let j = k;
    while (j < played.length && mondayOf(played[j].day) === wk) j++;
    for (let i = k; i < j; i++) {
      const r = played[i];
      for (const t of [r.h, r.a]) if (!R.has(t)) R.set(t, SECOND_TIER.has(r.comp) ? CFG.eloNewSecond : CFG.eloNewTop);
      r.edr = R.get(r.h) - R.get(r.a);
    }
    for (let i = k; i < j; i++) {
      const r = played[i];
      const e = 1 / (1 + 10 ** (-(r.edr + CFG.eloHfa) / 400));
      const gd = Math.abs(r.hg - r.ag);
      const gm = gd <= 1 ? 1 : gd === 2 ? 1.5 : (11 + gd) / 8;
      const s = r.hg > r.ag ? 1 : r.hg === r.ag ? 0.5 : 0;
      const d = CFG.eloK * gm * (s - e);
      R.set(r.h, R.get(r.h) + d); R.set(r.a, R.get(r.a) - d);
    }
    k = j;
  }
  return R;
}
const eloOf = (R, team, league) => (R.has(team) ? R.get(team) : SECOND_TIER.has(league) ? CFG.eloNewSecond : CFG.eloNewTop);

// Elo difference -> 1X2 by an ordered logit refitted on the league matches of the eloMapDays before
// asof: P(away) = s(t1 - b x), P(away or draw) = s(t2 - b x), x = (R_home - R_away) / 400.
const sig = v => 1 / (1 + Math.exp(-v));
function eloMapFit(played, asof, init) {
  const xs = [], os = [];
  for (const r of played) {
    if (r.day >= asof) break;
    if (r.cup || !LG[r.comp] || asof - r.day > CFG.eloMapDays || r.edr === undefined) continue;
    xs.push(r.edr / 400); os.push(r.hg > r.ag ? 0 : r.hg === r.ag ? 1 : 2);
  }
  const n = xs.length;
  if (n < 50) return { b: 1.6, t1: -0.9, t2: 0.25, n };
  // negative log-likelihood and gradient in (b, t1, d), t2 = t1 + exp(d)
  const f = p => {
    const [b, t1, d] = p, ed = Math.exp(d), t2 = t1 + ed;
    let v = 0, gb = 0, g1 = 0, g2 = 0;
    for (let i = 0; i < n; i++) {
      const eta = b * xs[i], F1 = sig(t1 - eta), F2 = sig(t2 - eta);
      if (os[i] === 2) { v -= Math.log(Math.max(F1, 1e-300)); g1 -= 1 - F1; gb += (1 - F1) * xs[i]; }
      else if (os[i] === 0) { v -= Math.log(Math.max(1 - F2, 1e-300)); g2 += F2; gb -= F2 * xs[i]; }
      else {
        const pd = Math.max(F2 - F1, 1e-300), f1 = F1 * (1 - F1), f2 = F2 * (1 - F2);
        v -= Math.log(pd); g1 += f1 / pd; g2 -= f2 / pd; gb -= (f1 - f2) / pd * xs[i];
      }
    }
    return [v, [gb, g1 + g2, g2 * ed]];
  };
  // BFGS with a backtracking line search; three parameters, warm-started from the previous week
  let p = init ? [init.b, init.t1, Math.log(Math.max(init.t2 - init.t1, 1e-6))] : [1.6, -0.9, Math.log(1.15)];
  let [fv, gv] = f(p);
  let Hi = [[1e-3, 0, 0], [0, 1e-3, 0], [0, 0, 1e-3]];
  for (let it = 0; it < 200; it++) {
    const dir = [0, 1, 2].map(r => -(Hi[r][0] * gv[0] + Hi[r][1] * gv[1] + Hi[r][2] * gv[2]));
    let slope = dir[0] * gv[0] + dir[1] * gv[1] + dir[2] * gv[2];
    if (slope >= 0) { Hi = [[1e-3, 0, 0], [0, 1e-3, 0], [0, 0, 1e-3]]; continue; }
    let step = 1, np, nf, ng;
    for (let ls = 0; ls < 40; ls++) {
      np = p.map((v, r) => v + step * dir[r]);
      [nf, ng] = f(np);
      if (nf <= fv + 1e-4 * step * slope) break;
      step *= 0.5;
    }
    const s = np.map((v, r) => v - p[r]), y = ng.map((v, r) => v - gv[r]);
    const sy = s[0] * y[0] + s[1] * y[1] + s[2] * y[2];
    const done = Math.abs(fv - nf) < 1e-10 * Math.max(1, Math.abs(fv)) && Math.max(...s.map(Math.abs)) < 1e-7;
    p = np; fv = nf; gv = ng;
    if (done || Math.max(...gv.map(Math.abs)) < 1e-6) break;
    if (sy > 1e-12) {
      const rho = 1 / sy, Hy = [0, 1, 2].map(r => Hi[r][0] * y[0] + Hi[r][1] * y[1] + Hi[r][2] * y[2]);
      const yHy = y[0] * Hy[0] + y[1] * Hy[1] + y[2] * Hy[2];
      for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) Hi[r][c] += (1 + yHy * rho) * rho * s[r] * s[c] - rho * (Hy[r] * s[c] + s[r] * Hy[c]);
    }
  }
  return { b: p[0], t1: p[1], t2: p[1] + Math.exp(p[2]), n };
}
function eloMapProbs(mp, x, neutral) {
  let t1 = mp.t1, t2 = mp.t2;
  if (neutral) { const c = (t1 + t2) / 2; t1 -= c; t2 -= c; }     // symmetric: no home side
  const F1 = sig(t1 - mp.b * x), F2 = sig(t2 - mp.b * x);
  return [1 - F2, F2 - F1, F1];
}

/* ------------------------------------------------------------------ forecasts */
// Everything the page and the archive need, fitted as of asof (a day number: data before it).
function prepare(data, asof) {
  const TI = teamIndex(data.played, data.teamLeague.keys());
  const M = fitModel(data.played, asof, TI, null);
  const elo = eloRun(data.played, data.eloStart);
  const map = eloMapFit(data.played, asof, null);
  return { data, TI, M, elo, map, asof };
}

// MatchLab's forecast: (1 - eloWeight) x Dixon-Coles + eloWeight x Elo. The score grid is Dixon-Coles'
// with its home-win / draw / away-win blocks rescaled to the blended 1X2, so every number shown agrees.
function forecast(st, h, a, comp, neutral) {
  const hi = st.TI.idx.get(h), ai = st.TI.idx.get(a);
  const [lam, nu] = dcRates(st.M, hi, ai, comp, neutral);
  const dc = dcProbs(lam, nu, st.M.rho, true);
  const x = (eloOf(st.elo, h, st.data.teamLeague.get(h)) - eloOf(st.elo, a, st.data.teamLeague.get(a))) / 400;
  const pe = eloMapProbs(st.map, x, neutral);
  const w = CFG.eloWeight;
  const pH = (1 - w) * dc.pH + w * pe[0], pD = (1 - w) * dc.pD + w * pe[1], pA = (1 - w) * dc.pA + w * pe[2];
  const fH = dc.pH > 0 ? pH / dc.pH : 1, fD = dc.pD > 0 ? pD / dc.pD : 1, fA = dc.pA > 0 ? pA / dc.pA : 1;
  const G = dc.grid;
  let o25 = 0, btts = 0, csH = 0, csA = 0;
  const list = [];
  for (let i = 0; i <= dc.maxg; i++) for (let j = 0; j <= dc.maxg; j++) {
    const p = G[i][j] * (i > j ? fH : i === j ? fD : fA); G[i][j] = p;
    if (i + j >= 3) o25 += p;
    if (i > 0 && j > 0) btts += p;
    if (j === 0) csH += p;
    if (i === 0) csA += p;
    if (i <= 9 && j <= 9) list.push({ i, j, p });
  }
  list.sort((u, v) => v.p - u.p);
  return { pH, pD, pA, lam, nu, grid: G, maxg: dc.maxg, o25, btts, csH, csA, top: list.slice(0, 6),
    dc: [dc.pH, dc.pD, dc.pA], elo: pe, eloDiff: x * 400 };
}

/* ------------------------------------------------------------------ uncertainty (Laplace approximation)
   The fitted ratings are the peak of a posterior; its curvature (the Hessian of the negative log
   posterior: data + league and home priors) gives their covariance. Full matrix, so league-level
   uncertainty - what makes cross-league matches shakier - is included. */
function laplace(st) {
  const M = st.M, F = M.fit, T = st.TI.teams.length, L = F.L, C = M.compList.length;
  const oA = 0, oD = T, oLA = 2 * T, oLD = 2 * T + L, oH = 2 * T + 2 * L, oMu = 2 * T + 2 * L + C, N = oMu + 1;
  const Hm = new Float64Array(N * N);
  const add = (i, j, v) => { Hm[i * N + j] += v; };
  const n = F.W.length;
  for (let m = 0; m < n; m++) {
    const h = F.H[m], a = F.A[m], c = F.CC[m], w = F.W[m];
    const lam = w * Math.exp(M.mu + M.home[c] + M.att[h] - M.dfn[a]);
    const nu = w * Math.exp(M.mu + M.att[a] - M.dfn[h]);
    const v1 = [[oA + h, 1], [oD + a, -1], [oH + c, 1], [oMu, 1]];
    for (const [i, si] of v1) for (const [j, sj] of v1) add(i, j, lam * si * sj);
    const v2 = [[oA + a, 1], [oD + h, -1], [oMu, 1]];
    for (const [i, si] of v2) for (const [j, sj] of v2) add(i, j, nu * si * sj);
  }
  const is2 = 1 / CFG.sigma ** 2, it2 = 1 / CFG.tau ** 2, ih2 = 1 / CFG.homeSd ** 2;
  for (let i = 0; i < T; i++) {
    const l = F.tl[i];
    for (const [o, ol] of [[oA, oLA], [oD, oLD]]) { add(o + i, o + i, is2); add(ol + l, ol + l, is2); add(o + i, ol + l, -is2); add(ol + l, o + i, -is2); }
  }
  for (let l = 0; l < L; l++) { add(oLA + l, oLA + l, it2); add(oLD + l, oLD + l, it2); }
  for (let c = 0; c < C; c++) for (let d = 0; d < C; d++) add(oH + c, oH + d, ((c === d ? 1 : 0) - 1 / C) * ih2);
  for (let i = 0; i < N; i++) add(i, i, 1e-9);
  // Cholesky, in place (lower triangle)
  for (let j = 0; j < N; j++) {
    let s = Hm[j * N + j];
    for (let k = 0; k < j; k++) s -= Hm[j * N + k] * Hm[j * N + k];
    if (s <= 0) return null;
    const d = Math.sqrt(s); Hm[j * N + j] = d;
    for (let i = j + 1; i < N; i++) {
      let t = Hm[i * N + j];
      for (let k = 0; k < j; k++) t -= Hm[i * N + k] * Hm[j * N + k];
      Hm[i * N + j] = t / d;
    }
  }
  const solve = g => {              // x = H^-1 g
    const y = new Float64Array(N);
    for (let i = 0; i < N; i++) { let s = g[i]; for (let k = 0; k < i; k++) s -= Hm[i * N + k] * y[k]; y[i] = s / Hm[i * N + i]; }
    for (let i = N - 1; i >= 0; i--) { let s = y[i]; for (let k = i + 1; k < N; k++) s -= Hm[k * N + i] * y[k]; y[i] = s / Hm[i * N + i]; }
    return y;
  };
  const vec = parts => { const g = new Float64Array(N); for (const [i, v] of parts) g[i] += v; return g; };
  const dot = (a, b) => { let s = 0; for (let i = 0; i < N; i++) s += a[i] * b[i]; return s; };
  return { st, N, solve, vec, dot, oA, oD, oH, oMu };
}
// fixed standard-normal pairs (Box-Muller on a seeded generator): the range does not jitter between renders
const NORMALS = (() => {
  let s = 12345; const u = () => { s = (Math.imul(s ^ (s >>> 15), 1 | s) + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const out = [];
  for (let k = 0; k < 400; k++) { const a = Math.max(u(), 1e-12), b = u(); const r = Math.sqrt(-2 * Math.log(a)); out.push([r * Math.cos(2 * Math.PI * b), r * Math.sin(2 * Math.PI * b)]); }
  return out;
})();
// 90% range of the blended 1X2 from the uncertainty in the Dixon-Coles ratings (Elo part held fixed)
function forecastRange(lap, h, a, comp, neutral, P) {
  const st = lap.st, M = st.M, hi = st.TI.idx.get(h), ai = st.TI.idx.get(a);
  const parts1 = [[lap.oA + hi, 1], [lap.oD + ai, -1], [lap.oMu, 1]];
  if (!neutral && M.ci.has(comp)) parts1.push([lap.oH + M.ci.get(comp), 1]);
  const g1 = lap.vec(parts1), g2 = lap.vec([[lap.oA + ai, 1], [lap.oD + hi, -1], [lap.oMu, 1]]);
  const x1 = lap.solve(g1), x2 = lap.solve(g2);
  const v11 = lap.dot(g1, x1), v22 = lap.dot(g2, x2), v12 = lap.dot(g1, x2);
  const a11 = Math.sqrt(Math.max(v11, 0)), a21 = a11 > 0 ? v12 / a11 : 0, a22 = Math.sqrt(Math.max(v22 - a21 * a21, 0));
  const e1 = Math.log(P.lam), e2 = Math.log(P.nu), w = CFG.eloWeight;
  const hs = [], ds = [], as = [];
  for (const [z1, z2] of NORMALS) {
    const p = dcProbs(Math.exp(e1 + a11 * z1), Math.exp(e2 + a21 * z1 + a22 * z2), M.rho, false);
    hs.push((1 - w) * p.pH + w * P.elo[0]); ds.push((1 - w) * p.pD + w * P.elo[1]); as.push((1 - w) * p.pA + w * P.elo[2]);
  }
  const q = (arr, f) => { const s = arr.slice().sort((u, v) => u - v); return s[Math.min(s.length - 1, Math.max(0, Math.round(f * (s.length - 1))))]; };
  return { h: [q(hs, 0.05), q(hs, 0.95)], d: [q(ds, 0.05), q(ds, 0.95)], a: [q(as, 0.05), q(as, 0.95)], sdHome: a11, sdAway: Math.sqrt(v22) };
}
// standard error of a team's goal difference per match against the reference opponent - the
// average of refTeams (delta method). The reference's own ratings are in the gradient: without them
// the shifts that change no prediction (all attacks +c, mu -c) would count as uncertainty.
function strengthSe(lap, team, xg, xga, refTeams) {
  const idx = lap.st.TI.idx, i = idx.get(team), K = refTeams.length;
  const parts = [[lap.oA + i, xg], [lap.oD + i, xga], [lap.oMu, xg - xga]];
  for (const t of refTeams) { const j = idx.get(t); parts.push([lap.oD + j, -xg / K], [lap.oA + j, -xga / K]); }
  const g = lap.vec(parts);
  return Math.sqrt(Math.max(lap.dot(g, lap.solve(g)), 0));
}

/* ------------------------------------------------------------------ scoring */
// log-loss, Brier and ranked probability score of one forecast [H, D, A] for outcome o (0 H, 1 D, 2 A)
function scoreOne(p, o) {
  const ll = -Math.log(Math.max(p[o], 1e-12));
  let br = 0; for (let k = 0; k < 3; k++) br += (p[k] - (k === o ? 1 : 0)) ** 2;
  const c1 = p[0] - (o === 0 ? 1 : 0), c2 = p[0] + p[1] - (o <= 1 ? 1 : 0);
  return { ll, br, rps: (c1 * c1 + c2 * c2) / 2 };
}

/* ------------------------------------------------------------------ backtest (walk-forward)
   Each week both models are refitted on the matches before that week only, then forecast that
   week's matches. Pure and synchronous, so it runs unchanged inside a Web Worker. Needs r.edr
   from eloRun() on the same data. onWeek(done, total) reports progress. */
function walkForward(played, TI, evalComps, startDay, endDay, onWeek) {
  const out = { n: 0, ll: 0, base: 0, brier: 0, rps: 0, acc: 0, home: 0, llDc: 0, llElo: 0,
    bins: Array.from({ length: 10 }, () => ({ n: 0, p: 0, hit: 0 })) };
  let init = null, minit = null;
  const first = mondayOf(startDay);
  const weeks = Math.max(1, Math.ceil((endDay - first) / 7));
  const w = CFG.eloWeight;
  for (let wn = 0, wk = first; wk < endDay; wk += 7, wn++) {
    const test = played.filter(r => r.day >= wk && r.day < wk + 7 && evalComps.has(r.comp) && TI.idx.has(r.h) && TI.idx.has(r.a));
    if (test.length) {
      const M = fitModel(played, wk, TI, init); init = M;
      const mp = eloMapFit(played, wk, minit); minit = mp;
      let bh = 0, bd = 0, ba = 0;
      for (const r of played) { if (r.day >= wk) break; if (wk - r.day < 730 && evalComps.has(r.comp)) { if (r.hg > r.ag) bh++; else if (r.hg === r.ag) bd++; else ba++; } }
      const bt = bh + bd + ba || 1; const base = [bh / bt, bd / bt, ba / bt];
      for (const r of test) {
        const [lam, nu] = dcRates(M, TI.idx.get(r.h), TI.idx.get(r.a), r.comp, false);
        const dc = dcProbs(lam, nu, M.rho, false);
        const pe = eloMapProbs(mp, (r.edr || 0) / 400, false);
        const pv = [(1 - w) * dc.pH + w * pe[0], (1 - w) * dc.pD + w * pe[1], (1 - w) * dc.pA + w * pe[2]];
        const o = r.hg > r.ag ? 0 : r.hg === r.ag ? 1 : 2;
        const s = scoreOne(pv, o);
        out.ll += s.ll; out.brier += s.br; out.rps += s.rps;
        out.base -= Math.log(Math.max(base[o], 1e-12));
        out.llDc -= Math.log(Math.max([dc.pH, dc.pD, dc.pA][o], 1e-12));
        out.llElo -= Math.log(Math.max(pe[o], 1e-12));
        if (pv.indexOf(Math.max(...pv)) === o) out.acc++;
        if (o === 0) out.home++;
        for (let k = 0; k < 3; k++) { const bi = Math.min(9, Math.floor(pv[k] * 10)); out.bins[bi].n++; out.bins[bi].p += pv[k]; out.bins[bi].hit += k === o ? 1 : 0; }
        out.n++;
      }
    }
    if (onWeek) onWeek(wn + 1, weeks);
  }
  return out;
}
// expected calibration error over the three outcome probabilities, from walk-forward bins
function eceOf(bins) {
  let n = 0, e = 0;
  for (const b of bins) { n += b.n; if (b.n) e += Math.abs(b.p - b.hit); }
  return n ? e / n : 0;
}

/* ------------------------------------------------------------------ forecast archive (live track record)
   Every fixture of the next 7 days gets a forecast; it is updated on each run until the match day
   begins (00:00 UTC), then locked for good, and scored once the result is in. The archive lives in
   data/forecasts.json in the repository, so its git history shows every change. */
function forecastKey(f) {
  const regular = !f.cup && (!f.round || /^matchday/i.test(f.round));
  return regular ? `${f.season}|${f.comp}|${f.h}|${f.a}` : `${f.season}|${f.comp}|${isoDay(f.day)}|${f.h}|${f.a}`;
}
const r4 = v => Math.round(v * 1e4) / 1e4;
function issueForecasts(archive, st, nowMs) {
  const today = utcDayOf(nowMs), iso = new Date(nowMs).toISOString().slice(0, 19) + 'Z';
  const data = st.data, dv = data.snap ? data.snap.generated : null;
  let issued = 0;
  for (const f of data.fixtures) {
    if (f.day <= today || f.day > today + 7) continue;            // locked from the match day on
    if (!st.TI.idx.has(f.h) || !st.TI.idx.has(f.a)) continue;
    const key = forecastKey(f), old = archive.forecasts[key];
    if (old && (old.res || old.void || parseDay(old.d) <= today)) continue;
    const P = forecast(st, f.h, f.a, f.comp, false);
    const mk = data.odds.get(`${f.h}|${f.a}`);
    archive.forecasts[key] = {
      d: isoDay(f.day), h: f.h, a: f.a, comp: f.comp, season: f.season, round: f.round || '',
      first: old ? old.first : iso, issued: iso, updates: (old ? old.updates : 0) + 1,
      p: [r4(P.pH), r4(P.pD), r4(P.pA)], dc: P.dc.map(r4), elo: P.elo.map(r4), xg: [r4(P.lam), r4(P.nu)],
      mkt: mk ? mk.p.map(r4) : null, model: ENGINE_VERSION, cfg: CFG_HASH, data: dv,
    };
    issued++;
  }
  return issued;
}
function settleForecasts(archive, data, today) {
  const byKey = new Map();
  for (const r of data.played) byKey.set(forecastKey(r), r);
  let settled = 0;
  for (const [key, e] of Object.entries(archive.forecasts)) {
    if (e.res || e.void) continue;
    const r = byKey.get(key);
    if (r) {
      // a result from before the forecast was issued would not be a forecast
      if (r.day < parseDay(e.issued.slice(0, 10))) { e.void = 'played before the forecast'; continue; }
      const o = r.hg > r.ag ? 0 : r.hg === r.ag ? 1 : 2;
      const s = scoreOne(e.p, o);
      e.res = [r.hg, r.ag]; e.o = o; e.played = isoDay(r.day);
      e.ll = r4(s.ll); e.br = r4(s.br); e.rps = r4(s.rps);
      if (e.mkt) e.mll = r4(scoreOne(e.mkt, o).ll);
      settled++;
    } else if (today > parseDay(e.d) + 45) {
      e.void = 'no result within 45 days';
    }
  }
  return settled;
}
function trackSummary(archive, nowMs) {
  const all = Object.values(archive.forecasts);
  const done = all.filter(e => e.res);
  const mean = (arr, f) => (arr.length ? arr.reduce((s, e) => s + f(e), 0) / arr.length : null);
  const withM = done.filter(e => e.mkt && e.mll !== undefined);
  const today = utcDayOf(nowMs);
  const recent = done.slice().sort((u, v) => cmpStr(v.played, u.played) || cmpStr(u.h, v.h)).slice(0, 40)
    .map(e => ({ d: e.played, h: e.h, a: e.a, comp: e.comp, p: e.p, res: e.res, ll: e.ll, issued: e.issued }));
  const locked = all.filter(e => !e.res && !e.void && parseDay(e.d) <= today).length;
  const open = all.filter(e => !e.res && !e.void && parseDay(e.d) > today).length;
  let since = null; for (const e of all) if (!since || e.first < since) since = e.first;
  return {
    generated: new Date(nowMs).toISOString().slice(0, 19) + 'Z', model: ENGINE_VERSION, cfg: CFG_HASH, since,
    total: all.length, settled: done.length, locked, open, void: all.filter(e => e.void).length,
    ll: mean(done, e => e.ll), brier: mean(done, e => e.br), rps: mean(done, e => e.rps),
    acc: mean(done, e => (e.p.indexOf(Math.max(...e.p)) === e.o ? 1 : 0)),
    llDc: mean(done, e => -Math.log(Math.max(e.dc[e.o], 1e-12))), llElo: mean(done, e => -Math.log(Math.max(e.elo[e.o], 1e-12))),
    market: withM.length ? { n: withM.length, ll: mean(withM, e => e.mll), llModel: mean(withM, e => e.ll) } : null,
    recent,
  };
}

Object.assign(root, {
  ENGINE_VERSION, CFG, CFG_HASH, BASE, LEAGUES, HISTORY_ONLY, CUPS, UCL, SECOND_TIER, LG,
  DAYMS, parseDay, todayDay, utcDayOf, dayDate, isoDay, mondayOf, seasonKeyOf, seasonStart, prevSeason,
  cleanName, toks, canonicalNames, scoreFt, loadData, buildData, mergeSnapshot,
  teamIndex, fitModel, goalsCap, poissonVec, homeAdv, dcProbs, dcRates,
  eloRun, eloOf, eloMapFit, eloMapProbs, prepare, forecast, laplace, forecastRange, strengthSe,
  scoreOne, walkForward, eceOf, forecastKey, issueForecasts, settleForecasts, trackSummary,
  matchlabEngine,
});
}
matchlabEngine(typeof window !== 'undefined' ? window : globalThis);
