# MatchLab v6 research harness - nested walk-forward validation of the model and its variants.
#
# Protocol: every setting and every model variant is chosen on the VALIDATION seasons (2022/23,
# 2023/24) and then reported, untouched, on the TEST seasons (2024/25, 2025/26, 2026/27 so far).
# Each week the model is refitted on the matches before that week only (the three seasons the
# page loads: this one and the two before), then predicts that week's league matches.
#
# The fit is a faithful numpy port of fitModel() in engine.js (hierarchical, time-decayed
# Dixon-Coles, warm-started from the previous week like the page's backtest).
#
#   python lab.py data [refresh]       download / cache everything, print coverage
#   python lab.py run NAME k=v ...     walk-forward with CFG overrides, saves out/NAME_<season>.npz
#   python lab.py grid PREFIX k=a,b .. every combination (validation seasons unless seasons=...)
#   python lab.py rank PREFIX          saved runs sorted by log-loss over the validation seasons
#   python lab.py table NAME ...       metrics of saved runs, per season
#   python lab.py diff A B             paired differences A - B with standard errors
#   python lab.py elo BASE K=20 hfa=70 Elo alone on BASE's test matches (win=1: three seasons only)
#   python lab.py ens A B              linear pool of two runs, weight chosen on validation
#   python lab.py recal A              recalibration fitted on validation, applied everywhere
# The results and the commands that produced them are in RESULTS.md. LAB_RAW_NAMES=1 turns the
# team-identity merging off (to measure what it is worth).
import json, math, os, pickle, sys, time
from datetime import date, timedelta
from multiprocessing import Pool

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "collector"))
import collect as C  # noqa: E402  (reuses the collector's downloads, cache and name matching)

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

OUT = os.path.join(HERE, "out")
LAB_CACHE = os.path.join(HERE, "cache")
FIRST_SEASON = 2018
LEAGUES = list(C.LEAGUES)                      # en.1 en.2 es.1 de.1 it.1 fr.1 nl.1 pt.1
HISTORY = C.HISTORY_ONLY                       # es.2 de.2 it.2 fr.2
UCL = "uefa.cl"
CANON = os.environ.get("LAB_RAW_NAMES") != "1"   # LAB_RAW_NAMES=1: openfootball's names as they are
VALIDATION = ["2022-23", "2023-24"]
TEST = ["2024-25", "2025-26", "2026-27"]
BASE_CFG = dict(halfLife=240.0, sigma=0.5, tau=0.5, homeSd=0.1, xgWeight=0.6, rho=1, maxIter=400, tol=1e-5,
                xgMode="blend", xgSepWeight=0.0, maxg=10)


def skey(y):
    return f"{y}-{(y + 1) % 100:02d}"


def season_of(d):
    return skey(d.year if d.month >= 7 else d.year - 1)


# ------------------------------------------------------------------ team identity (one implementation: collector)
def canonical_names(records):
    return C.canonical_names(records, UCL)


