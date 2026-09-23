#!/usr/bin/env python3
"""MatchLab - data collector.

Merges five sources into data/latest.json (+ data/latest.js for pages opened from disk):
  openfootball      results + fixtures, 8 leagues      (the canonical team names)
  football-data.org results, official standings, UEFA Champions League 2025/26 + 2026/27
  Understat         expected goals (xG) per match, top-5 leagues
  OpenLigaDB        Bundesliga results (cross-check)
  The Odds API      bookmaker 1X2 odds for upcoming matches (refreshed at most every N hours)

Every source is independent: when one fails, its section from the previous snapshot is kept
(with its old timestamp) and the run still succeeds. API keys come from environment variables
(FOOTBALL_DATA_ORG_KEY, ODDS_API_KEY - for GitHub Actions) or collector/config.local.json.
Standard library only.

  python collect.py                 output to the console
  pythonw collect.py --log FILE     output (and any traceback) to FILE - used by the scheduled task
"""
import gzip
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from difflib import SequenceMatcher

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, "cache")
OUT = os.path.join(ROOT, "data")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"
OF_BASE = "https://raw.githubusercontent.com/openfootball/football.json/master/"

LEAGUES = {
    "en.1": {"fd": "PL", "us": "EPL", "odds": "soccer_epl"},
    "en.2": {"fd": "ELC", "us": None, "odds": "soccer_efl_champ"},
    "es.1": {"fd": "PD", "us": "La_liga", "odds": "soccer_spain_la_liga"},
    "de.1": {"fd": "BL1", "us": "Bundesliga", "odds": "soccer_germany_bundesliga"},
    "it.1": {"fd": "SA", "us": "Serie_A", "odds": "soccer_italy_serie_a"},
    "fr.1": {"fd": "FL1", "us": "Ligue_1", "odds": "soccer_france_ligue_one"},
    "nl.1": {"fd": "DED", "us": None, "odds": "soccer_netherlands_eredivisie"},
    "pt.1": {"fd": "PPL", "us": None, "odds": "soccer_portugal_primeira_liga"},
}
HISTORY_ONLY = ["es.2", "de.2", "it.2", "fr.2"]
CUP = {"code": "uefa.cl", "fd": "CL", "odds": "soccer_uefa_champs_league"}

if "--log" in sys.argv[1:-1]:
    # pythonw has no console: send the run's output there, overwritten each run
    _log_path = os.path.abspath(sys.argv[sys.argv.index("--log") + 1])
    os.makedirs(os.path.dirname(_log_path), exist_ok=True)
    sys.stdout = sys.stderr = open(_log_path, "w", encoding="utf-8")
    print(time.strftime("%Y-%m-%d %H:%M:%S"), "start", flush=True)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def now_utc():
    return datetime.now(timezone.utc)


def iso(dt):
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


# ------------------------------------------------------------------ config
def load_config():
    cfg = {}
    path = os.path.join(HERE, "config.local.json")
    if os.path.exists(path):
        cfg = json.load(open(path, encoding="utf-8"))
    cfg["football_data_org_key"] = os.environ.get("FOOTBALL_DATA_ORG_KEY") or cfg.get("football_data_org_key", "")
    cfg["odds_api_key"] = os.environ.get("ODDS_API_KEY") or cfg.get("odds_api_key", "")
    cfg.setdefault("odds_refresh_hours", 24)
    cfg.setdefault("odds_regions", "eu")
    cfg.setdefault("odds_min_remaining", 20)
    return cfg


# ------------------------------------------------------------------ http + cache
def http(url, headers=None, timeout=40):
    h = {"User-Agent": UA, "Accept-Encoding": "gzip"}
    h.update(headers or {})
    with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
        raw = r.read()
        if raw[:2] == b"\x1f\x8b":
            raw = gzip.decompress(raw)
        return raw, r.headers


def cache_path(key):
    return os.path.join(CACHE, re.sub(r"[^\w.-]+", "_", key) + ".json")


def cached(key, fetch, max_age_hours=None):
    """Return (data, meta). max_age_hours=None means keep forever once fetched.
    On a fetch error the stale copy is returned (meta['stale']=True) if there is one."""
    p = cache_path(key)
    old = None
    if os.path.exists(p):
        try:
            old = json.load(open(p, encoding="utf-8"))
        except Exception:
            old = None
    if old is not None:
        age_h = (time.time() - old["t"]) / 3600
        if max_age_hours is None or age_h < max_age_hours:
            return old["data"], {"t": old["t"], "cached": True}
    try:
        data = fetch()
    except Exception as e:
        if old is not None:
            return old["data"], {"t": old["t"], "stale": True, "error": str(e)[:160]}
        raise
    os.makedirs(CACHE, exist_ok=True)
    json.dump({"t": time.time(), "data": data}, open(p, "w", encoding="utf-8"))
    return data, {"t": time.time()}


