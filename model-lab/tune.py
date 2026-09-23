# Walk-forward tuning of a hierarchical, time-decayed Dixon-Coles model on openfootball data.
# The same algorithm is ported to the browser app; this script picks the hyperparameters and
# measures honest out-of-sample accuracy (tuned on 2025/26, reported separately on 2026/27).
import json, math, os, re, sys, time, urllib.request, concurrent.futures as cf
from datetime import date, timedelta
import numpy as np

sys.stdout.reconfigure(encoding="utf-8")
BASE = "https://raw.githubusercontent.com/openfootball/football.json/master/"
HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
os.makedirs(CACHE, exist_ok=True)

SEASONS = ["2024-25", "2025-26", "2026-27"]
LEAGUES = ["en.1", "en.2", "es.1", "es.2", "de.1", "de.2", "it.1", "it.2", "fr.1", "fr.2", "nl.1", "pt.1"]
EVAL_LEAGUES = {"en.1", "en.2", "es.1", "de.1", "it.1", "fr.1", "nl.1", "pt.1"}
CUPS = [("2024-25", "uefa.cl")]


def load(path):
    fn = os.path.join(CACHE, path.replace("/", "_"))
    if os.path.exists(fn) and time.time() - os.path.getmtime(fn) < 6 * 3600:
        return json.load(open(fn, encoding="utf-8"))
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + path, headers={"User-Agent": "Mozilla/5.0"}), timeout=30) as r:
            j = json.loads(r.read())
    except Exception:
        return None
    json.dump(j, open(fn, "w", encoding="utf-8"))
    return j


def norm(name):
    return re.sub(r"\s*\([A-Z]{3}\)\s*$", "", name).strip()


def score_ft(m):
    """Full-time score, or None. Since 2025/26 openfootball writes a 0-0 as a bare list
    ("score": [0, 0]) instead of {"ft": [0, 0]}; a bare list is only trusted once the date has passed."""
    sc = m.get("score")
    if isinstance(sc, dict):
        ft = sc.get("ft")
    elif isinstance(sc, list) and date.fromisoformat(m["date"]) < date.today():
        ft = sc
    else:
        return None
    if not isinstance(ft, list) or len(ft) != 2:
        return None
    try:
        return int(ft[0]), int(ft[1])
    except (TypeError, ValueError):
        return None


def matches():
    jobs = [(s, c) for s in SEASONS for c in LEAGUES] + CUPS
    out = []
    with cf.ThreadPoolExecutor(8) as ex:
        for (s, c), j in zip(jobs, ex.map(lambda sc: load(f"{sc[0]}/{sc[1]}.json"), jobs)):
            if not j:
                continue
            for m in j["matches"]:
                ft = score_ft(m)
                if ft is None:
                    continue
                out.append((date.fromisoformat(m["date"]), norm(m["team1"]), norm(m["team2"]), ft[0], ft[1], c, s))
    out.sort(key=lambda r: r[0])
    return out


