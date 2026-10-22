#!/usr/bin/env python3
"""MatchLab - ESPN results and fixtures (v7's main match source).

ESPN's public scoreboard API covers every competition MatchLab uses, back to 2018, with the same
team id in every season and division (no name merging needed) and shots per match. One request
returns one competition-month (`?dates=YYYYMM`); a month that is over is cached for good, the
current months are refreshed after `max_age_hours`.

  python espn.py [first_year]      download / refresh, print coverage per season (default 2018)
  python espn.py 2018 --export F   also write every season since first_year to F, in the snapshot's
                                   "matches" layout (model-lab/sim_test.mjs reads it)

Standard library only. Used by collect.py and model-lab/lab.py.
"""
import json
import os
import sys
import time
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import collect as C  # noqa: E402  (http, cache, season keys)

API = "https://site.api.espn.com/apis/site/v2/sports/soccer/{slug}/scoreboard?dates={ym}"

# MatchLab code -> ESPN slug. kind: league (shown, evaluated), history (rates promoted clubs),
# cup (links the leagues' strengths). tier 2 = second division (new clubs start lower in Elo).
COMPS = {
    "en.1": dict(slug="eng.1", kind="league", tier=1, name="Premier League"),
    "es.1": dict(slug="esp.1", kind="league", tier=1, name="La Liga"),
    "de.1": dict(slug="ger.1", kind="league", tier=1, name="Bundesliga"),
    "it.1": dict(slug="ita.1", kind="league", tier=1, name="Serie A"),
    "fr.1": dict(slug="fra.1", kind="league", tier=1, name="Ligue 1"),
    "nl.1": dict(slug="ned.1", kind="league", tier=1, name="Eredivisie"),
    "pt.1": dict(slug="por.1", kind="league", tier=1, name="Liga Portugal"),
    "en.2": dict(slug="eng.2", kind="league", tier=2, name="Championship"),
    "be.1": dict(slug="bel.1", kind="league", tier=1, name="Belgian Pro League"),
    "tr.1": dict(slug="tur.1", kind="league", tier=1, name="Süper Lig"),
    "sc.1": dict(slug="sco.1", kind="league", tier=1, name="Scottish Premiership"),
    "at.1": dict(slug="aut.1", kind="league", tier=1, name="Austrian Bundesliga"),
    "gr.1": dict(slug="gre.1", kind="league", tier=1, name="Super League Greece"),
    "dk.1": dict(slug="den.1", kind="league", tier=1, name="Danish Superliga"),
    "es.2": dict(slug="esp.2", kind="history", tier=2, name="LaLiga 2"),
    "de.2": dict(slug="ger.2", kind="history", tier=2, name="2. Bundesliga"),
    "it.2": dict(slug="ita.2", kind="history", tier=2, name="Serie B"),
    "fr.2": dict(slug="fra.2", kind="history", tier=2, name="Ligue 2"),
    "uefa.cl": dict(slug="uefa.champions", kind="cup", tier=0, name="Champions League"),
    "uefa.el": dict(slug="uefa.europa", kind="cup", tier=0, name="Europa League"),
    "uefa.ecl": dict(slug="uefa.europa.conf", kind="cup", tier=0, name="Conference League"),
}
# goals ~ a x shots on target + b x other shots, non-negative least squares on every league match with
# shots before 2022 (model-lab/lab.py prints it; no validation or test season used): b comes out 0.
# Shot-based expected goals stand in for xG where Understat has none.
SHOT_COEF = (0.356, 0.0)
ORIGINAL = ["en.1", "es.1", "de.1", "it.1", "fr.1", "nl.1", "pt.1", "en.2"]   # v6's leagues
# Not used: the Swiss Super League (sui.1) has no matches on ESPN since 2025/26.
# Known holes on ESPN (checked month by month and day by day, 2026-10-23): Scottish Premiership
# 2023/24 (52 of 228) and 2. Bundesliga from November 2023 to April 2024.


def months_of_season(y):
    """July of y .. June of y+1 as YYYYMM strings."""
    return [f"{y + (m < 7)}{m:02d}" for m in list(range(7, 13)) + list(range(1, 7))]


def _stat(comp, name):
    for s in comp.get("statistics") or ():
        if s.get("name") == name:
            try:
                return int(float(s.get("displayValue")))
            except (TypeError, ValueError):
                return None
    return None


