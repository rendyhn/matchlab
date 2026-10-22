#!/usr/bin/env python3
"""MatchLab - data collector.

Merges five sources into data/latest.json (+ data/latest.js for pages opened from disk):
  ESPN              results + fixtures + shots, 14 leagues, 4 second tiers, 3 UEFA cups (the team names)
  football-data.org official standings (point deductions), results cross-check, 8 leagues
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
# odds for the three UEFA cups as well (11 credits a refresh; the six leagues v7 adds have none,
# which keeps a daily refresh inside the free 500 credits a month)
CUP_ODDS = {"uefa.cl": "soccer_uefa_champs_league", "uefa.el": "soccer_uefa_europa_league",
            "uefa.ecl": "soccer_uefa_europa_conference_league"}

if __name__ == "__main__" and "--log" in sys.argv[1:-1]:
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


# ------------------------------------------------------------------ openfootball (v6's source; model-lab's LAB_SOURCE=of only)
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


# ------------------------------------------------------------------ ESPN
def espn_labels(matches):
    """ESPN team id -> one display name: the latest it carried; a name two ids share gets the id appended."""
    import espn as E
    names = E.team_names(matches)
    by_name = defaultdict(list)
    for i, n in names.items():
        by_name[n].append(i)
    return {i: (n if len(by_name[n]) == 1 else f"{n} #{i}") for i, n in names.items()}


def elo_start(y0, matches, label, first=2018):
    """Elo ratings on 1 July of y0-2 - where the three seasons the page loads begin - from every ESPN
    result since `first` (all competitions). The page carries them forward through its own data; with
    only three seasons of history Elo is much weaker (model-lab/RESULTS.md)."""
    start = date(y0 - 2, 7, 1)
    rows = [{"d": date.fromisoformat(m["d"]), "h": label[m["hi"]], "a": label[m["ai"]], "hg": m["hg"], "ag": m["ag"], "comp": m["comp"]}
            for m in matches if "hg" in m and not m.get("et") and int(m["season"][:4]) >= first and m["d"] < start.isoformat()]
    rows.sort(key=lambda r: r["d"])
    _, R = elo_run(rows)
    return {"v": 2, "start": start.isoformat(), "matches": len(rows), "first": skey(first), "source": "ESPN",
            "cfg": ELO, "ratings": {t: round(v, 2) for t, v in sorted(R.items())}}


def matches_section(matches, label, y0):
    """The page's results and fixtures, compact: see decodeMatches() in engine.js for the row layout."""
    import espn as E
    comps = list(E.COMPS)
    keep = [m for m in matches if int(m["season"][:4]) >= y0 - 2]
    ids = sorted({m["hi"] for m in keep} | {m["ai"] for m in keep}, key=lambda i: label[i])
    ti = {i: k for k, i in enumerate(ids)}
    a, b = E.SHOT_COEF
    rows = []
    for m in keep:
        d = date.fromisoformat(m["d"])
        sx = [None, None]
        if "hsot" in m and "hs" in m:
            sx = [round(a * m["hsot"] + b * (m["hs"] - m["hsot"]), 2), round(a * m["asot"] + b * (m["as"] - m["asot"]), 2)]
        stage = m.get("stage", "")
        rows.append([int(m["id"]), (d - date(1970, 1, 1)).days, m["t"], comps.index(m["comp"]), int(m["season"][:4]),
                     ti[m["hi"]], ti[m["ai"]], m.get("hg"), m.get("ag"), sx[0], sx[1],
                     (1 if m.get("et") else 0) | (2 if m.get("neutral") else 0), "" if stage in ("regular-season", "") else stage])
    return {"v": 1, "comps": comps, "shot": list(E.SHOT_COEF), "teams": [[int(i), label[i]] for i in ids], "rows": rows}


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
    import espn as E
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
    snap = {"schema": 2, "season": skey(y0)}

    # 1. ESPN: every result and fixture since 2018 (the page gets the last three seasons) -------------
    log("ESPN ...")
    ms, errs = E.load(first=2018, max_age_hours=1.5)
    label = espn_labels(ms)
    win = [m for m in ms if int(m["season"][:4]) >= y0 - 2]
    played = [m for m in win if "hg" in m]
    cur_played = [m for m in played if m["season"] == skey(y0)]
    sources["ESPN"] = {"ok": bool(cur_played), "matches": len(played), "fixtures": sum("hg" not in m for m in win),
                       "competitions": len(E.COMPS), "errors": errs[:5], "failedMonths": len(errs),
                       "lastMatch": max((m["d"] for m in cur_played), default=None)}
    log(f"  {len(played)} results and {sources['ESPN']['fixtures']} fixtures in the page's seasons, "
        f"{len(errs)} months unavailable, last {sources['ESPN']['lastMatch']}")
    matches = matches_section(ms, label, y0) if cur_played else (prev.get("matches") or None)
    if not cur_played and prev.get("matches"):
        sources["ESPN"]["carriedOver"] = prev.get("generated")
    # rows per competition with ESPN's names, for the other sources' name matching
    rows_by = defaultdict(list)            # comp -> [(d, h, a)] results and fixtures of the page's seasons
    pair = {}                              # (comp, h, a, d) -> ESPN match
    for m in win:
        d = date.fromisoformat(m["d"])
        h, a = label[m["hi"]], label[m["ai"]]
        rows_by[m["comp"]].append((d, h, a))
        pair[(m["comp"], h, a, d)] = m
    teams_by = {c: {t for _, h, a in r for t in (h, a)} for c, r in rows_by.items()}
    all_teams = set().union(*teams_by.values()) if teams_by else set()

    def find(code, h, a, d, tol=3):
        for k in sorted(range(-tol, tol + 1), key=abs):
            m = pair.get((code, h, a, d + timedelta(days=k)))
            if m:
                return m, d + timedelta(days=k)
        return None, None

    xg, standings, conflicts = {}, {}, []

    # 2. football-data.org: official tables (point deductions) and a results cross-check ------------
    if cfg["football_data_org_key"]:
        log("football-data.org ...")
        fd = FootballDataOrg(cfg["football_data_org_key"])
        st = {"ok": True, "errors": []}
        try:
            fd_names = NameMap()
            fd_league = {}
            for code, L in LEAGUES.items():
                try:
                    j, _ = cached(f"fd_{L['fd']}_{y0}", lambda: fd.get(f"/competitions/{L['fd']}/matches?season={y0}"), 0.5)
                    fd_league[code] = j.get("matches", [])
                except Exception as e:
                    st["errors"].append(f"{L['fd']} {y0}: {str(e)[:80]}")
            for code, mlist in fd_league.items():
                fd_names.learn([(utc_day(m["utcDate"]), m["homeTeam"]["name"], m["awayTeam"]["name"]) for m in mlist
                                if (m.get("homeTeam") or {}).get("name")], rows_by[code])
            last_fd, checked = None, 0
            for code, mlist in fd_league.items():
                for m in mlist:
                    if m.get("status") != "FINISHED":
                        continue
                    sc = fd_score(m)
                    h, a = fd_names.get(m["homeTeam"]["name"], teams_by.get(code)), fd_names.get(m["awayTeam"]["name"], teams_by.get(code))
                    d = utc_day(m["utcDate"])
                    last_fd = max(last_fd or d, d)
                    em, ed = find(code, h, a, d) if sc and h and a else (None, None)
                    if em and "hg" in em:
                        checked += 1
                        if (em["hg"], em["ag"]) != tuple(sc):
                            conflicts.append({"d": ed.isoformat(), "h": h, "a": a, "comp": code,
                                              "scores": {"ESPN": f"{em['hg']}-{em['ag']}", "football-data.org": f"{sc[0]}-{sc[1]}"}})
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
                    nm = fd_names.get(t["team"]["name"], teams_by.get(code), 0.75) or clean(t["team"]["name"])
                    rows.append({"pos": t["position"], "team": nm, "p": t["playedGames"], "w": t["won"], "d": t["draw"], "l": t["lost"],
                                 "gf": t["goalsFor"], "ga": t["goalsAgainst"], "gd": t["goalDifference"], "pts": t["points"],
                                 "form": t.get("form")})
                standings[code] = {"updated": iso(datetime.fromtimestamp(meta["t"], timezone.utc)), "table": rows}
            st.update(calls=fd.calls, lastMatch=last_fd and last_fd.isoformat(), checked=checked, tables=len(standings))
        except Exception as e:
            st.update(ok=False, error=str(e)[:200])
        sources["football-data.org"] = st
        log(f"  {fd.calls} calls, {len(standings)} tables, {st.get('checked', 0)} results checked against ESPN, errors {len(st['errors'])}")
    else:
        sources["football-data.org"] = {"ok": False, "error": "no API key"}

    # 3. Understat xG ------------------------------------------------------------------------------
    log("Understat ...")
    st = {"ok": True, "errors": [], "matches": 0}
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
                if m.get("isResult"):
                    us_all.append((code, datetime.fromisoformat(m["datetime"]).date(), m["h"]["title"], m["a"]["title"],
                                   int(m["goals"]["h"]), int(m["goals"]["a"]), float(m["xG"]["h"]), float(m["xG"]["a"])))
    last_us, unmapped = None, 0
    for code in LEAGUES:
        nm = NameMap()
        nm.learn([(d, h, a) for c, d, h, a, *_ in us_all if c == code], rows_by[code])
        for c, d, hn, an, hg, ag, xh, xa in us_all:
            if c != code:
                continue
            h, a = nm.get(hn, teams_by.get(code)), nm.get(an, teams_by.get(code))
            em, ed = find(code, h, a, d) if h and a else (None, None)
            if not em:
                unmapped += 1
                continue
            xg[f"{ed.isoformat()}|{h}|{a}"] = [round(xh, 3), round(xa, 3)]
            last_us = max(last_us or d, d)
            if "hg" in em and (em["hg"], em["ag"]) != (hg, ag):
                conflicts.append({"d": ed.isoformat(), "h": h, "a": a, "comp": code,
                                  "scores": {"ESPN": f"{em['hg']}-{em['ag']}", "Understat": f"{hg}-{ag}"}})
    st.update(matches=len(xg), lastMatch=last_us and last_us.isoformat(), unmapped=unmapped)
    sources["Understat"] = st
    log(f"  xG for {len(xg)} matches, last {st['lastMatch']}, {unmapped} not matched")

    # 4. OpenLigaDB (Bundesliga cross-check) -------------------------------------------------------
    log("OpenLigaDB ...")
    st = {"ok": True}
    try:
        j, meta = cached(f"oldb_bl1_{y0}", lambda: json.loads(http(f"https://api.openligadb.de/getmatchdata/bl1/{y0}")[0]), 0.5)
        rows = []
        for m in j:
            res = next((x for x in m.get("matchResults", []) if x.get("resultTypeID") == 2), None) if m.get("matchIsFinished") else None
            if res:
                rows.append((datetime.fromisoformat(m["matchDateTimeUTC"].replace("Z", "+00:00")).date(),
                             m["team1"]["teamName"], m["team2"]["teamName"], res["pointsTeam1"], res["pointsTeam2"]))
        ol = NameMap()
        ol.learn([(d, h, a) for d, h, a, *_ in rows], rows_by["de.1"])
        last_ol = None
        for d, hn, an, hg, ag in rows:
            h, a = ol.get(hn, teams_by.get("de.1")), ol.get(an, teams_by.get("de.1"))
            last_ol = max(last_ol or d, d)
            em, ed = find("de.1", h, a, d) if h and a else (None, None)
            if em and "hg" in em and (em["hg"], em["ag"]) != (hg, ag):
                conflicts.append({"d": ed.isoformat(), "h": h, "a": a, "comp": "de.1",
                                  "scores": {"ESPN": f"{em['hg']}-{em['ag']}", "OpenLigaDB": f"{hg}-{ag}"}})
        st.update(matches=len(rows), lastMatch=last_ol and last_ol.isoformat())
    except Exception as e:
        st.update(ok=False, error=str(e)[:200])
    sources["OpenLigaDB"] = st

    # 5. The Odds API ------------------------------------------------------------------------------
    log("The Odds API ...")
    odds = []
    st = {"ok": True}
    odds_keys = [(code, L["odds"]) for code, L in LEAGUES.items()] + list(CUP_ODDS.items())
    if cfg["odds_api_key"]:
        meta_p = cache_path("odds_meta")
        ometa = json.load(open(meta_p, encoding="utf-8"))["data"] if os.path.exists(meta_p) else {}
        prev_odds = (prev.get("sources") or {}).get("The Odds API") or {}
        if not ometa and prev_odds.get("fetchedAt"):
            # no cache (a fresh GitHub Actions runner that lost its cache): the last snapshot says when the
            # odds were refreshed - without this every run would spend the credits again
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
                for code, key in odds_keys:
                    url = (f"https://api.the-odds-api.com/v4/sports/{key}/odds?regions={cfg['odds_regions']}"
                           f"&markets=h2h&oddsFormat=decimal&apiKey={cfg['odds_api_key']}")
                    try:
                        raw, hdr = http(url)
                    except urllib.error.HTTPError as e:
                        if e.code == 404:            # a competition out of season
                            continue
                        raise
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
        today = date.today()
        for code, events in raw_events.items():
            fx = [(d, h, a) for d, h, a in rows_by.get(code, []) if d >= today - timedelta(days=1)]
            nm = NameMap()
            nm.learn([(utc_day(e["commence_time"]), e["home_team"], e["away_team"]) for e in events], fx)
            pool = teams_by.get(code) or all_teams
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
                em, ed = find(code, h, a, utc_day(e["commence_time"]), 1)
                odds.append({"d": (ed or utc_day(e["commence_time"])).isoformat(), "h": h, "a": a, "comp": code, "n": n,
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

    # 6. Elo ratings where the page's three seasons begin ------------------------------------------
    log("Elo start ratings ...")
    elo = None
    try:
        elo = elo_start(y0, ms, label)
        log(f"  {len(elo['ratings'])} teams rated from {elo['matches']} matches before {elo['start']}")
    except Exception as e:
        log(f"  Elo failed: {str(e)[:160]}")
        if (prev.get("elo") or {}).get("start") == date(y0 - 2, 7, 1).isoformat() and (prev.get("elo") or {}).get("source") == "ESPN":
            elo = prev["elo"]

    # ---- assemble, keeping the previous section of any source that failed this time
    snap.update(generated=iso(now_utc()), sources=sources, matches=matches, extra=[], cupFixtures=[], xg=xg,
                standings=standings, odds=odds, conflicts=conflicts, elo=elo)
    for sect, src in (("standings", "football-data.org"), ("xg", "Understat"), ("odds", "The Odds API")):
        if not snap[sect] and prev.get(sect) and prev.get("schema") == 2:
            snap[sect] = prev[sect]
            sources[src]["carriedOver"] = prev.get("generated")
    if matches:
        matches["generated"] = snap["generated"]
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
        f"{len(matches['rows']) if matches else 0} matches, {len(xg)} xG, {len(odds)} odds, {len(conflicts)} score conflicts")
    for c in conflicts[:10]:
        log("  conflict:", c)


if __name__ == "__main__":
    main()