# ------------------------------------------------------------------ seasons
def season_start_year(d=None):
    d = d or date.today()
    return d.year if d.month >= 7 else d.year - 1


def skey(y):
    return f"{y}-{(y + 1) % 100:02d}"


# ------------------------------------------------------------------ names
def fold(s):
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode().lower()


STOP = {"fc", "cf", "afc", "ac", "as", "sc", "sv", "ss", "ssc", "us", "rc", "rcd", "cd", "ud", "sd", "ca", "cs", "fk", "vfb", "vfl",
        "tsg", "bc", "calcio", "club", "de", "del", "la", "le", "the", "and", "e", "ogc", "osc", "sco", "aj", "cfc", "sad", "futebol",
        "clube", "football", "balompie", "hove", "i"}
SYN = {"munich": "munchen", "inter": "internazionale", "man": "manchester", "utd": "united", "wolves": "wolverhampton",
       "spurs": "tottenham", "psg": "paris", "gladbach": "monchengladbach", "bilbao": "athletic", "sporting": "sporting",
       "koln": "koln", "cologne": "koln", "nurnberg": "nurnberg", "rome": "roma", "turin": "torino", "naples": "napoli",
       "milano": "milan", "saint": "st", "brighton": "brighton", "nottm": "nottingham", "sheff": "sheffield", "qpr": "queens",
       "west brom": "west bromwich", "atletico": "atletico", "atl": "atletico", "bayern": "bayern", "leverkusen": "leverkusen"}


def toks(name):
    s = fold(name)
    s = re.sub(r"\(.*?\)", " ", s)
    s = re.sub(r"[^a-z0-9 ]+", " ", s)
    out = set()
    for w in s.split():
        if w in STOP or w.isdigit():
            continue
        out.add(SYN.get(w, w))
    return out


def sim(a, b):
    ta, tb = toks(a), toks(b)
    if not ta or not tb:
        return 0.0
    ov = len(ta & tb) / min(len(ta), len(tb))
    return ov + 0.25 * SequenceMatcher(None, " ".join(sorted(ta)), " ".join(sorted(tb))).ratio()


def clean(name):
    return re.sub(r"\s*\([A-Z]{3}\)\s*$", "", name).strip()


class NameMap:
    """Maps a source's team names onto openfootball names by aligning matches on the same day."""

    def __init__(self):
        self.votes = defaultdict(Counter)

    def learn(self, src_rows, canon_rows, tol_days=1):
        by_day = defaultdict(list)
        for d, h, a in canon_rows:
            by_day[d].append((h, a))
        for d, h, a in src_rows:
            best, bs = None, 0.0
            for k in range(-tol_days, tol_days + 1):
                for ch, ca in by_day.get(d + timedelta(days=k), ()):
                    s = sim(h, ch) + sim(a, ca)
                    if s > bs:
                        best, bs = (ch, ca), s
            if best and bs >= 0.9:
                self.votes[h][best[0]] += 1
                self.votes[a][best[1]] += 1

    def get(self, src, fallback_pool=None, min_sim=0.8):
        if src in self.votes:
            return self.votes[src].most_common(1)[0][0]
        if fallback_pool:
            best = max(fallback_pool, key=lambda c: sim(src, c))
            if sim(src, best) >= min_sim:
                return best
        return None


# ------------------------------------------------------------------ team identity
# openfootball renames clubs between seasons and divisions ("VfL Bochum 1848" in the Bundesliga,
# "VfL Bochum" in 2. Bundesliga; "Deportivo La Coruña" / "RC Deportivo La Coruña"). Mirrored by
# canonicalNames() in engine.js - keep the two identical.
RESERVE = frozenset({"b", "ii", "iii", "u23", "u21", "u19", "jong", "castilla", "reserves", "atletic"})


def canonical_names(records, cup_code="uefa.cl"):
    """records: iterable of (name, season, comp, day). Two names are one club when they come from the
    same country, one's name tokens contain the other's, reserve markers agree ("Real Sociedad B" is
    not "Real Sociedad") and they never appear in the same season. Returns {name: canonical name},
    the canonical name being the one used most recently."""
    info = {}
    for name, season, comp, day in records:
        x = info.setdefault(name, {"seasons": set(), "countries": set(), "last": 0})
        x["seasons"].add(season)
        x["last"] = max(x["last"], day)
        if comp != cup_code:
            x["countries"].add(comp.split(".")[0])
    names = sorted(info)
    tok = {n: frozenset(toks(n)) for n in names}
    for n in names:
        if not info[n]["countries"]:
            info[n]["countries"] = {"cup"}
    pairs = []
    for i, a in enumerate(names):
        for b in names[i + 1:]:
            ta, tb = tok[a], tok[b]
            if not ta or not tb or not (ta <= tb or tb <= ta) or (ta & RESERVE) != (tb & RESERVE):
                continue
            if not (info[a]["countries"] & info[b]["countries"]) or info[a]["seasons"] & info[b]["seasons"]:
                continue
            pairs.append((-len(ta & tb) / max(len(ta), len(tb)), a, b))
    parent = {n: n for n in names}
    group = {n: {"seasons": set(info[n]["seasons"]), "countries": set(info[n]["countries"])} for n in names}

    def find(n):
        while parent[n] != n:
            n = parent[n]
        return n
    for _, a, b in sorted(pairs):
        ra, rb = find(a), find(b)
        if ra == rb or group[ra]["seasons"] & group[rb]["seasons"] or not (group[ra]["countries"] & group[rb]["countries"]):
            continue
        parent[rb] = ra
        group[ra]["seasons"] |= group[rb]["seasons"]
        group[ra]["countries"] |= group[rb]["countries"]
    members = defaultdict(list)
    for n in names:
        members[find(n)].append(n)
    out = {}
    for ms in members.values():
        canon = max(ms, key=lambda n: (info[n]["last"], n))
        for n in ms:
            out[n] = canon
    return out