class Model:
    """log E[home goals] = mu + home[comp] + att[h] - def[a];  log E[away goals] = mu + att[a] - def[h]
    att/def shrink to their league's mean (sd sigma); league means shrink to 0 (sd tau);
    per-competition home advantage shrinks to a shared value (sd 0.1). Weights decay with age."""

    RECENTER = True
    LEAGUE_MOVE = True
    TOL = 1e-6
    TRACE = None

    def __init__(self, data, asof, half_life, sigma, tau=0.5, teams=None):
        rows = [r for r in data if r[0] < asof]
        self.teams = teams or sorted({r[1] for r in data} | {r[2] for r in data})
        self.ti = {t: i for i, t in enumerate(self.teams)}
        comps = sorted({r[5] for r in data})
        self.ci = {c: i for i, c in enumerate(comps)}
        # current league of a team = league of its latest domestic match before asof
        league_of = {}
        for r in rows:
            if r[5] != "uefa.cl":
                league_of[r[1]] = r[5]; league_of[r[2]] = r[5]
        lg = sorted(set(league_of.values()) | {"other"})
        self.li = {l: i for i, l in enumerate(lg)}
        self.team_league = np.array([self.li[league_of.get(t, "other")] for t in self.teams])
        self.league_of = league_of
        h = np.array([self.ti[r[1]] for r in rows]); a = np.array([self.ti[r[2]] for r in rows])
        x = np.array([r[3] for r in rows], float); y = np.array([r[4] for r in rows], float)
        c = np.array([self.ci[r[5]] for r in rows])
        age = np.array([(asof - r[0]).days for r in rows], float)
        w = np.exp(-math.log(2) * age / half_life)
        self.fit(h, a, x, y, c, w, sigma, tau)

    def fit(self, h, a, x, y, c, w, sigma, tau, iters=400):
        T, C, L = len(self.teams), len(self.ci), len(self.li)
        att = np.zeros(T); dfn = np.zeros(T); home = np.full(C, 0.25); mu = 0.2
        A = np.zeros(L); D = np.zeros(L); tl = self.team_league
        s2, t2, h2 = sigma ** 2, tau ** 2, 0.1 ** 2
        for it in range(iters):
            lam = np.exp(mu + home[c] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
            # attack
            g = np.bincount(h, w * (x - lam), T) + np.bincount(a, w * (y - nu), T) - (att - A[tl]) / s2
            H = np.bincount(h, w * lam, T) + np.bincount(a, w * nu, T) + 1 / s2
            step_a = g / H; att += step_a
            lam = np.exp(mu + home[c] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
            # defence (enters with a minus sign)
            g = -(np.bincount(a, w * (x - lam), T) + np.bincount(h, w * (y - nu), T)) - (dfn - D[tl]) / s2
            H = np.bincount(a, w * lam, T) + np.bincount(h, w * nu, T) + 1 / s2
            step_d = g / H; dfn += step_d
            # league means (Gaussian conjugate)
            n = np.bincount(tl, None, L)
            A = np.bincount(tl, att, L) / s2 / (n / s2 + 1 / t2)
            D = np.bincount(tl, dfn, L) / s2 / (n / s2 + 1 / t2)
            if Model.RECENTER:
                # att+c, mu-c (and def+c, mu+c) leave every prediction unchanged; only the N(0, tau)
                # prior on league means sees the shift, and it is smallest at c = mean(league means).
                cA, cD = A.mean(), D.mean()
                att -= cA; A -= cA; dfn -= cD; D -= cD; mu += cA - cD
            if Model.LEAGUE_MOVE:
                # move a whole league (its teams and its mean together): the team priors do not
                # see it, only the likelihood and the N(0, tau) league prior do - one Newton step.
                lam = np.exp(mu + home[c] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
                g = np.bincount(h, w * (x - lam), T) + np.bincount(a, w * (y - nu), T)
                H = np.bincount(h, w * lam, T) + np.bincount(a, w * nu, T)
                dl = (np.bincount(tl, g, L) - A / t2) / (np.bincount(tl, H, L) + 1 / t2)
                att += dl[tl]; A += dl
                lam = np.exp(mu + home[c] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
                g = -(np.bincount(a, w * (x - lam), T) + np.bincount(h, w * (y - nu), T))
                H = np.bincount(a, w * lam, T) + np.bincount(h, w * nu, T)
                dl = (np.bincount(tl, g, L) - D / t2) / (np.bincount(tl, H, L) + 1 / t2)
                dfn += dl[tl]; D += dl
            lam = np.exp(mu + home[c] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
            # home advantage per competition around a shared value
            h0 = home.mean()
            g = np.bincount(c, w * (x - lam), C) - (home - h0) / h2
            H = np.bincount(c, w * lam, C) + 1 / h2
            home += g / H
            # global scoring level
            lam = np.exp(mu + home[c] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
            mu += (np.sum(w * (x - lam)) + np.sum(w * (y - nu))) / np.sum(w * (lam + nu))
            ms = max(np.abs(step_a).max(), np.abs(step_d).max())
            if Model.TRACE is not None and (it < 5 or it % 50 == 0):
                Model.TRACE.append((it, ms, mu, A.mean(), D.mean()))
            if ms < Model.TOL:
                break
        self.att, self.dfn, self.home, self.mu, self.A, self.D, self.iters = att, dfn, home, mu, A, D, it + 1
        # Dixon-Coles low-score dependence, by profile likelihood
        lam = np.exp(mu + home[c] + att[h] - dfn[a]); nu = np.exp(mu + att[a] - dfn[h])
        best, self.rho = -1e18, 0.0
        for rho in np.arange(-0.25, 0.101, 0.005):
            t = np.ones_like(lam)
            m00 = (x == 0) & (y == 0); m01 = (x == 0) & (y == 1); m10 = (x == 1) & (y == 0); m11 = (x == 1) & (y == 1)
            t[m00] = 1 - lam[m00] * nu[m00] * rho; t[m01] = 1 + lam[m01] * rho; t[m10] = 1 + nu[m10] * rho; t[m11] = 1 - rho
            if (t <= 0).any():
                continue
            ll = np.sum(w * np.log(t))
            if ll > best:
                best, self.rho = ll, rho

    def probs(self, home_team, away_team, comp):
        i, j = self.ti.get(home_team), self.ti.get(away_team)
        if i is None or j is None:
            return None
        hc = self.home[self.ci[comp]] if comp in self.ci else self.home.mean()
        lam = math.exp(self.mu + hc + self.att[i] - self.dfn[j]); nu = math.exp(self.mu + self.att[j] - self.dfn[i])
        k = np.arange(11)
        px = np.exp(-lam) * lam ** k / np.array([math.factorial(v) for v in k])
        py = np.exp(-nu) * nu ** k / np.array([math.factorial(v) for v in k])
        M = np.outer(px, py); r = self.rho
        M[0, 0] *= 1 - lam * nu * r; M[0, 1] *= 1 + lam * r; M[1, 0] *= 1 + nu * r; M[1, 1] *= 1 - r
        M /= M.sum()
        return np.tril(M, -1).sum(), np.trace(M), np.triu(M, 1).sum(), lam, nu


def evaluate(data, start, end, half_life, sigma, leagues=EVAL_LEAGUES):
    teams = sorted({r[1] for r in data} | {r[2] for r in data})
    wk = start - timedelta(days=start.weekday())
    ll = bs = acc = n = 0.0; base_ll = 0.0; cal = []
    while wk < end:
        nxt = wk + timedelta(days=7)
        test = [r for r in data if wk <= r[0] < nxt and r[5] in leagues]
        if test:
            m = Model(data, wk, half_life, sigma, teams=teams)
            train = [r for r in data if r[0] < wk and r[5] in leagues and (wk - r[0]).days < 730]
            hb = np.array([sum(r[3] > r[4] for r in train), sum(r[3] == r[4] for r in train), sum(r[3] < r[4] for r in train)], float)
            hb /= hb.sum()
            for r in test:
                p = m.probs(r[1], r[2], r[5])
                if p is None:
                    continue
                pv = np.array(p[:3]); o = 0 if r[3] > r[4] else (1 if r[3] == r[4] else 2)
                ll -= math.log(max(pv[o], 1e-12)); base_ll -= math.log(hb[o])
                e = np.zeros(3); e[o] = 1; bs += np.sum((pv - e) ** 2); acc += int(np.argmax(pv) == o); n += 1
                cal.append((pv, o))
        wk = nxt
    return dict(n=int(n), logloss=ll / n, base=base_ll / n, brier=bs / n, acc=acc / n, cal=cal)


if __name__ == "__main__":
    t0 = time.time()
    data = matches()
    print(f"{len(data)} matches loaded, {data[0][0]} .. {data[-1][0]}  ({time.time() - t0:.1f}s)")
    league_names = {r[1] for r in data if r[5] != "uefa.cl"} | {r[2] for r in data if r[5] != "uefa.cl"}
    cl_teams = {r[1] for r in data if r[5] == "uefa.cl"} | {r[2] for r in data if r[5] == "uefa.cl"}
    print(f"UCL teams: {len(cl_teams)}, matched to a league team: {len(cl_teams & league_names)}")
    mode = sys.argv[1] if len(sys.argv) > 1 else "tune"
    if mode == "diag":
        asof = date.today() + timedelta(days=1)
        zz = sum(1 for r in data if r[3] == 0 and r[4] == 0)
        print(f"0-0 in data now: {zz} of {len(data)} ({100 * zz / len(data):.1f}%)")
        for rec, mv in ((True, False), (True, True)):
            Model.RECENTER = rec; Model.LEAGUE_MOVE = mv; Model.TRACE = []
            t1 = time.time(); m = Model(data, asof, 270, 0.25); dt = time.time() - t1
            print(f"recenter={rec} league_move={mv}: {m.iters} iters in {dt:.2f}s, rho {m.rho:+.3f}, mu {m.mu:+.4f}")
            for it, ms, mu, a, d in Model.TRACE:
                print(f"   it {it:3}  max step {ms:.2e}  mu {mu:+.4f}  meanA {a:+.4f}  meanD {d:+.4f}")
            for hmt, awt, comp in [("Arsenal FC", "Manchester City FC", "en.1"), ("FC Barcelona", "Real Madrid CF", "es.1")]:
                p = m.probs(hmt, awt, comp)
                print(f"   {hmt} v {awt}: H {p[0]:.3f} D {p[1]:.3f} A {p[2]:.3f}  xG {p[3]:.2f}-{p[4]:.2f}")
        sys.exit(0)
    if mode == "tune":
        Model.TOL = 1e-5
        res = []
        grid = [(h, s) for h in (240, 300) for s in (0.4, 0.55, 0.75, 1.0)] if "wide" in sys.argv else \
               [(h, s) for h in (150, 240, 365, 540) for s in (0.15, 0.25, 0.4)]
        for hl, sg in grid:
            if True:
                t1 = time.time()
                e = evaluate(data, date(2025, 8, 11), date(2026, 5, 31), hl, sg)
                res.append((e["logloss"], hl, sg, e))
                print(f"half-life {hl:3}d sigma {sg:.2f}: logloss {e['logloss']:.4f} (base {e['base']:.4f}) brier {e['brier']:.4f} acc {e['acc']:.3f} n={e['n']}  [{time.time() - t1:.0f}s]", flush=True)
        res.sort(key=lambda r: r[0])
        print("BEST:", res[0][1], res[0][2])
    else:
        hl, sg = float(sys.argv[2]), float(sys.argv[3])
        e = evaluate(data, date(2026, 8, 17), date(2026, 9, 28), hl, sg)
        print(f"2026/27 out-of-sample: logloss {e['logloss']:.4f} (base {e['base']:.4f}) brier {e['brier']:.4f} acc {e['acc']:.3f} n={e['n']}")
        m = Model(data, date.today() + timedelta(days=1), hl, sg)
        print(f"fit: {m.iters} iters, rho {m.rho:.3f}, mu {m.mu:.3f}, home {dict(zip(m.ci, np.round(m.home, 3)))}")
        order = np.argsort(-(m.att + m.dfn))
        for k in order[:15]:
            t = m.teams[k]
            print(f"  {t:38} {m.league_of.get(t, 'other'):6} att {m.att[k]:+.3f} def {m.dfn[k]:+.3f}")
        for hmt, awt, comp in [("Arsenal FC", "Chelsea FC", "en.1"), ("FC Barcelona", "Real Madrid CF", "es.1"), ("Liverpool FC", "FC Bayern München", "en.1")]:
            p = m.probs(hmt, awt, comp)
            print(f"  {hmt} v {awt}: " + (f"H {p[0]:.3f} D {p[1]:.3f} A {p[2]:.3f}  xG {p[3]:.2f}-{p[4]:.2f}" if p else "n/a"))
