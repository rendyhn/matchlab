/* ==================================================================
   MatchLab engine - everything that turns match data into forecasts, with no page code in it.
   The same file runs in the page (index.html), in the page's backtest worker and on GitHub
   (collector/forecast.mjs, Node), so the archived forecasts come from exactly the code the page
   runs. All of it lives in one function so the worker can be given its source text.
   ================================================================== */
function matchlabEngine(root) {
'use strict';

const ENGINE_VERSION = 'v7';

/* ------------------------------------------------------------------ config */
// Results and fixtures: ESPN's public scoreboard API (collector/espn.py builds the snapshot's
// `matches`; the page adds the current month live). Same team id in every season and division.
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/soccer/';
// top: the seven big first divisions (the power ranking's reference opponent);
// proj: double round-robin with known places, so the season projection applies.
const LEAGUES = [
  { code: 'en.1', name: 'Premier League', short: 'PL', top: true, tier: 1, proj: true, espn: 'eng.1' },
  { code: 'es.1', name: 'La Liga', short: 'LALIGA', top: true, tier: 1, proj: true, espn: 'esp.1' },
  { code: 'de.1', name: 'Bundesliga', short: 'BUNDES', top: true, tier: 1, proj: true, espn: 'ger.1' },
  { code: 'it.1', name: 'Serie A', short: 'SERIE A', top: true, tier: 1, proj: true, espn: 'ita.1' },
  { code: 'fr.1', name: 'Ligue 1', short: 'LIGUE 1', top: true, tier: 1, proj: true, espn: 'fra.1' },
  { code: 'nl.1', name: 'Eredivisie', short: 'EREDIV', top: true, tier: 1, proj: true, espn: 'ned.1' },
  { code: 'pt.1', name: 'Liga Portugal', short: 'PORTUGAL', top: true, tier: 1, proj: true, espn: 'por.1' },
  { code: 'en.2', name: 'Championship', short: 'CHAMP', top: false, tier: 2, proj: true, espn: 'eng.2' },
  { code: 'be.1', name: 'Belgian Pro League', short: 'BELGIUM', top: false, tier: 1, proj: false, espn: 'bel.1' },
  { code: 'tr.1', name: 'Süper Lig', short: 'TÜRKİYE', top: false, tier: 1, proj: false, espn: 'tur.1' },
  { code: 'sc.1', name: 'Scottish Premiership', short: 'SCOTLAND', top: false, tier: 1, proj: false, espn: 'sco.1' },
  { code: 'at.1', name: 'Austrian Bundesliga', short: 'AUSTRIA', top: false, tier: 1, proj: false, espn: 'aut.1' },
  { code: 'gr.1', name: 'Super League Greece', short: 'GREECE', top: false, tier: 1, proj: false, espn: 'gre.1' },
  { code: 'dk.1', name: 'Danish Superliga', short: 'DENMARK', top: false, tier: 1, proj: false, espn: 'den.1' },
];
const HISTORY = [{ code: 'es.2', espn: 'esp.2' }, { code: 'de.2', espn: 'ger.2' }, { code: 'it.2', espn: 'ita.2' }, { code: 'fr.2', espn: 'fra.2' }];
const HISTORY_ONLY = HISTORY.map(h => h.code);          // history of promoted clubs
// The links between league strengths
const CUP_LIST = [
  { code: 'uefa.cl', name: 'Champions League', short: 'UCL', espn: 'uefa.champions' },
  { code: 'uefa.el', name: 'Europa League', short: 'UEL', espn: 'uefa.europa' },
  { code: 'uefa.ecl', name: 'Conference League', short: 'UECL', espn: 'uefa.europa.conf' },
];
const CUPS = CUP_LIST.map(c => c.code);
const CUP = Object.fromEntries(CUP_LIST.map(c => [c.code, c]));
const UCL = 'uefa.cl';
const SECOND_TIER = new Set(['en.2'].concat(HISTORY_ONLY));
const LG = Object.fromEntries(LEAGUES.map(l => [l.code, l]));
// the Elo -> 1X2 mapping is fitted on v6's eight leagues, as in model-lab/lab.py where it was tested
const ELO_MAP_COMPS = new Set(['en.1', 'es.1', 'de.1', 'it.1', 'fr.1', 'nl.1', 'pt.1', 'en.2']);
const ALL_COMPS = LEAGUES.map(l => ({ code: l.code, espn: l.espn, kind: 'league' }))
  .concat(HISTORY.map(h => ({ code: h.code, espn: h.espn, kind: 'history' })), CUP_LIST.map(c => ({ code: c.code, espn: c.espn, kind: 'cup' })));
// Every setting below was checked by nested walk-forward validation in model-lab/lab.py
// (model-lab/RESULTS.md): chosen on 2022/23-2023/24, then tested untouched on 2024/25-2026/27.
//   halfLife/sigma/tau/homeSd/xgWeight: the grid's best values on 2022/23-2023/24 beat these by
//     0.0007 there (noise, +-0.0010) and lost 0.0003 on the test seasons - the v1 values stay.
//   Dixon-Coles rho vs plain Poisson: Poisson is worse by 0.0008 (+-0.0004) on the test seasons.
//   xG as 60% of the fit's targets vs a separate xG model blended on log rates: equal (+0.0001 +-0.0003).
//   Elo blend 35% (eloWeight, chosen on 2022/23-2023/24): -0.0020 (+-0.0012) log-loss on the test
//     seasons, better in each of them; needs Elo history back to 2018 (snapshot.elo from the collector).
//   A recalibration layer on top gained -0.0004 (+-0.0012) on the test seasons - not used.
// v7 (ESPN data, same protocol, model-lab/RESULTS.md):
//   every competition in the fit (6 more leagues, Europa and Conference League) + shot-based expected
//   goals (0.356 x shots on target) as 40% of the target where Understat has no xG (shotWeight, chosen
//   on 2022/23-2023/24). v6's eight leagues: -0.0012 (+-0.0016) log-loss on the test seasons for
//   Dixon-Coles alone, -0.0008 (+-0.0010) after the Elo blend - better in all five seasons, within the
//   noise. The six new leagues: shots -0.0024 (+-0.0021) on the test seasons.
//   eloWeight 0.40: the blend weight chosen on 2022/23-2023/24 with Elo from every competition.
const CFG = {
  halfLife: 240, sigma: 0.5, tau: 0.5, homeSd: 0.1, maxIter: 400, tol: 1e-5, xgWeight: 0.6, shotWeight: 0.4,
  eloK: 20, eloHfa: 70, eloNewTop: 1500, eloNewSecond: 1350, eloWeight: 0.4, eloMapDays: 730,
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
// The snapshot's matches (collector: data/latest.json "matches") as records. A row is
// [event id, day number, 'HH:MM' UTC, competition index, season start year, home index, away index,
//  home goals, away goals, home shot xG, away shot xG, flags (1 extra time, 2 neutral venue), stage].
// Goals are null for a fixture; extra-time results have no 90-minute score and are not used.
function decodeMatches(M) {
  const out = [];
  for (const r of M.rows) {
    const [id, day, time, ci, sy, hi, ai, hg, ag, sxh, sxa, flags, stage] = r;
    const comp = M.comps[ci];
    const rec = { id: String(id), day, time: time || '', h: M.teams[hi][1], a: M.teams[ai][1], comp,
      season: `${sy}-${String((sy + 1) % 100).padStart(2, '0')}`, cup: !!CUP[comp], round: stage || '',
      neutral: !!(flags & 2), et: !!(flags & 1) };
    if (hg !== null && hg !== undefined) { rec.hg = hg; rec.ag = ag; }
    if (sxh !== null && sxh !== undefined) { rec.sxh = sxh; rec.sxa = sxa; }
    out.push(rec);
  }
  return out;
}

// One ESPN event -> record (mirror of normalise() in collector/espn.py), or null.
function espnRecord(ev, comp, label, coef) {
  const c = ev.competitions && ev.competitions[0];
  if (!c || !c.competitors) return null;
  const h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
  if (!h || !a) return null;
  const st = (ev.status && ev.status.type) || {};
  const ms = Date.parse(ev.date);
  const sy = ev.season && Number.isInteger(ev.season.year) ? ev.season.year : +seasonKeyOf(utcDayOf(ms)).slice(0, 4);
  const stage = ev.season && ev.season.slug && ev.season.slug !== 'regular-season' ? ev.season.slug : '';
  const rec = { id: String(ev.id), day: utcDayOf(ms), time: new Date(ms).toISOString().slice(11, 16), comp,
    h: label(h.team), a: label(a.team), season: `${sy}-${String((sy + 1) % 100).padStart(2, '0')}`, cup: !!CUP[comp],
    round: stage, neutral: !!c.neutralSite, et: st.name === 'STATUS_FINAL_AET' || st.name === 'STATUS_FINAL_PEN' };
  if (st.completed) {
    const hg = parseInt(h.score, 10), ag = parseInt(a.score, 10);
    if (!(hg >= 0 && ag >= 0)) return null;
    rec.hg = hg; rec.ag = ag;
    const stat = (x, n) => { const s = (x.statistics || []).find(v => v.name === n); const v = s ? parseInt(s.displayValue, 10) : NaN; return Number.isFinite(v) ? v : null; };
    const hs = stat(h, 'totalShots'), as = stat(a, 'totalShots'), ht = stat(h, 'shotsOnTarget'), at = stat(a, 'shotsOnTarget');
    if (coef && hs !== null && as !== null && ht !== null && at !== null) {
      rec.sxh = Math.round(100 * (coef[0] * ht + coef[1] * (hs - ht))) / 100;
      rec.sxa = Math.round(100 * (coef[0] * at + coef[1] * (as - at))) / 100;
    }
  } else if (st.state !== 'pre' || /POSTPONED|CANCELED|ABANDONED/.test(st.name || '')) {
    return null;                       // live, postponed or cancelled: neither a result nor a fixture yet
  }
  return rec;
}

const ymOf = day => { const d = dayDate(day); return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`; };

// The snapshot's matches, then this month's (and in a month's first week the previous month's) results
// and fixtures straight from ESPN, so a result from an hour ago is in even between collector runs.
// fetchJson(url) -> parsed JSON or null; it may throw. A competition-month that fails keeps the
// snapshot's rows (counted in data.failed). Returns null without a snapshot.
async function loadData(fetchJson, onProgress, snap) {
  const M = snap && snap.matches;
  if (!M || !Array.isArray(M.rows) || !M.rows.length) return null;
  const today = todayDay();
  const cur = seasonKeyOf(today);
  const seasons = [cur, prevSeason(cur), prevSeason(prevSeason(cur))];
  const recs = decodeMatches(M);
  // team id -> the snapshot's name; a club ESPN shows for the first time keeps ESPN's name
  const byId = new Map(M.teams.map(([id, name]) => [String(id), name]));
  const names = new Set(byId.values());
  const label = t => {
    const id = String(t.id);
    if (!byId.has(id)) { let n = t.displayName || t.name || id; if (names.has(n)) n += ` #${id}`; byId.set(id, n); names.add(n); }
    return byId.get(id);
  };
  const months = [ymOf(today)];
  if (dayDate(today).getUTCDate() <= 7) months.push(ymOf(today - 8));
  const jobs = [];
  for (const c of ALL_COMPS) for (const ym of months) jobs.push({ c, ym });
  let done = 0, failed = 0, live = 0;
  const got = await Promise.all(jobs.map(async j => {
    try {
      const js = await fetchJson(`${ESPN}${j.c.espn}/scoreboard?dates=${j.ym}`);
      return js && Array.isArray(js.events) ? js.events.map(ev => espnRecord(ev, j.c.code, label, M.shot)).filter(Boolean) : [];
    } catch (e) {
      failed++; return [];
    } finally {
      if (onProgress) onProgress(++done, jobs.length);
    }
  }));
  const byEvent = new Map(recs.map(r => [r.id, r]));
  for (const list of got) for (const r of list) {
    const old = byEvent.get(r.id);
    if (!old || old.hg === undefined || r.hg !== undefined) { if (!old || old.hg === undefined) live += r.hg !== undefined ? 1 : 0; byEvent.set(r.id, r); }
  }
  // a fixture dropped from this month's live list (postponed) is dropped here too
  const liveIds = new Set(got.flat().map(r => r.id));
  const liveComps = new Set(jobs.map(j => j.c.code));
  const monthSet = new Set(months);
  const all = [...byEvent.values()].filter(r => r.hg !== undefined || !(liveComps.has(r.comp) && monthSet.has(ymOf(r.day)) && !liveIds.has(r.id) && failed === 0));
  return buildData(all, today, cur, seasons, { failed, live, generated: M.generated || (snap && snap.generated) });
}

function buildData(recs, today, cur, seasons, info) {
  const inWindow = new Set(seasons);
  const played = [], fixtures = [];
  const teamLeague = new Map();          // this season's team -> league (cup-only clubs -> their cup)
  const cupTeams = new Set();
  for (const r of recs) {
    if (!inWindow.has(r.season)) continue;
    if (r.season === cur) {
      if (LG[r.comp]) { teamLeague.set(r.h, r.comp); teamLeague.set(r.a, r.comp); }
      else if (r.cup) { cupTeams.add(r.h); cupTeams.add(r.a); }
    }
    if (r.hg !== undefined) { if (!r.et) played.push(r); }
    else if (r.day >= today && r.season === cur && (LG[r.comp] || r.cup)) fixtures.push(r);
  }
  for (const r of recs) if (r.cup && r.season === cur) for (const t of [r.h, r.a]) if (!teamLeague.has(t)) teamLeague.set(t, r.comp);
  played.sort((x, y) => x.day - y.day || x.time.localeCompare(y.time) || cmpStr(x.id, y.id));
  fixtures.sort((x, y) => x.day - y.day || x.time.localeCompare(y.time) || cmpStr(x.h, y.h));
  const curComps = [...new Set(played.filter(r => r.season === cur && LG[r.comp]).map(r => r.comp))];
  return { cur, seasons, played, fixtures, teamLeague, cupTeams, curComps,
    // kept for older callers: one file per competition with matches this season
    curFiles: curComps.map(code => ({ s: cur, code, kind: 'league' })), files: [], cmap: new Map(), merged: 0,
    failed: info.failed, liveN: info.live, ofCount: played.length };
}

// Adds the snapshot's other sections: Understat xG, official tables, bookmaker odds and Elo ratings
// back to 2018 (all keyed by the same ESPN team names). Optional.
function mergeSnapshot(data, snap) {
  data.snap = snap || null;
  data.odds = new Map(); data.standings = {}; data.xgN = 0; data.extraN = 0; data.eloStart = null;
  if (!data.cupTeams) data.cupTeams = new Set();
  if (!snap) return;
  const today = todayDay();
  const xg = new Map(Object.entries(snap.xg || {}));
  for (const r of data.played) {
    const v = xg.get(`${isoDay(r.day)}|${r.h}|${r.a}`);
    if (v) { r.xh = v[0]; r.xa = v[1]; data.xgN++; }
  }
  for (const o of snap.odds || []) if (parseDay(o.d) >= today - 1) data.odds.set(`${o.h}|${o.a}`, o);
  data.standings = {};
  for (const [code, t] of Object.entries(snap.standings || {})) data.standings[code] = Object.assign({}, t, { table: (t.table || []).map(r => Object.assign({}, r)) });
  // Elo ratings where the page's three seasons begin, computed by the collector from 2018 on
  const el = snap.elo;
  if (el && el.ratings && el.start && parseDay(el.start) === seasonStart(data.seasons[2])) {
    const ratings = new Map(Object.entries(el.ratings));
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
  const k = Math.LN2 / CFG.halfLife, xw = CFG.xgWeight || 0, sw = CFG.shotWeight || 0;
  for (let m = 0; m < n; m++) {
    const r = rows[m];
    H[m] = TI.idx.get(r.h); A[m] = TI.idx.get(r.a); CC[m] = ci.get(r.comp);
    GX[m] = r.hg; GY[m] = r.ag;
    // targets: goals, or a blend of goals and xG where Understat has the match, else of goals and
    // shot-based expected goals where ESPN has the shots
    if (xw > 0 && r.xh !== undefined) { X[m] = (1 - xw) * r.hg + xw * r.xh; Y[m] = (1 - xw) * r.ag + xw * r.xa; }
    else if (sw > 0 && r.sxh !== undefined) { X[m] = (1 - sw) * r.hg + sw * r.sxh; Y[m] = (1 - sw) * r.ag + sw * r.sxa; }
    else { X[m] = r.hg; Y[m] = r.ag; }
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
   them. Mirror of elo_run() in collector/collect.py. Sets r.edr = R_home - R_away before the match.
   hist (optional Map): filled with team -> [[day, rating], ...], the rating after each week it played. */
function eloRun(played, start, hist) {
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
    if (hist) {
      const wkDay = new Map();
      for (let i = k; i < j; i++) for (const t of [played[i].h, played[i].a]) wkDay.set(t, Math.max(wkDay.get(t) || 0, played[i].day));
      for (const [t, day] of wkDay) {
        if (!hist.has(t)) hist.set(t, []);
        hist.get(t).push([day, R.get(t)]);
      }
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
    if (r.cup || !ELO_MAP_COMPS.has(r.comp) || asof - r.day > CFG.eloMapDays || r.edr === undefined) continue;
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
  const eloHist = new Map();
  const elo = eloRun(data.played, data.eloStart, eloHist);
  const map = eloMapFit(data.played, asof, null);
  return { data, TI, M, elo, eloHist, map, asof };
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

/* ------------------------------------------------------------------ season simulation
   Monte Carlo of the rest of a league season. Every remaining match is drawn from MatchLab's own
   forecast (the blended 1X2, then a score from its grid), so the projection agrees with the match
   numbers on the page. Over a season teams change (form, injuries, transfers, coaches) and today's
   ratings are only estimates, so in each simulated season every team's strength takes a random
   walk on the log-odds scale of the 1X2: a starting offset (sd base) plus drift (sd drift per
   square root of 100 days). base 0.1 / drift 0.3 scored best on 2024/25 among 20 settings and was
   better than no uncertainty on 2025/26 too, though within noise in both (model-lab/sim_test.mjs,
   model-lab/RESULTS.md).
   Ties on points are split by goal difference, then goals scored, then at random - the leagues'
   own head-to-head rules are not modelled. Not part of CFG: it changes no match forecast. */
const SIM = { n: 10000, base: 0.1, drift: 0.3, seed: 20260921 };
// places shown per league: top = the "top" column, rel = places relegated directly (play-off places not included)
const ZONES = {
  'en.1': { top: 4, rel: 3 }, 'es.1': { top: 4, rel: 3 }, 'de.1': { top: 4, rel: 2 }, 'it.1': { top: 4, rel: 3 },
  'fr.1': { top: 4, rel: 2 }, 'nl.1': { top: 4, rel: 2 }, 'pt.1': { top: 4, rel: 2 }, 'en.2': { top: 2, rel: 3 },
};
// small fast generator (mulberry32): the same seed gives the same projection, so the numbers do
// not jitter between renders; period 2^32, far more than one projection draws
function rng32(seed) {
  let x = seed >>> 0;
  const next = () => {
    x = (x + 0x6D2B79F5) | 0;
    let t = Math.imul(x ^ (x >>> 15), 1 | x);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next };
}
// This season's league table from the results in data.played before asof. adj: team -> points
// adjustment (deductions from the official table), optional.
function leagueTable(data, code, asof, adj) {
  const rows = new Map();
  for (const [t, c] of data.teamLeague) if (c === code) rows.set(t, { team: t, p: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, adj: (adj && adj.get(t)) || 0 });
  for (const r of data.played) {
    if (r.day >= asof) break;
    if (r.cup || r.comp !== code || r.season !== data.cur || !rows.has(r.h) || !rows.has(r.a)) continue;
    for (const [t, gf, ga] of [[r.h, r.hg, r.ag], [r.a, r.ag, r.hg]]) {
      const x = rows.get(t); x.p++; x.gf += gf; x.ga += ga;
      if (gf > ga) x.w++; else if (gf === ga) x.d++; else x.l++;
    }
  }
  for (const x of rows.values()) { x.gd = x.gf - x.ga; x.pts = 3 * x.w + x.d + x.adj; }
  return rows;
}
// The matches still to play: every home-away pair of the league (all eight are double round-robins)
// that has no result yet, dated from the fixture list where it has one.
function remainingMatches(data, code, asof, teams) {
  const playedPairs = new Set(), when = new Map();
  for (const r of data.played) if (!r.cup && r.comp === code && r.season === data.cur && r.day < asof) playedPairs.add(`${r.h}|${r.a}`);
  let lastDay = asof;
  for (const f of data.fixtures) if (f.comp === code && !f.cup) { when.set(`${f.h}|${f.a}`, f.day); if (f.day > lastDay) lastDay = f.day; }
  const out = [];
  for (const h of teams) for (const a of teams) {
    if (h === a || playedPairs.has(`${h}|${a}`)) continue;
    const d = when.get(`${h}|${a}`);
    out.push({ h, a, day: d === undefined ? lastDay : Math.max(d, asof) });
  }
  out.sort((x, y) => x.day - y.day || cmpStr(x.h, y.h));
  return out;
}
const logit = p => Math.log(Math.max(p, 1e-9) / Math.max(1 - p, 1e-9));
// standard normal quantiles at the midpoints of 4096 equal-probability slices (Acklam's inverse
// normal): a draw is one uniform and a table look-up, fast enough for millions per projection
const ZTAB = (() => {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.3577518672690, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const inv = p => {
    if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) return -inv(1 - p);
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  };
  const t = new Float64Array(4096);
  for (let k = 0; k < 4096; k++) t[k] = inv((k + 0.5) / 4096);
  return t;
})();
// logistic quantiles at the midpoints of 65536 slices: a logistic draw without a logarithm
const LTAB = (() => { const t = new Float32Array(65536); for (let k = 0; k < 65536; k++) { const p = (k + 0.5) / 65536; t[k] = Math.log(p / (1 - p)); } return t; })();
// Everything the Monte Carlo needs, as plain arrays (so it can be posted to a worker): the table now,
// and per remaining match the 1X2 cut points, the drift step sizes and the score tables.
// opts: { base, drift, adj (Map team -> points adjustment), maxGoals }
function simSetup(st, code, opts) {
  const o = Object.assign({}, SIM, opts || {});
  const data = st.data, asof = st.asof;
  const table = leagueTable(data, code, asof, o.adj);
  const teams = [...table.keys()].filter(t => st.TI.idx.has(t)).sort(cmpStr);
  const T = teams.length, ti = new Map(teams.map((t, i) => [t, i]));
  const rem = remainingMatches(data, code, asof, teams);
  const K = rem.length, cap = o.maxGoals || 8;
  const MH = new Int32Array(K), MA = new Int32Array(K), LA = new Float64Array(K), LAD = new Float64Array(K);
  const SH = new Float64Array(K), SA = new Float64Array(K), last = new Float64Array(T).fill(asof);
  const dsd = o.drift / 10;                              // per square root of a day (100 days -> drift)
  // score tables of all matches in three flat arrays: entries OFF[3m+k] .. OFF[3m+k+1]-1 hold the
  // scores of outcome k (0 home win, 1 draw, 2 away win) of match m with their cumulative probability
  const cumL = [], giL = [], gjL = [], OFF = new Int32Array(3 * K + 1);
  for (let m = 0; m < K; m++) {
    const r = rem[m], P = forecast(st, r.h, r.a, code, false);
    MH[m] = ti.get(r.h); MA[m] = ti.get(r.a);
    LA[m] = logit(P.pA); LAD[m] = logit(P.pA + P.pD);
    // drift since the team's previous match (each team's dates are fixed): sd of the step
    SH[m] = dsd * Math.sqrt(Math.max(0, r.day - last[MH[m]])); last[MH[m]] = Math.max(last[MH[m]], r.day);
    SA[m] = dsd * Math.sqrt(Math.max(0, r.day - last[MA[m]])); last[MA[m]] = Math.max(last[MA[m]], r.day);
    const cls = [[], [], []], g = Math.min(cap, P.maxg);
    for (let i = 0; i <= g; i++) for (let j = 0; j <= g; j++) cls[i > j ? 0 : i === j ? 1 : 2].push([i, j, P.grid[i][j]]);
    for (let k = 0; k < 3; k++) {
      OFF[3 * m + k] = cumL.length;
      let tot = 0; for (const x of cls[k]) tot += x[2];
      let acc = 0;
      for (const x of cls[k]) { acc += x[2] / (tot || 1); cumL.push(acc); giL.push(x[0]); gjL.push(x[1]); }
      if (cls[k].length) cumL[cumL.length - 1] = 1;
    }
  }
  OFF[3 * K] = cumL.length;
  const CUM = Float64Array.from(cumL), GI = Int8Array.from(giL), GJ = Int8Array.from(gjL);
  const now = teams.map(t => table.get(t));
  return { code, teams, now, T, K, MH, MA, LA, LAD, SH, SA, OFF, CUM, GI, GJ, base: o.base, drift: o.drift, zones: ZONES[code] || { top: 4, rel: 3 } };
}
// The Monte Carlo itself: pure arithmetic on simSetup's arrays. opts: { n, seed }
function simRun(S0, opts) {
  const o = Object.assign({}, SIM, opts || {});
  const { T, K, MH, MA, LA, LAD, SH, SA, OFF, CUM, GI, GJ, now } = S0;
  const R = rng32(o.seed), N = o.n, next = R.next;
  const pos = new Float64Array(T * T), ptsAll = new Int16Array(N * T);
  const pts = new Float64Array(T), gd = new Float64Array(T), gf = new Float64Array(T), u = new Float64Array(T), tie = new Float64Array(T);
  const order = Array.from({ length: T }, (_, i) => i);
  const cmp = (x, y) => pts[y] - pts[x] || gd[y] - gd[x] || gf[y] - gf[x] || tie[y] - tie[x];
  const drift = S0.drift > 0, b0 = S0.base;
  for (let s = 0; s < N; s++) {
    for (let i = 0; i < T; i++) { pts[i] = now[i].pts; gd[i] = now[i].gd; gf[i] = now[i].gf; u[i] = b0 > 0 ? b0 * ZTAB[(next() * 4096) | 0] : 0; tie[i] = next(); }
    for (let m = 0; m < K; m++) {
      const h = MH[m], a = MA[m];
      if (drift) { u[h] += SH[m] * ZTAB[(next() * 4096) | 0]; u[a] += SA[m] * ZTAB[(next() * 4096) | 0]; }
      // outcome by a logistic draw: away if g < logit P(away), draw if g < logit P(away or draw);
      // a team-strength shift moves both cut points (an ordered logit)
      const g = LTAB[(next() * 65536) | 0] + u[h] - u[a];
      const k = g < LA[m] ? 2 : g < LAD[m] ? 1 : 0;
      let lo = OFF[3 * m + k], hi = OFF[3 * m + k + 1] - 1; const w = next();
      while (lo < hi) { const mid = (lo + hi) >> 1; if (CUM[mid] < w) lo = mid + 1; else hi = mid; }
      const gh = GI[lo], ga = GJ[lo];
      if (k === 0) pts[h] += 3; else if (k === 1) { pts[h] += 1; pts[a] += 1; } else pts[a] += 3;
      gd[h] += gh - ga; gd[a] += ga - gh; gf[h] += gh; gf[a] += ga;
    }
    order.sort(cmp);
    for (let p = 0; p < T; p++) pos[order[p] * T + p]++;
    for (let i = 0; i < T; i++) ptsAll[s * T + i] = pts[i];
  }
  const z = S0.zones;
  const out = S0.teams.map((t, i) => {
    const P = Array.from(pos.subarray(i * T, i * T + T), c => c / N);
    const ps = new Int16Array(N); for (let s = 0; s < N; s++) ps[s] = ptsAll[s * T + i];
    ps.sort();
    let mean = 0; for (let s = 0; s < N; s++) mean += ps[s]; mean /= N;
    const q = f => ps[Math.min(N - 1, Math.max(0, Math.round(f * (N - 1))))];
    const sum = (a, b) => P.slice(a, b).reduce((x, y) => x + y, 0);
    return { team: t, now: now[i], pos: P, xPts: mean, lo: q(0.05), hi: q(0.95), xPos: P.reduce((acc, p, k) => acc + p * (k + 1), 0),
      title: P[0], top: sum(0, z.top), rel: sum(T - z.rel, T) };
  });
  out.sort((x, y) => y.xPts - x.xPts || x.xPos - y.xPos || cmpStr(x.team, y.team));
  return { code: S0.code, teams: out, T, n: N, remaining: K, played: now.reduce((acc, x) => acc + x.p, 0) / 2, zones: z, base: S0.base, drift: S0.drift };
}
const simulateLeague = (st, code, opts) => simRun(simSetup(st, code, opts), opts);

/* ------------------------------------------------------------------ forecast archive (live track record)
   Every fixture of the next 7 days gets a forecast; it is updated on each run until the match day
   begins (00:00 UTC), then locked for good, and scored once the result is in. The archive lives in
   data/forecasts.json in the repository, so its git history shows every change. */
function forecastKey(f) {
  // a league pairing happens once in the regular season; play-off and championship rounds (and cups) repeat it
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
  // per competition, and a running total by match day (for the page's chart): n, log-loss sum,
  // and on the matches with market odds: n, MatchLab's log-loss sum, the market's log-loss sum
  const comps = new Map();
  for (const e of done) {
    if (!comps.has(e.comp)) comps.set(e.comp, { comp: e.comp, n: 0, ll: 0, acc: 0, nm: 0, llm: 0, mll: 0 });
    const c = comps.get(e.comp); c.n++; c.ll += e.ll; c.acc += e.p.indexOf(Math.max(...e.p)) === e.o ? 1 : 0;
    if (e.mkt && e.mll !== undefined) { c.nm++; c.llm += e.ll; c.mll += e.mll; }
  }
  const byComp = [...comps.values()].sort((a, b) => b.n - a.n || cmpStr(a.comp, b.comp))
    .map(c => ({ comp: c.comp, n: c.n, ll: r4(c.ll / c.n), acc: r4(c.acc / c.n), nm: c.nm, llm: c.nm ? r4(c.llm / c.nm) : null, mll: c.nm ? r4(c.mll / c.nm) : null }));
  const days = new Map();
  for (const e of done) {
    if (!days.has(e.played)) days.set(e.played, [0, 0, 0, 0, 0]);
    const x = days.get(e.played); x[0]++; x[1] += e.ll;
    if (e.mkt && e.mll !== undefined) { x[2]++; x[3] += e.ll; x[4] += e.mll; }
  }
  const series = [...days.entries()].sort((a, b) => cmpStr(a[0], b[0])).map(([d, x]) => [d, x[0], r4(x[1]), x[2], r4(x[3]), r4(x[4])]);
  return {
    generated: new Date(nowMs).toISOString().slice(0, 19) + 'Z', model: ENGINE_VERSION, cfg: CFG_HASH, since,
    total: all.length, settled: done.length, locked, open, void: all.filter(e => e.void).length,
    ll: mean(done, e => e.ll), brier: mean(done, e => e.br), rps: mean(done, e => e.rps),
    acc: mean(done, e => (e.p.indexOf(Math.max(...e.p)) === e.o ? 1 : 0)),
    llDc: mean(done, e => -Math.log(Math.max(e.dc[e.o], 1e-12))), llElo: mean(done, e => -Math.log(Math.max(e.elo[e.o], 1e-12))),
    market: withM.length ? { n: withM.length, ll: mean(withM, e => e.mll), llModel: mean(withM, e => e.ll) } : null,
    recent, byComp, series,
  };
}

Object.assign(root, {
  ENGINE_VERSION, CFG, CFG_HASH, ESPN, LEAGUES, HISTORY, HISTORY_ONLY, CUP_LIST, CUPS, CUP, UCL, SECOND_TIER, LG, ALL_COMPS,
  DAYMS, parseDay, todayDay, utcDayOf, dayDate, isoDay, mondayOf, seasonKeyOf, seasonStart, prevSeason,
  cleanName, toks, canonicalNames, decodeMatches, espnRecord, loadData, buildData, mergeSnapshot,
  teamIndex, fitModel, goalsCap, poissonVec, homeAdv, dcProbs, dcRates,
  eloRun, eloOf, eloMapFit, eloMapProbs, prepare, forecast, laplace, forecastRange, strengthSe,
  scoreOne, walkForward, eceOf, forecastKey, issueForecasts, settleForecasts, trackSummary,
  SIM, ZONES, rng32, leagueTable, remainingMatches, simSetup, simRun, simulateLeague,
  matchlabEngine,
});
}
matchlabEngine(typeof window !== 'undefined' ? window : globalThis);