# ------------------------------------------------------------------ Elo (mirrored by eloRun() in engine.js)
ELO = {"K": 20.0, "hfa": 70.0, "newTop": 1500.0, "newSecond": 1350.0}
SECOND_TIER = {"en.2", "es.2", "de.2", "it.2", "fr.2"}


def elo_run(rows, ratings=None, cfg=ELO):
    """Goal-margin Elo, frozen for a week at a time (Monday to Sunday) like the model's weekly refits:
    every match of a week is rated with the ratings from before that week, then the week's results
    are applied. rows: chronological dicts with d, h, a, hg, ag, comp. Returns (pre-match
    R_home - R_away per row, final ratings)."""
    R = dict(ratings or {})
    dr = [0.0] * len(rows)
    k = 0
    while k < len(rows):
        wk = rows[k]["d"] - timedelta(days=rows[k]["d"].weekday())
        j = k
        while j < len(rows) and rows[j]["d"] - timedelta(days=rows[j]["d"].weekday()) == wk:
            j += 1
        for i in range(k, j):
            r = rows[i]
            for t in (r["h"], r["a"]):
                if t not in R:
                    R[t] = cfg["newSecond"] if r["comp"] in SECOND_TIER else cfg["newTop"]
            dr[i] = R[r["h"]] - R[r["a"]]
        for i in range(k, j):
            r = rows[i]
            e = 1 / (1 + 10 ** (-(dr[i] + cfg["hfa"]) / 400))
            gd = abs(r["hg"] - r["ag"])
            g = 1.0 if gd <= 1 else 1.5 if gd == 2 else (11 + gd) / 8
            s = 1.0 if r["hg"] > r["ag"] else 0.5 if r["hg"] == r["ag"] else 0.0
            R[r["h"]] += cfg["K"] * g * (s - e)
            R[r["a"]] -= cfg["K"] * g * (s - e)
        k = j
    return dr, R


# ------------------------------------------------------------------ openfootball
def score_ft(sc, d, today):
    ft = None
    if isinstance(sc, dict) and isinstance(sc.get("ft"), list):
        ft = sc["ft"]
    elif isinstance(sc, list) and d < today:        # since 2025/26 a 0-0 is written as "score": [0, 0]
        ft = sc
    if not ft or len(ft) != 2:
        return None
    try:
        a, b = int(ft[0]), int(ft[1])
    except (TypeError, ValueError):
        return None
    return (a, b) if a >= 0 and b >= 0 else None


def load_openfootball(y0):
    today = date.today()
    played, fixtures = [], []
    status = {"files": 0, "missing": 0}
    for y in (y0, y0 - 1, y0 - 2):
        s = skey(y)
        for code, kind in [(c, "league") for c in LEAGUES] + [(c, "history") for c in HISTORY_ONLY] + [(CUP["code"], "cup")]:
            key = f"of_{s}_{code}"
            try:
                j, meta = cached(key, lambda: json.loads(http(f"{OF_BASE}{s}/{code}.json")[0]), 0.5 if y == y0 else 24 * 30)
            except urllib.error.HTTPError as e:
                if e.code == 404:
                    status["missing"] += 1
                    continue
                raise
            status["files"] += 1
            for m in j.get("matches", []):
                if not m.get("team1") or not m.get("team2") or not m.get("date"):
                    continue
                d = date.fromisoformat(m["date"])
                rnd = (m.get("round") or "").lower()
                rec = {"d": d, "time": m.get("time", ""), "h": clean(m["team1"]), "a": clean(m["team2"]), "comp": code, "season": s, "cup": kind == "cup",
                       # play-offs repeat a league pairing inside the same season, so they are told apart
                       "reg": not rnd or rnd.startswith("matchday")}
                ft = score_ft(m.get("score"), d, today)
                if ft:
                    rec["hg"], rec["ag"] = ft
                    played.append(rec)
                elif kind == "league" and y == y0:
                    fixtures.append(rec)
    last = max((r["d"] for r in played if r["season"] == skey(y0) and not r["cup"]), default=None)
    status.update(ok=True, played=len(played), fixtures=len(fixtures), lastMatch=last and last.isoformat())
    return played, fixtures, status