# ------------------------------------------------------------------ data
def load_all(refresh=False, canon=None):
    canon = CANON if canon is None else canon
    pk = os.path.join(LAB_CACHE, f"lab_data{'' if canon else '_raw'}.pkl")
    if not refresh and os.path.exists(pk) and time.time() - os.path.getmtime(pk) < 12 * 3600:
        return pickle.load(open(pk, "rb"))
    today = date.today()
    y0 = C.season_start_year()
    rows = []                                   # dicts like the collector's openfootball records
    for y in range(FIRST_SEASON, y0 + 1):
        s = skey(y)
        for code, kind in [(c, "league") for c in LEAGUES] + [(c, "history") for c in HISTORY] + [(UCL, "cup")]:
            try:
                j, _ = C.cached(f"of_{s}_{code}", lambda: json.loads(C.http(f"{C.OF_BASE}{s}/{code}.json")[0]),
                                12 if y >= y0 - 1 else None)
            except Exception:
                continue
            for m in j.get("matches", []):
                if not m.get("team1") or not m.get("team2") or not m.get("date"):
                    continue
                d = date.fromisoformat(m["date"])
                ft = C.score_ft(m.get("score"), d, today)
                if not ft:
                    continue
                rnd = (m.get("round") or "").lower()
                rows.append(dict(d=d, h=C.clean(m["team1"]), a=C.clean(m["team2"]), hg=ft[0], ag=ft[1], comp=code, season=s,
                                 cup=kind == "cup", reg=not rnd or rnd.startswith("matchday")))
    canon_by_comp = {}
    for r in rows:
        canon_by_comp.setdefault(r["comp"], set()).update((r["h"], r["a"]))
    all_canon = set().union(*canon_by_comp.values())
    of_cup_seasons = {r["season"] for r in rows if r["cup"]}

    # Champions League seasons openfootball lacks, from football-data.org (the free tier reaches back to 2023/24)
    cfg = C.load_config()
    if cfg["football_data_org_key"]:
        fd = C.FootballDataOrg(cfg["football_data_org_key"])
        names = C.NameMap()
        for y in range(2023, y0 + 1):
            if skey(y) in of_cup_seasons:
                continue
            for code, L in C.LEAGUES.items():
                try:
                    j, _ = C.cached(f"fd_{L['fd']}_{y}", lambda: fd.get(f"/competitions/{L['fd']}/matches?season={y}"),
                                    12 if y >= y0 - 1 else None)
                except Exception:
                    continue
                src = [(C.utc_day(m["utcDate"]), m["homeTeam"]["name"], m["awayTeam"]["name"]) for m in j.get("matches", [])
                       if (m.get("homeTeam") or {}).get("name")]
                names.learn(src, [(r["d"], r["h"], r["a"]) for r in rows if r["comp"] == code and r["season"] == skey(y)])
            try:
                j, _ = C.cached(f"fd_CL_{y}", lambda: fd.get(f"/competitions/CL/matches?season={y}"), 12 if y >= y0 - 1 else None)
            except Exception as e:
                print("CL", y, "unavailable:", str(e)[:80])
                continue
            for m in j.get("matches", []):
                hn, an = (m.get("homeTeam") or {}).get("name"), (m.get("awayTeam") or {}).get("name")
                if not hn or not an or m.get("status") != "FINISHED":
                    continue
                sc = C.fd_score(m)
                if not sc:
                    continue
                rows.append(dict(d=C.utc_day(m["utcDate"]), h=names.get(hn, all_canon, 0.85) or C.clean(hn),
                                 a=names.get(an, all_canon, 0.85) or C.clean(an), hg=sc[0], ag=sc[1], comp=UCL,
                                 season=skey(y), cup=True, reg=False))

    if canon:
        cmap = canonical_names((n, r["season"], r["comp"], r["d"].toordinal()) for r in rows for n in (r["h"], r["a"]))
        merged = sorted({(k, v) for k, v in cmap.items() if k != v}, key=lambda kv: kv[1])
        print(f"team identity: {len(merged)} names merged into their club's current name")
        if "verbose" in sys.argv:
            for k, v in merged:
                print(f"   {k:34} -> {v}")
        for r in rows:
            r["h"], r["a"] = cmap[r["h"]], cmap[r["a"]]
        canon_by_comp = {}
        for r in rows:
            canon_by_comp.setdefault(r["comp"], set()).update((r["h"], r["a"]))

    # Understat xG, matched to openfootball's names and dates like the collector does
    pair = {}
    for r in rows:
        if not r["cup"]:
            pair[(r["season"], r["comp"], r["h"], r["a"], r["reg"])] = r
    us_all = []
    for code, L in C.LEAGUES.items():
        if not L["us"]:
            continue
        for y in range(FIRST_SEASON, y0 + 1):
            def fetch(lg=L["us"], yy=y):
                raw, _ = C.http(f"https://understat.com/getLeagueData/{lg}/{yy}",
                                {"X-Requested-With": "XMLHttpRequest", "Referer": f"https://understat.com/league/{lg}/{yy}"})
                time.sleep(1.5)
                return json.loads(raw)
            try:
                j, _ = C.cached(f"us_{L['us']}_{y}", fetch, 12 if y >= y0 - 1 else None)
            except Exception as e:
                print("Understat", L["us"], y, "unavailable:", str(e)[:80])
                continue
            for m in j.get("dates", []):
                if m.get("isResult"):
                    us_all.append((code, skey(y), date.fromisoformat(m["datetime"][:10]), m["h"]["title"], m["a"]["title"],
                                   float(m["xG"]["h"]), float(m["xG"]["a"])))
    nxg = 0
    for code in C.LEAGUES:
        nm = C.NameMap()
        nm.learn([(d, h, a) for c, s, d, h, a, *_ in us_all if c == code], [(r["d"], r["h"], r["a"]) for r in rows if r["comp"] == code])
        pool = canon_by_comp.get(code, set())
        for c, s, d, hn, an, xh, xa in us_all:
            if c != code:
                continue
            h, a = nm.get(hn, pool), nm.get(an, pool)
            r = pair.get((s, code, h, a, True)) if h and a else None
            if r is not None and abs((r["d"] - d).days) <= 3:
                r["xh"], r["xa"] = xh, xa
                nxg += 1

    rows.sort(key=lambda r: r["d"])
    teams = sorted({r["h"] for r in rows} | {r["a"] for r in rows})
    ti = {t: i for i, t in enumerate(teams)}
    comps = sorted({r["comp"] for r in rows})
    D = dict(
        teams=teams, comps=comps,
        day=np.array([r["d"].toordinal() for r in rows], np.int64),
        h=np.array([ti[r["h"]] for r in rows], np.int64), a=np.array([ti[r["a"]] for r in rows], np.int64),
        hg=np.array([r["hg"] for r in rows], float), ag=np.array([r["ag"] for r in rows], float),
        xh=np.array([r.get("xh", np.nan) for r in rows], float), xa=np.array([r.get("xa", np.nan) for r in rows], float),
        comp=np.array([comps.index(r["comp"]) for r in rows], np.int64),
        season=np.array([int(r["season"][:4]) for r in rows], np.int64),
        cup=np.array([r["cup"] for r in rows], bool),
    )
    os.makedirs(LAB_CACHE, exist_ok=True)
    pickle.dump(D, open(pk, "wb"))
    print(f"{len(rows)} matches, {len(teams)} teams, xG on {nxg}; seasons {FIRST_SEASON}..{y0}")
    return D