def normalise(ev):
    """One ESPN event -> compact dict, or None when it is not a usable match."""
    try:
        c = ev["competitions"][0]
        side = {x["homeAway"]: x for x in c["competitors"]}
        h, a = side["home"], side["away"]
    except (KeyError, IndexError):
        return None
    st = ev.get("status", {}).get("type", {})
    dt = datetime.fromisoformat(ev["date"].replace("Z", "+00:00")).astimezone(timezone.utc)
    m = {"id": ev["id"], "d": dt.date().isoformat(), "t": dt.strftime("%H:%M"),
         "hi": h["team"]["id"], "hn": h["team"].get("displayName") or h["team"].get("name"),
         "ai": a["team"]["id"], "an": a["team"].get("displayName") or a["team"].get("name"),
         "st": st.get("name", ""), "stage": (ev.get("season") or {}).get("slug", ""),
         # the competition's own season (its start year): the 2019/20 matches played in July 2020 belong to 2019/20
         "sy": (ev.get("season") or {}).get("year")}
    if c.get("neutralSite"):
        m["neutral"] = 1
    if st.get("completed"):
        try:
            m["hg"], m["ag"] = int(h["score"]), int(a["score"])
        except (KeyError, TypeError, ValueError):
            return None
        # ESPN's score after extra time includes its goals and there is no 90-minute score:
        # such a match keeps its winner for the record but is left out of the goal model
        if st.get("name") in ("STATUS_FINAL_AET", "STATUS_FINAL_PEN"):
            m["et"] = 1
        for k, nm in (("s", "totalShots"), ("sot", "shotsOnTarget")):
            vh, va = _stat(h, nm), _stat(a, nm)
            if vh is not None and va is not None:
                m["h" + k], m["a" + k] = vh, va
    elif st.get("state") != "pre" or st.get("name") in ("STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_ABANDONED"):
        return None                          # live, postponed, cancelled: neither a result nor a fixture yet
    return m


def fetch_month(code, ym, max_age_hours):
    """Normalised matches of one competition-month, cached; a month over for 3+ days is kept for good."""
    slug = COMPS[code]["slug"]
    y, mo = int(ym[:4]), int(ym[4:])
    last_day = (date(y + (mo == 12), mo % 12 + 1, 1) - timedelta(days=1))
    age = None if date.today() - last_day > timedelta(days=3) else max_age_hours
    if date(y, mo, 1) > date.today() + timedelta(days=62):
        return []                            # fixtures that far ahead are not needed

    def get():
        try:
            raw, _ = C.http(API.format(slug=slug, ym=ym))
            evs = json.loads(raw).get("events", [])
        except urllib.error.HTTPError as e:
            if e.code < 500:
                raise
            # some busy months time out (504) as a whole but load day by day
            evs = []
            for k in range((last_day - date(y, mo, 1)).days + 1):
                raw, _ = C.http(API.format(slug=slug, ym=(date(y, mo, 1) + timedelta(days=k)).strftime("%Y%m%d")))
                evs += json.loads(raw).get("events", [])
        return [m for m in (normalise(e) for e in evs) if m]
    data, _ = C.cached(f"espn_{code}_{ym}", get, age)
    return data


def load(codes=None, first=2018, last=None, max_age_hours=2.0, workers=12):
    """All matches of `codes` (default: every competition) from season `first` to `last` (default:
    the current one), each tagged with comp and season, sorted by date. Fetches in parallel."""
    codes = list(codes or COMPS)
    last = last or C.season_start_year()
    jobs = [(code, y, ym) for code in codes for y in range(first, last + 1) for ym in months_of_season(y)]
    errors = []

    def run(job):
        code, y, ym = job
        try:
            return job, fetch_month(code, ym, max_age_hours)
        except Exception as e:
            errors.append(f"{code} {ym}: {str(e)[:80]}")
            return job, []
    out, seen = [], set()
    with ThreadPoolExecutor(workers) as ex:
        for (code, y, ym), ms in ex.map(run, jobs):
            for m in ms:
                if m["id"] in seen:          # a month boundary in UTC can list a match twice
                    continue
                seen.add(m["id"])
                sy = m.get("sy") if isinstance(m.get("sy"), int) and abs(m["sy"] - y) <= 1 else y
                out.append(dict(m, comp=code, season=C.skey(sy)))
    out.sort(key=lambda m: (m["d"], m["t"], m["id"]))
    return out, errors


def team_names(matches):
    """ESPN team id -> the name it carried most recently."""
    names = {}
    for m in matches:                        # chronological: later names overwrite earlier ones
        names[m["hi"]] = m["hn"]
        names[m["ai"]] = m["an"]
    return names


if __name__ == "__main__":
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    first = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 2018
    t0 = time.time()
    ms, errs = load(first=first)
    if "--export" in sys.argv:
        path = sys.argv[sys.argv.index("--export") + 1]
        sec = C.matches_section(ms, C.espn_labels(ms), first + 2)      # keeps every season from `first` on
        os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
        json.dump(sec, open(path, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
        print(f"exported {len(sec['rows'])} matches to {path}")
    print(f"{len(ms)} matches in {time.time() - t0:.0f}s, {len(errs)} errors")
    for e in errs[:10]:
        print("  error:", e)
    seasons = sorted({m["season"] for m in ms})
    print("comp      " + " ".join(s[2:] for s in seasons) + "   (played; * = some without shots)")
    for code in COMPS:
        row = []
        for s in seasons:
            p = [m for m in ms if m["comp"] == code and m["season"] == s and "hg" in m]
            star = "*" if p and sum("hs" in m for m in p) < 0.9 * len(p) else " "
            row.append(f"{len(p):4}{star}")
        print(f"{code:9}" + "".join(row))
    fx = [m for m in ms if "hg" not in m]
    print(f"fixtures ahead: {len(fx)}; extra-time results: {sum('et' in m for m in ms)}; "
          f"teams: {len(team_names(ms))}; last result {max(m['d'] for m in ms if 'hg' in m)}")