def elo_start(y0, fd=None, first=2018):
    """Elo ratings on 1 July of y0-2 - where the three seasons the page loads begin - from every
    season since `first`. The page carries them forward through its own data; with only three
    seasons of history Elo is much weaker (model-lab/RESULTS.md)."""
    start = date(y0 - 2, 7, 1)
    today = date.today()
    rows, names, cup_seasons = [], [], set()
    for y in range(first, y0 + 1):
        s = skey(y)
        for code in list(LEAGUES) + HISTORY_ONLY + [CUP["code"]]:
            age = 0.5 if y == y0 else (24 * 30 if y >= y0 - 2 else None)
            try:
                j, _ = cached(f"of_{s}_{code}", lambda: json.loads(http(f"{OF_BASE}{s}/{code}.json")[0]), age)
            except Exception:
                continue
            if code == CUP["code"]:
                cup_seasons.add(s)
            for m in j.get("matches", []):
                if not m.get("team1") or not m.get("team2") or not m.get("date"):
                    continue
                d = date.fromisoformat(m["date"])
                h, a = clean(m["team1"]), clean(m["team2"])
                names += [(h, s, code, d.toordinal()), (a, s, code, d.toordinal())]
                ft = score_ft(m.get("score"), d, today)
                if ft and d < start:
                    rows.append({"d": d, "h": h, "a": a, "hg": ft[0], "ag": ft[1], "comp": code, "s": s})
    # Champions League seasons before the window that openfootball lacks (football-data.org's free tier reaches 2023/24)
    if fd:
        for y in range(2023, y0 - 2):
            if skey(y) in cup_seasons:
                continue
            try:
                nm = NameMap()
                for code, L in LEAGUES.items():
                    j, _ = cached(f"fd_{L['fd']}_{y}", lambda: fd.get(f"/competitions/{L['fd']}/matches?season={y}"), None)
                    nm.learn([(utc_day(m["utcDate"]), m["homeTeam"]["name"], m["awayTeam"]["name"]) for m in j.get("matches", [])
                              if (m.get("homeTeam") or {}).get("name")],
                             [(r["d"], r["h"], r["a"]) for r in rows if r["comp"] == code and r["s"] == skey(y)])
                pool = {n for n, *_ in names}
                j, _ = cached(f"fd_CL_{y}", lambda: fd.get(f"/competitions/CL/matches?season={y}"), None)
                for m in j.get("matches", []):
                    hn, an = (m.get("homeTeam") or {}).get("name"), (m.get("awayTeam") or {}).get("name")
                    sc = fd_score(m) if hn and an and m.get("status") == "FINISHED" else None
                    if sc:
                        d = utc_day(m["utcDate"])
                        h, a = nm.get(hn, pool, 0.85) or clean(hn), nm.get(an, pool, 0.85) or clean(an)
                        names += [(h, skey(y), CUP["code"], d.toordinal()), (a, skey(y), CUP["code"], d.toordinal())]
                        if d < start:
                            rows.append({"d": d, "h": h, "a": a, "hg": sc[0], "ag": sc[1], "comp": CUP["code"], "s": skey(y)})
            except Exception as e:
                log(f"  Elo: Champions League {y} unavailable ({str(e)[:80]})")
    cmap = canonical_names(names, CUP["code"])
    for r in rows:
        r["h"], r["a"] = cmap[r["h"]], cmap[r["a"]]
    rows.sort(key=lambda r: r["d"])
    _, R = elo_run(rows)
    return {"v": 1, "start": start.isoformat(), "matches": len(rows), "first": skey(first),
            "cfg": ELO, "ratings": {t: round(v, 2) for t, v in sorted(R.items())},
            "alias": {k: v for k, v in sorted(cmap.items()) if k != v}}


# ------------------------------------------------------------------ football-data.org
class FootballDataOrg:
    MIN_GAP = 6.5            # free tier: 10 calls per minute

    def __init__(self, key):
        self.key, self.last = key, 0.0
        self.calls = 0

    def get(self, path):
        wait = self.MIN_GAP - (time.time() - self.last)
        if wait > 0:
            time.sleep(wait)
        self.last = time.time()
        self.calls += 1
        raw, _ = http("https://api.football-data.org/v4" + path, {"X-Auth-Token": self.key})
        return json.loads(raw)


def fd_score(m):
    """Score after 90 minutes (the model is about the regular-time result)."""
    sc = m.get("score") or {}
    rt = sc.get("regularTime") or {}
    if rt.get("home") is not None and rt.get("away") is not None:
        return rt["home"], rt["away"]
    ft = sc.get("fullTime") or {}
    if ft.get("home") is None or ft.get("away") is None:
        return None
    if sc.get("duration", "REGULAR") == "REGULAR":
        return ft["home"], ft["away"]
    et, pen = sc.get("extraTime") or {}, sc.get("penalties") or {}
    h = ft["home"] - (et.get("home") or 0) - (pen.get("home") or 0)
    a = ft["away"] - (et.get("away") or 0) - (pen.get("away") or 0)
    return (h, a) if h >= 0 and a >= 0 else None