# ------------------------------------------------------------------ model (port of engine.js fitModel)
def fit(D, idx, asof, cfg, init=None, xw=None):
    """idx: indices (chronological) of the training matches, all before asof."""
    T = len(D["teams"])
    h, a, cc = D["h"][idx], D["a"][idx], D["comp"][idx]
    gx, gy = D["hg"][idx], D["ag"][idx]
    xw = cfg["xgWeight"] if xw is None else xw
    xh, xa = D["xh"][idx], D["xa"][idx]
    X = np.where(np.isnan(xh) | (xw <= 0), gx, (1 - xw) * gx + xw * np.nan_to_num(xh))
    Y = np.where(np.isnan(xa) | (xw <= 0), gy, (1 - xw) * gy + xw * np.nan_to_num(xa))
    W = np.exp(-math.log(2) / cfg["halfLife"] * (asof - D["day"][idx]))
    # a team's league = its latest domestic competition before asof
    lg_of = np.full(T, -1)
    dom = ~D["cup"][idx]
    lg_of[h[dom]] = cc[dom]; lg_of[a[dom]] = cc[dom]            # later rows overwrite earlier ones
    comps_used = np.unique(cc)
    lg_codes = sorted(set(lg_of[lg_of >= 0].tolist())) + [-1]    # -1 = "other"
    li = {c: k for k, c in enumerate(lg_codes)}
    tl = np.array([li[c] for c in lg_of])
    L, C_ = len(lg_codes), len(D["comps"])
    s2, t2, h2 = cfg["sigma"] ** 2, cfg["tau"] ** 2, cfg["homeSd"] ** 2
    att = init["att"].copy() if init else np.zeros(T)
    dfn = init["dfn"].copy() if init else np.zeros(T)
    home = init["home"].copy() if init else np.full(C_, 0.25)
    mu = init["mu"] if init else 0.2
    used = np.zeros(C_, bool); used[comps_used] = True
    cntL = np.bincount(tl, minlength=L).astype(float)
    LA = np.bincount(tl, att, L) / s2 / (cntL / s2 + 1 / t2)
    LD = np.bincount(tl, dfn, L) / s2 / (cntL / s2 + 1 / t2)
    it = 0
    for it in range(1, cfg["maxIter"] + 1):
        lam = np.exp(mu + home[cc] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
        g = np.bincount(h, W * (X - lam), T) + np.bincount(a, W * (Y - nu), T)
        H = np.bincount(h, W * lam, T) + np.bincount(a, W * nu, T)
        st_a = (g - (att - LA[tl]) / s2) / (H + 1 / s2); att += st_a
        lam = np.exp(mu + home[cc] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
        g = -(np.bincount(a, W * (X - lam), T) + np.bincount(h, W * (Y - nu), T))
        H = np.bincount(a, W * lam, T) + np.bincount(h, W * nu, T)
        st_d = (g - (dfn - LD[tl]) / s2) / (H + 1 / s2); dfn += st_d
        LA = np.bincount(tl, att, L) / s2 / (cntL / s2 + 1 / t2)
        LD = np.bincount(tl, dfn, L) / s2 / (cntL / s2 + 1 / t2)
        cA, cD = LA.mean(), LD.mean()
        att -= cA; LA -= cA; dfn -= cD; LD -= cD; mu += cA - cD
        lam = np.exp(mu + home[cc] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
        gl = np.bincount(tl[h], W * (X - lam), L) + np.bincount(tl[a], W * (Y - nu), L)
        hl = np.bincount(tl[h], W * lam, L) + np.bincount(tl[a], W * nu, L)
        dl = (gl - LA / t2) / (hl + 1 / t2); LA += dl; att += dl[tl]
        lam = np.exp(mu + home[cc] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
        gl = -(np.bincount(tl[a], W * (X - lam), L) + np.bincount(tl[h], W * (Y - nu), L))
        hl = np.bincount(tl[a], W * lam, L) + np.bincount(tl[h], W * nu, L)
        dl = (gl - LD / t2) / (hl + 1 / t2); LD += dl; dfn += dl[tl]
        lam = np.exp(mu + home[cc] + att[h] - dfn[a])
        h0 = home[used].mean()
        gc = np.bincount(cc, W * (X - lam), C_); hc = np.bincount(cc, W * lam, C_)
        home[used] += ((gc - (home - h0) / h2) / (hc + 1 / h2))[used]
        lam = np.exp(mu + home[cc] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
        mu += (np.sum(W * (X - lam)) + np.sum(W * (Y - nu))) / np.sum(W * (lam + nu))
        if max(np.abs(st_a).max(), np.abs(st_d).max()) < cfg["tol"]:
            break
    lam = np.exp(mu + home[cc] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
    rho = fit_rho(gx, gy, lam, nu, W) if cfg["rho"] else 0.0
    return dict(att=att, dfn=dfn, home=home, used=used, mu=mu, rho=rho, iters=it)


def fit_rho(gx, gy, lam, nu, W):
    m = (gx <= 1) & (gy <= 1)
    x, y, l, n, w = gx[m], gy[m], lam[m], nu[m], W[m]
    best, rho = -1e18, 0.0
    for r in np.arange(-50, 21) * 0.005:
        t = np.where((x == 0) & (y == 0), 1 - l * n * r, np.where(x == 0, 1 + l * r, np.where(y == 0, 1 + n * r, 1 - r)))
        if (t <= 0).any():
            continue
        ll = np.sum(w * np.log(t))
        if ll > best:
            best, rho = ll, r
    return rho


def rates(M, D, idx):
    home = np.where(M["used"][D["comp"][idx]], M["home"][D["comp"][idx]], M["home"][M["used"]].mean())
    lam = np.exp(M["mu"] + home + M["att"][D["h"][idx]] - M["dfn"][D["a"][idx]])
    nu = np.exp(M["mu"] + M["att"][D["a"][idx]] - M["dfn"][D["h"][idx]])
    return lam, nu


def probs(lam, nu, rho, maxg=10):
    """1X2 from Poisson rates with the Dixon-Coles adjustment, truncated at maxg and renormalised."""
    k = np.arange(maxg + 1)
    lf = np.array([math.lgamma(v + 1) for v in k])
    px = np.exp(-lam[:, None] + k[None, :] * np.log(lam[:, None]) - lf[None, :])
    py = np.exp(-nu[:, None] + k[None, :] * np.log(nu[:, None]) - lf[None, :])
    G = px[:, :, None] * py[:, None, :]
    G[:, 0, 0] *= 1 - lam * nu * rho; G[:, 0, 1] *= 1 + lam * rho; G[:, 1, 0] *= 1 + nu * rho; G[:, 1, 1] *= 1 - rho
    G /= G.sum(axis=(1, 2), keepdims=True)
    iu = np.tril(np.ones((maxg + 1, maxg + 1), bool), -1)
    pH = G[:, iu].sum(1); pD = np.trace(G, axis1=1, axis2=2); pA = 1 - pH - pD
    return np.stack([pH, pD, pA], 1)


# ------------------------------------------------------------------ walk-forward
def walk(season, cfg):
    D = DATA
    y = int(season[:4])
    start = date(y, 7, 1).toordinal(); end = min(date(y + 1, 7, 1).toordinal(), date.today().toordinal() + 1)
    lg_codes = {D["comps"].index(c) for c in ([UCL] if cfg.get("evalCup") else LEAGUES) if c in D["comps"]}
    eval_mask = np.isin(D["comp"], list(lg_codes)) & (D["season"] == y)
    window = (D["season"] >= y - 2) & (D["season"] <= y)          # the page loads three seasons
    wk = start - date.fromordinal(start).weekday()
    out = dict(i=[], p=[], lam=[], nu=[], rho=[], pg=[], px=[])
    init = init_g = init_x = None
    while wk < end:
        test = np.where(eval_mask & (D["day"] >= wk) & (D["day"] < wk + 7))[0]
        if len(test):
            tr = np.where(window & (D["day"] < wk))[0]
            if cfg["xgMode"] == "sep":
                Mg = fit(D, tr, wk, cfg, init_g, xw=0.0); init_g = Mg
                Mx = fit(D, tr, wk, cfg, init_x, xw=1.0); init_x = Mx
                lg_, ng_ = rates(Mg, D, test); lx_, nx_ = rates(Mx, D, test)
                w = cfg["xgSepWeight"]
                lam = np.exp((1 - w) * np.log(lg_) + w * np.log(lx_)); nu = np.exp((1 - w) * np.log(ng_) + w * np.log(nx_))
                lt_g, nt_g = rates(Mg, D, tr); lt_x, nt_x = rates(Mx, D, tr)
                Wt = np.exp(-math.log(2) / cfg["halfLife"] * (wk - D["day"][tr]))
                rho = fit_rho(D["hg"][tr], D["ag"][tr], np.exp((1 - w) * np.log(lt_g) + w * np.log(lt_x)),
                              np.exp((1 - w) * np.log(nt_g) + w * np.log(nt_x)), Wt) if cfg["rho"] else 0.0
                out["pg"].append(probs(lg_, ng_, Mg["rho"], cfg["maxg"])); out["px"].append(probs(lx_, nx_, Mx["rho"], cfg["maxg"]))
            else:
                M = fit(D, tr, wk, cfg, init); init = M
                lam, nu = rates(M, D, test); rho = M["rho"]
            out["i"].append(test); out["p"].append(probs(lam, nu, rho, cfg["maxg"]))
            out["lam"].append(lam); out["nu"].append(nu); out["rho"].append(np.full(len(test), rho))
        wk += 7
    return {k: (np.concatenate(v) if v else np.zeros(0)) for k, v in out.items()}


def outcome(D, i):
    return np.where(D["hg"][i] > D["ag"][i], 0, np.where(D["hg"][i] == D["ag"][i], 1, 2))


def per_match(P, o):
    """Per-match scores (lower is better): log-loss, Brier, RPS; and hit."""
    e = np.eye(3)[o]
    ll = -np.log(np.clip(P[np.arange(len(o)), o], 1e-12, None))
    br = ((P - e) ** 2).sum(1)
    cp, ce = np.cumsum(P, 1)[:, :2], np.cumsum(e, 1)[:, :2]
    rps = ((cp - ce) ** 2).sum(1) / 2
    hit = (P.argmax(1) == o).astype(float)
    return ll, br, rps, hit


def ece(P, o, bins=10):
    e = np.eye(3)[o]; p, y = P.ravel(), e.ravel()
    b = np.minimum((p * bins).astype(int), bins - 1)
    tot = 0.0
    for k in range(bins):
        m = b == k
        if m.any():
            tot += m.sum() * abs(p[m].mean() - y[m].mean())
    return tot / len(p)


def metrics(P, o):
    ll, br, rps, hit = per_match(P, o)
    return dict(n=len(o), ll=ll.mean(), brier=br.mean(), rps=rps.mean(), acc=hit.mean(), ece=ece(P, o),
                pdraw=P[:, 1].mean(), draw=(o == 1).mean())


# ------------------------------------------------------------------ Elo (a second, independent model)
def elo_diffs(D, K=20.0, hfa=70.0, new_top=1500.0, new_second=1350.0, mask=None):
    """Goal-margin Elo over every match since 2018 (or only those in mask), frozen at the start of
    each week like the walk-forward. Returns R_home - R_away (before the match's week) per match."""
    second = {D["comps"].index(c) for c in ("en.2",) + tuple(HISTORY) if c in D["comps"]}
    R = {}
    dr = np.zeros(len(D["day"]))
    wk_of = D["day"] - np.array([date.fromordinal(int(d)).weekday() for d in D["day"]])
    order = np.argsort(D["day"], kind="stable")
    if mask is not None:
        order = order[mask[order]]
    k = 0
    while k < len(order):
        w = wk_of[order[k]]
        j = k
        while j < len(order) and wk_of[order[j]] == w:
            j += 1
        idx = order[k:j]
        for i in idx:
            for t in (D["h"][i], D["a"][i]):
                if t not in R:
                    R[t] = new_second if D["comp"][i] in second else new_top
            dr[i] = R[D["h"][i]] - R[D["a"][i]]
        for i in idx:                       # results of the week applied after it
            e = 1 / (1 + 10 ** (-(dr[i] + hfa) / 400))
            gd = abs(D["hg"][i] - D["ag"][i])
            g = 1.0 if gd <= 1 else 1.5 if gd == 2 else (11 + gd) / 8
            s = 1.0 if D["hg"][i] > D["ag"][i] else 0.5 if D["hg"][i] == D["ag"][i] else 0.0
            R[D["h"][i]] += K * g * (s - e); R[D["a"][i]] -= K * g * (s - e)
        k = j
    return dr


def ordered_logit_fit(z, o):
    """P(away) = s(t1 - b z), P(away or draw) = s(t2 - b z); t2 = t1 + exp(d)."""
    from scipy.optimize import minimize

    def nll(p):
        b, t1, d = p
        t2 = t1 + math.exp(d)
        a = 1 / (1 + np.exp(-(t1 - b * z))); ad = 1 / (1 + np.exp(-(t2 - b * z)))
        P = np.stack([1 - ad, ad - a, a], 1)
        return -np.log(np.clip(P[np.arange(len(o)), o], 1e-12, None)).sum()
    return minimize(nll, [1.0, -1.0, 0.0], method="Nelder-Mead", options=dict(xatol=1e-4, fatol=1e-3, maxiter=400)).x


def ordered_logit_probs(p, z):
    b, t1, d = p
    t2 = t1 + math.exp(d)
    a = 1 / (1 + np.exp(-(t1 - b * z))); ad = 1 / (1 + np.exp(-(t2 - b * z)))
    return np.stack([1 - ad, ad - a, a], 1)


def elo_run(D, test_i, dr):
    """Elo probabilities for the test matches of a walk-forward run: the Elo -> 1X2 mapping is
    refitted each week on the league matches of the two years before it."""
    lg_codes = [D["comps"].index(c) for c in LEAGUES if c in D["comps"]]
    league = np.isin(D["comp"], lg_codes)
    o_all = outcome(D, np.arange(len(D["day"])))
    wk = D["day"][test_i] - np.array([date.fromordinal(int(d)).weekday() for d in D["day"][test_i]])
    P = np.zeros((len(test_i), 3))
    for w in np.unique(wk):
        tr = np.where(league & (D["day"] < w) & (D["day"] >= w - 730))[0]
        p = ordered_logit_fit(dr[tr] / 400, o_all[tr])
        m = wk == w
        P[m] = ordered_logit_probs(p, dr[test_i[m]] / 400)
    return P


# ------------------------------------------------------------------ calibration
def recal_fit(P, o):
    """Multinomial recalibration p'_k ~ p_k^a * exp(c_k), c_home = 0: temperature + draw/away shifts."""
    from scipy.optimize import minimize
    L = np.log(np.clip(P, 1e-12, None))

    def nll(q):
        Z = q[0] * L + np.array([0.0, q[1], q[2]])
        Z -= Z.max(1, keepdims=True)
        Q = np.exp(Z); Q /= Q.sum(1, keepdims=True)
        return -np.log(Q[np.arange(len(o)), o]).sum()
    return minimize(nll, [1.0, 0.0, 0.0], method="Nelder-Mead", options=dict(xatol=1e-5, fatol=1e-4, maxiter=800)).x


def recal_apply(q, P):
    Z = q[0] * np.log(np.clip(P, 1e-12, None)) + np.array([0.0, q[1], q[2]])
    Z -= Z.max(1, keepdims=True)
    Q = np.exp(Z)
    return Q / Q.sum(1, keepdims=True)


def save_like(base_name, new_name, season, P):
    r = loadrun(base_name, season)
    r["p"] = P
    np.savez_compressed(os.path.join(OUT, f"{new_name}_{season}.npz"), **r)


# ------------------------------------------------------------------ jobs
DATA = None


def _init():
    global DATA
    DATA = load_all()


def _job(args):
    name, season, cfg = args
    t0 = time.time()
    r = walk(season, cfg)
    os.makedirs(OUT, exist_ok=True)
    np.savez_compressed(os.path.join(OUT, f"{name}_{season}.npz"), cfg=json.dumps(cfg), **r)
    return name, season, time.time() - t0


def run(jobs, procs=4):
    with Pool(procs, initializer=_init) as pool:
        for name, season, dt in pool.imap_unordered(_job, jobs):
            print(f"  done {name} {season} in {dt:.0f}s", flush=True)


def loadrun(name, season):
    z = np.load(os.path.join(OUT, f"{name}_{season}.npz"))
    return {k: z[k] for k in z.files}


def parse_cfg(kvs):
    cfg = dict(BASE_CFG)
    for kv in kvs:
        k, v = kv.split("=")
        cfg[k] = v if k == "xgMode" else (int(v) if k in ("rho", "maxg", "maxIter") else float(v))
    return cfg


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "data"
    if mode == "data":
        D = load_all(refresh="refresh" in sys.argv)
        for y in range(FIRST_SEASON, C.season_start_year() + 1):
            m = D["season"] == y
            lgm = m & ~D["cup"]
            print(f"{skey(y)}: {m.sum():5} matches, UCL {(m & D['cup']).sum():4}, xG {(~np.isnan(D['xh'][lgm])).sum():5}, "
                  f"0-0 {((D['hg'] == 0) & (D['ag'] == 0))[lgm].mean():.3f}")
    elif mode == "run":
        name = sys.argv[2]
        seasons = [a.split("=")[1].split(",") for a in sys.argv[3:] if a.startswith("seasons=")]
        seasons = seasons[0] if seasons else VALIDATION + TEST
        cfg = parse_cfg([a for a in sys.argv[3:] if "=" in a and not a.startswith("seasons=")])
        t0 = time.time()
        run([(name, s, cfg) for s in seasons])
        print(f"{name}: {time.time() - t0:.0f}s")
    elif mode == "grid":
        # python lab.py grid PREFIX halfLife=120,240 sigma=0.3,0.5 [seasons=...]  - every combination
        prefix = sys.argv[2]
        seasons = [a.split("=")[1].split(",") for a in sys.argv[3:] if a.startswith("seasons=")]
        seasons = seasons[0] if seasons else VALIDATION
        axes = [(a.split("=")[0], a.split("=")[1].split(",")) for a in sys.argv[3:] if "=" in a and not a.startswith("seasons=")]
        combos = [[]]
        for k, vs in axes:
            combos = [c + [(k, v)] for c in combos for v in vs]
        jobs = []
        for c in combos:
            name = prefix + "_" + "_".join(f"{k}{v}" for k, v in c)
            cfg = parse_cfg([f"{k}={v}" for k, v in c])
            jobs += [(name, s, cfg) for s in seasons if not os.path.exists(os.path.join(OUT, f"{name}_{s}.npz"))]
        t0 = time.time()
        run(jobs)
        print(f"{len(jobs)} jobs in {time.time() - t0:.0f}s")
    elif mode == "rank":
        # python lab.py rank PREFIX [seasons=...]  - runs sorted by mean log-loss over those seasons
        D = load_all()
        prefix = sys.argv[2]
        seasons = [a.split("=")[1].split(",") for a in sys.argv[3:] if a.startswith("seasons=")]
        seasons = seasons[0] if seasons else VALIDATION
        names = sorted({f[: f.rfind("_")] for f in os.listdir(OUT) if f.startswith(prefix) and f.endswith(".npz")})
        rows = []
        for name in names:
            ll, br, rp, n = 0.0, 0.0, 0.0, 0
            ok = True
            for s in seasons:
                if not os.path.exists(os.path.join(OUT, f"{name}_{s}.npz")):
                    ok = False; break
                r = loadrun(name, s); o = outcome(D, r["i"].astype(int)); l, b, p, _ = per_match(r["p"], o)
                ll += l.sum(); br += b.sum(); rp += p.sum(); n += len(o)
            if ok and n:
                rows.append((ll / n, br / n, rp / n, n, name))
        for ll, br, rp, n, name in sorted(rows)[:25]:
            print(f"{name:52} LL {ll:.5f}  Brier {br:.5f}  RPS {rp:.5f}  n={n}")
    elif mode == "elo":
        # python lab.py elo BASE K=20 hfa=70  - Elo alone (saved as elo_K.._h..) on BASE's test matches
        D = load_all()
        base = sys.argv[2]
        kv = dict(a.split("=") for a in sys.argv[3:] if "=" in a)
        K, hfa = float(kv.get("K", 20)), float(kv.get("hfa", 70))
        win = kv.get("win") == "1"            # win=1: only the three seasons the page loads
        dr = elo_diffs(D, K, hfa)
        name = f"elo_K{kv.get('K', 20)}_h{kv.get('hfa', 70)}" + ("_win" if win else "")
        for s in VALIDATION + TEST:
            r = loadrun(base, s)
            if win:
                y = int(s[:4])
                dr = elo_diffs(D, K, hfa, mask=(D["season"] >= y - 2) & (D["season"] <= y))
            save_like(base, name, s, elo_run(D, r["i"].astype(int), dr))
        print(name, "saved")
    elif mode == "ens":
        # python lab.py ens A B  - linear pool w*A + (1-w)*B, w chosen on validation, saved as ens_A_B
        D = load_all()
        A, B = sys.argv[2], sys.argv[3]
        best = None
        for w in np.arange(0, 1.0001, 0.05):
            ll, n = 0.0, 0
            for s in VALIDATION:
                ra, rb = loadrun(A, s), loadrun(B, s); o = outcome(D, ra["i"].astype(int))
                l, *_ = per_match(w * ra["p"] + (1 - w) * rb["p"], o); ll += l.sum(); n += len(o)
            print(f"  w={w:.2f}  validation LL {ll / n:.5f}")
            if best is None or ll / n < best[0]:
                best = (ll / n, w)
        w = best[1]
        for s in VALIDATION + TEST:
            ra, rb = loadrun(A, s), loadrun(B, s)
            save_like(A, f"ens_{A}_{B}", s, w * ra["p"] + (1 - w) * rb["p"])
        print(f"chosen w={w:.2f} on validation; saved ens_{A}_{B}")
    elif mode == "recal":
        # python lab.py recal A  - recalibration fitted on A's validation predictions, applied everywhere
        D = load_all()
        A = sys.argv[2]
        Ps, os_ = [], []
        for s in VALIDATION:
            r = loadrun(A, s); Ps.append(r["p"]); os_.append(outcome(D, r["i"].astype(int)))
        q = recal_fit(np.concatenate(Ps), np.concatenate(os_))
        print(f"recalibration: a={q[0]:.4f} c_draw={q[1]:+.4f} c_away={q[2]:+.4f}")
        for s in VALIDATION + TEST:
            save_like(A, f"recal_{A}", s, recal_apply(q, loadrun(A, s)["p"]))
    elif mode == "table":
        D = load_all()
        for name in sys.argv[2:]:
            for s in VALIDATION + TEST:
                if not os.path.exists(os.path.join(OUT, f"{name}_{s}.npz")):
                    continue
                r = loadrun(name, s); o = outcome(D, r["i"].astype(int)); m = metrics(r["p"], o)
                print(f"{name:16} {s}  n={m['n']:5}  LL {m['ll']:.4f}  Brier {m['brier']:.4f}  RPS {m['rps']:.4f}  "
                      f"acc {m['acc']:.3f}  ECE {m['ece']:.4f}  draw {m['pdraw']:.3f}/{m['draw']:.3f}")
    elif mode == "diff":
        D = load_all()
        A, B = sys.argv[2], sys.argv[3]
        for group, seasons in (("validation", VALIDATION), ("test", TEST)):
            dl, db, dr = [], [], []
            for s in seasons:
                if not (os.path.exists(os.path.join(OUT, f"{A}_{s}.npz")) and os.path.exists(os.path.join(OUT, f"{B}_{s}.npz"))):
                    continue
                ra, rb = loadrun(A, s), loadrun(B, s)
                assert (ra["i"] == rb["i"]).all()
                o = outcome(D, ra["i"].astype(int))
                la, ba, pa, _ = per_match(ra["p"], o); lb, bb, pb, _ = per_match(rb["p"], o)
                d = la - lb
                print(f"  {s}: dLL {d.mean():+.4f} (se {d.std() / math.sqrt(len(d)):.4f})  dBrier {(ba - bb).mean():+.4f}  dRPS {(pa - pb).mean():+.4f}")
                dl.append(d); db.append(ba - bb); dr.append(pa - pb)
            if dl:
                d = np.concatenate(dl)
                print(f"{group:10} {A} - {B}: dLL {d.mean():+.5f} +- {2 * d.std() / math.sqrt(len(d)):.5f} (2se), "
                      f"dBrier {np.concatenate(db).mean():+.5f}, dRPS {np.concatenate(dr).mean():+.5f}, n={len(d)}")