def utc_day(s):
    return datetime.fromisoformat(s.replace("Z", "+00:00")).date()


# ------------------------------------------------------------------ main
def main():
    t_start = time.time()
    cfg = load_config()
    y0 = season_start_year()
    os.makedirs(OUT, exist_ok=True)
    prev = {}
    prev_path = os.path.join(OUT, "latest.json")
    if os.path.exists(prev_path):
        try:
            prev = json.load(open(prev_path, encoding="utf-8"))
        except Exception:
            prev = {}
    sources = {}
    snap = {"schema": 1, "season": skey(y0)}

    # 1. openfootball: canonical names + the base results -----------------------
    log("openfootball ...")
    of_played, of_fix, sources["openfootball"] = load_openfootball(y0)
    canon_by_comp = defaultdict(set)
    for r in of_played + of_fix:
        canon_by_comp[r["comp"]].update((r["h"], r["a"]))
    all_canon = set().union(*canon_by_comp.values())
    of_rows = defaultdict(list)            # comp -> [(d, h, a)] played
    of_fix_rows = defaultdict(list)        # comp -> [(d, h, a)] upcoming
    # A regular-season pairing happens once per season, so (season, league, home, away, regular) identifies a
    # match even when it was rescheduled - matching on dates would count a postponed match twice. Play-offs
    # (Championship semi-finals, relegation play-offs) can repeat a pairing, hence the 'regular' flag.
    of_pairs = {}
    for r in of_played:
        of_rows[r["comp"]].append((r["d"], r["h"], r["a"]))
        if not r["cup"]:
            of_pairs[(r["season"], r["comp"], r["h"], r["a"], r["reg"])] = r
    for r in of_fix:
        of_fix_rows[r["comp"]].append((r["d"], r["h"], r["a"]))
    log(f"  {len(of_played)} played, {len(of_fix)} fixtures, last {sources['openfootball']['lastMatch']}")

    def find_of(season, code, h, a, reg=True):
        return of_pairs.get((season, code, h, a, reg))

    extra, cup_fixtures, conflicts = [], [], []
    xg = {}
    standings = {}
    fd_names = NameMap()

    # 2. football-data.org ----------------------------------------------------------
    fd = None
    if cfg["football_data_org_key"]:
        log("football-data.org ...")
        fd = FootballDataOrg(cfg["football_data_org_key"])
        st = {"ok": True, "errors": []}
        fd_league = {}
        try:
            for code, L in LEAGUES.items():
                for y, age in ((y0, 0.5), (y0 - 1, None)):
                    try:
                        j, meta = cached(f"fd_{L['fd']}_{y}", lambda: fd.get(f"/competitions/{L['fd']}/matches?season={y}"), age)
                        fd_league[(code, y)] = j.get("matches", [])
                    except Exception as e:
                        st["errors"].append(f"{L['fd']} {y}: {str(e)[:80]}")
            # learn fd -> openfootball names from league matches
            for (code, y), ms in fd_league.items():
                rows = [(utc_day(m["utcDate"]), m["homeTeam"]["name"], m["awayTeam"]["name"]) for m in ms if m.get("homeTeam", {}).get("name")]
                fd_names.learn(rows, of_rows[code] + of_fix_rows[code])
            last_fd = None
            for (code, y), ms in fd_league.items():
                for m in ms:
                    if m.get("status") != "FINISHED":
                        continue
                    sc = fd_score(m)
                    h = fd_names.get(m["homeTeam"]["name"], canon_by_comp[code])
                    a = fd_names.get(m["awayTeam"]["name"], canon_by_comp[code])
                    if not sc or not h or not a:
                        continue
                    d = utc_day(m["utcDate"])
                    if y == y0:
                        last_fd = max(last_fd or d, d)
                    r = find_of(skey(y), code, h, a, m.get("stage", "REGULAR_SEASON") == "REGULAR_SEASON")
                    if r:
                        if (r["hg"], r["ag"]) != tuple(sc):
                            conflicts.append({"d": r["d"].isoformat(), "h": h, "a": a, "comp": code,
                                              "scores": {"openfootball": f"{r['hg']}-{r['ag']}", "football-data.org": f"{sc[0]}-{sc[1]}"}})
                    else:
                        # a result openfootball does not have (yet): take it, on openfootball's date if the fixture exists
                        fx = next((f for f in of_fix if f["comp"] == code and f["h"] == h and f["a"] == a and abs((f["d"] - d).days) <= 1), None)
                        extra.append({"d": (fx["d"] if fx else d).isoformat(), "h": h, "a": a, "hg": sc[0], "ag": sc[1],
                                      "comp": code, "season": skey(y), "cup": False, "src": "football-data.org"})
            # Champions League: previous and current season (openfootball has neither)
            for y, age in ((y0, 0.5), (y0 - 1, None)):
                try:
                    j, meta = cached(f"fd_CL_{y}", lambda: fd.get(f"/competitions/CL/matches?season={y}"), age)
                except Exception as e:
                    st["errors"].append(f"CL {y}: {str(e)[:80]}")
                    continue
                pool = all_canon
                for m in j.get("matches", []):
                    hn, an = (m.get("homeTeam") or {}).get("name"), (m.get("awayTeam") or {}).get("name")
                    if not hn or not an:
                        continue
                    h = fd_names.get(hn, pool, 0.85) or clean(hn)
                    a = fd_names.get(an, pool, 0.85) or clean(an)
                    d = utc_day(m["utcDate"])
                    if m.get("status") == "FINISHED":
                        sc = fd_score(m)
                        if sc:
                            extra.append({"d": d.isoformat(), "h": h, "a": a, "hg": sc[0], "ag": sc[1], "comp": CUP["code"],
                                          "season": skey(y), "cup": True, "src": "football-data.org",
                                          "stage": m.get("stage", "")})
                    elif y == y0 and m.get("status") in ("SCHEDULED", "TIMED"):
                        cup_fixtures.append({"d": d.isoformat(), "time": m["utcDate"][11:16], "utc": True, "h": h, "a": a, "comp": CUP["code"],
                                             "season": skey(y), "stage": m.get("stage", "")})
            # official standings (point deductions included)
            for code, L in LEAGUES.items():
                try:
                    j, meta = cached(f"fd_st_{L['fd']}", lambda: fd.get(f"/competitions/{L['fd']}/standings"), 0.5)
                except Exception as e:
                    st["errors"].append(f"standings {L['fd']}: {str(e)[:80]}")
                    continue
                tot = next((s for s in j.get("standings", []) if s.get("type") == "TOTAL"), None)
                if not tot:
                    continue
                rows = []
                for t in tot["table"]:
                    nm = fd_names.get(t["team"]["name"], canon_by_comp[code], 0.75) or clean(t["team"]["name"])
                    rows.append({"pos": t["position"], "team": nm, "p": t["playedGames"], "w": t["won"], "d": t["draw"], "l": t["lost"],
                                 "gf": t["goalsFor"], "ga": t["goalsAgainst"], "gd": t["goalDifference"], "pts": t["points"],
                                 "form": t.get("form")})
                standings[code] = {"updated": iso(datetime.fromtimestamp(meta["t"], timezone.utc)), "table": rows}
            st.update(calls=fd.calls, lastMatch=last_fd and last_fd.isoformat(), extra=len(extra), cupFixtures=len(cup_fixtures))
        except Exception as e:
            st.update(ok=False, error=str(e)[:200])
        sources["football-data.org"] = st
        log(f"  {fd.calls} calls, {len(extra)} extra results, {len(cup_fixtures)} UCL fixtures, errors {len(st['errors'])}")
    else:
        sources["football-data.org"] = {"ok": False, "error": "no API key"}

    # 3. Understat xG ------------------------------------------------------------------
    log("Understat ...")
    st = {"ok": True, "errors": [], "matches": 0}
    us_names = NameMap()
    us_all = []
    for code, L in LEAGUES.items():
        if not L["us"]:
            continue
        for y in (y0, y0 - 1, y0 - 2):
            def fetch(lg=L["us"], yy=y):
                raw, _ = http(f"https://understat.com/getLeagueData/{lg}/{yy}",
                              {"X-Requested-With": "XMLHttpRequest", "Referer": f"https://understat.com/league/{lg}/{yy}"})
                time.sleep(1.5)                   # be polite
                return json.loads(raw)
            try:
                j, meta = cached(f"us_{L['us']}_{y}", fetch, 1 if y == y0 else None)
            except Exception as e:
                st["errors"].append(f"{L['us']} {y}: {str(e)[:80]}")
                continue
            for m in j.get("dates", []):
                if not m.get("isResult"):
                    continue
                us_all.append((code, skey(y), datetime.fromisoformat(m["datetime"]).date(), m["h"]["title"], m["a"]["title"],
                               int(m["goals"]["h"]), int(m["goals"]["a"]), float(m["xG"]["h"]), float(m["xG"]["a"])))
    for code in LEAGUES:
        us_names.learn([(d, h, a) for c, s, d, h, a, *_ in us_all if c == code], of_rows[code])
    last_us = None
    for code, season, d, hn, an, hg, ag, xh, xa in us_all:
        h, a = us_names.get(hn, canon_by_comp[code]), us_names.get(an, canon_by_comp[code])
        if not h or not a:
            continue
        r = find_of(season, code, h, a)
        dd = r["d"] if r else d
        xg[f"{dd.isoformat()}|{h}|{a}"] = [round(xh, 3), round(xa, 3)]
        last_us = max(last_us or d, d)
        if r and (r["hg"], r["ag"]) != (hg, ag):
            conflicts.append({"d": dd.isoformat(), "h": h, "a": a, "comp": code,
                              "scores": {"openfootball": f"{r['hg']}-{r['ag']}", "Understat": f"{hg}-{ag}"}})
    st.update(matches=len(xg), lastMatch=last_us and last_us.isoformat(), unmapped=len(us_all) - len(xg))
    sources["Understat"] = st
    log(f"  xG for {len(xg)} matches, last {st['lastMatch']}")

    # 4. OpenLigaDB (Bundesliga cross-check) -------------------------------------------
    log("OpenLigaDB ...")
    st = {"ok": True}
    try:
        j, meta = cached(f"oldb_bl1_{y0}", lambda: json.loads(http(f"https://api.openligadb.de/getmatchdata/bl1/{y0}")[0]), 0.5)
        ol_names = NameMap()
        rows = []
        for m in j:
            if not m.get("matchIsFinished"):
                continue
            res = next((x for x in m.get("matchResults", []) if x.get("resultTypeID") == 2), None)
            if res:
                rows.append((datetime.fromisoformat(m["matchDateTimeUTC"].replace("Z", "+00:00")).date(),
                             m["team1"]["teamName"], m["team2"]["teamName"], res["pointsTeam1"], res["pointsTeam2"]))
        ol_names.learn([(d, h, a) for d, h, a, *_ in rows], of_rows["de.1"])
        last_ol = None
        for d, hn, an, hg, ag in rows:
            h, a = ol_names.get(hn, canon_by_comp["de.1"]), ol_names.get(an, canon_by_comp["de.1"])
            last_ol = max(last_ol or d, d)
            r = find_of(skey(y0), "de.1", h, a) if h and a else None
            if r and (r["hg"], r["ag"]) != (hg, ag):
                conflicts.append({"d": r["d"].isoformat(), "h": h, "a": a, "comp": "de.1",
                                  "scores": {"openfootball": f"{r['hg']}-{r['ag']}", "OpenLigaDB": f"{hg}-{ag}"}})
        st.update(matches=len(rows), lastMatch=last_ol and last_ol.isoformat())
    except Exception as e:
        st.update(ok=False, error=str(e)[:200])
    sources["OpenLigaDB"] = st

    # 5. The Odds API -------------------------------------------------------------------
    log("The Odds API ...")
    odds = []
    st = {"ok": True}
    if cfg["odds_api_key"]:
        meta_p = cache_path("odds_meta")
        ometa = json.load(open(meta_p, encoding="utf-8"))["data"] if os.path.exists(meta_p) else {}
        prev_odds = (prev.get("sources") or {}).get("The Odds API") or {}
        if not ometa and prev_odds.get("fetchedAt"):
            # no cache (a fresh GitHub Actions runner that lost its cache): the last snapshot says when the
            # odds were refreshed - without this every run would spend 9 credits
            t = datetime.strptime(prev_odds["fetchedAt"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
            ometa = {"t": t, "remaining": prev_odds.get("remaining")}
        remaining = ometa.get("remaining")
        # ODDS_FORCE=1: refresh now whatever the age (the "Refresh the bookmaker odds now" box of a manual run)
        force = os.environ.get("ODDS_FORCE") == "1"
        fresh_enough = not force and ometa.get("t") and (time.time() - ometa["t"]) / 3600 < cfg["odds_refresh_hours"]
        if force:
            log("  refresh forced (ODDS_FORCE=1)")
        raw_events = {}
        if not fresh_enough and (remaining is None or int(remaining) > cfg["odds_min_remaining"]):
            try:
                for code, L in list(LEAGUES.items()) + [(CUP["code"], CUP)]:
                    url = (f"https://api.the-odds-api.com/v4/sports/{L['odds']}/odds?regions={cfg['odds_regions']}"
                           f"&markets=h2h&oddsFormat=decimal&apiKey={cfg['odds_api_key']}")
                    raw, hdr = http(url)
                    raw_events[code] = json.loads(raw)
                    remaining = hdr.get("x-requests-remaining", remaining)
                ometa = {"t": time.time(), "remaining": remaining}
                os.makedirs(CACHE, exist_ok=True)
                json.dump({"t": time.time(), "data": raw_events}, open(cache_path("odds_events"), "w", encoding="utf-8"))
                json.dump({"t": time.time(), "data": ometa}, open(meta_p, "w", encoding="utf-8"))
            except Exception as e:
                st.update(error=str(e)[:200].replace(cfg["odds_api_key"], "***"))
        if not raw_events and os.path.exists(cache_path("odds_events")):
            raw_events = json.load(open(cache_path("odds_events"), encoding="utf-8"))["data"]
        # align bookmaker names with openfootball fixtures (UCL: with the football-data.org fixtures)
        ucl_rows = [(date.fromisoformat(f["d"]), f["h"], f["a"]) for f in cup_fixtures]
        for code, events in raw_events.items():
            nm = NameMap()
            canon = ucl_rows if code == CUP["code"] else of_fix_rows[code]
            ev_rows = [(utc_day(e["commence_time"]), e["home_team"], e["away_team"]) for e in events]
            nm.learn(ev_rows, canon)
            pool = all_canon if code == CUP["code"] else canon_by_comp[code]
            for e in events:
                h, a = nm.get(e["home_team"], pool), nm.get(e["away_team"], pool)
                if not h or not a:
                    continue
                probs, prices = [], []
                for b in e.get("bookmakers", []):
                    mk = next((m for m in b.get("markets", []) if m["key"] == "h2h"), None)
                    if not mk:
                        continue
                    o = {x["name"]: x["price"] for x in mk["outcomes"]}
                    trip = [o.get(e["home_team"]), o.get("Draw"), o.get(e["away_team"])]
                    if not all(trip):
                        continue
                    inv = [1 / p for p in trip]
                    s = sum(inv)
                    probs.append([v / s for v in inv])           # margin removed per bookmaker
                    prices.append(trip)
                if not probs:
                    continue
                n = len(probs)
                fx_day = utc_day(e["commence_time"])
                ofx = next((f for f in of_fix if f["comp"] == code and f["h"] == h and f["a"] == a and abs((f["d"] - fx_day).days) <= 1), None)
                odds.append({"d": (ofx["d"] if ofx else fx_day).isoformat(), "h": h, "a": a, "comp": code, "n": n,
                             "p": [round(sum(p[k] for p in probs) / n, 4) for k in range(3)],
                             "best": [max(p[k] for p in prices) for k in range(3)],
                             "avg": [round(sum(p[k] for p in prices) / n, 3) for k in range(3)],
                             "commence": e["commence_time"]})
        if not odds and fresh_enough and prev.get("odds"):
            # not due for a refresh and no raw copy here (a fresh runner): the snapshot's odds are the
            # current ones, not a fallback after a failure - reuse them without the carried-over flag
            odds = prev["odds"]
        st.update(events=len(odds), fetchedAt=ometa.get("t") and iso(datetime.fromtimestamp(ometa["t"], timezone.utc)),
                  remaining=remaining, refreshHours=cfg["odds_refresh_hours"])
    else:
        st.update(ok=False, error="no API key")
    sources["The Odds API"] = st
    log(f"  {len(odds)} matches with odds, credits left {st.get('remaining')}")

    # 6. Elo ratings where the page's three seasons begin --------------------------------
    log("Elo start ratings ...")
    elo = None
    try:
        elo = elo_start(y0, fd)
        log(f"  {len(elo['ratings'])} teams rated from {elo['matches']} matches before {elo['start']}, "
            f"{len(elo['alias'])} club names unified")
    except Exception as e:
        log(f"  Elo failed: {str(e)[:160]}")
        if (prev.get("elo") or {}).get("start") == date(y0 - 2, 7, 1).isoformat():
            elo = prev["elo"]

    # ---- assemble, keeping the previous section of any source that failed this time
    snap.update(generated=iso(now_utc()), sources=sources, extra=extra, cupFixtures=cup_fixtures, xg=xg,
                standings=standings, odds=odds, conflicts=conflicts, elo=elo)
    for sect, src in (("standings", "football-data.org"), ("extra", "football-data.org"), ("cupFixtures", "football-data.org"),
                      ("xg", "Understat"), ("odds", "The Odds API")):
        if not snap[sect] and prev.get(sect):
            snap[sect] = prev[sect]
            sources[src]["carriedOver"] = prev.get("generated")
    snap["tookSeconds"] = round(time.time() - t_start, 1)

    js = json.dumps(snap, ensure_ascii=False, separators=(",", ":"), default=str)
    tmp = os.path.join(OUT, "latest.json.tmp")
    open(tmp, "w", encoding="utf-8").write(js)
    os.replace(tmp, os.path.join(OUT, "latest.json"))
    # atomic like latest.json, so a page opened mid-run never reads half a file
    tmp = os.path.join(OUT, "latest.js.tmp")
    open(tmp, "w", encoding="utf-8").write("window.MATCHLAB_SNAPSHOT=" + js + ";\n")
    os.replace(tmp, os.path.join(OUT, "latest.js"))
    log(f"done in {snap['tookSeconds']} s -> data/latest.json ({len(js) / 1024:.0f} KB), "
        f"{len(extra)} extra results, {len(xg)} xG, {len(odds)} odds, {len(conflicts)} score conflicts")
    for c in conflicts[:10]:
        log("  conflict:", c)
    for e in [e for e in extra if not e["cup"]][:10]:
        log("  league result not (yet) in openfootball:", e)


if __name__ == "__main__":
    main()
