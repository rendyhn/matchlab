# Does adding xG (Understat) and the Champions League 2025/26-2026/27 (football-data.org) improve the model?
# Same walk-forward test as tune.py: each week the model sees only matches before that week.
# The fit's targets become (1-w)*goals + w*xG where xG exists; the Dixon-Coles rho and all
# evaluation use the real scores. Reads the collector's snapshot (data/latest.json).
import json, math, os, sys, time
from datetime import date, timedelta
import numpy as np
import tune

sys.stdout.reconfigure(encoding="utf-8")
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
snap = json.load(open(os.path.join(ROOT, "data", "latest.json"), encoding="utf-8"))
XG = snap.get("xg", {})


class XgModel(tune.Model):
    XGW = 0.0

    def __init__(self, data, asof, half_life, sigma, tau=0.5, teams=None):
        rows = [r for r in data if r[0] < asof]
        self.teams = teams or sorted({r[1] for r in data} | {r[2] for r in data})
        self.ti = {t: i for i, t in enumerate(self.teams)}
        comps = sorted({r[5] for r in data})
        self.ci = {c: i for i, c in enumerate(comps)}
        league_of = {}
        for r in rows:
            if r[5] != "uefa.cl":
                league_of[r[1]] = r[5]; league_of[r[2]] = r[5]
        lg = sorted(set(league_of.values()) | {"other"})
        self.li = {l: i for i, l in enumerate(lg)}
        self.team_league = np.array([self.li[league_of.get(t, "other")] for t in self.teams])
        self.league_of = league_of
        h = np.array([self.ti[r[1]] for r in rows]); a = np.array([self.ti[r[2]] for r in rows])
        gx = np.array([r[3] for r in rows], float); gy = np.array([r[4] for r in rows], float)
        x, y = gx.copy(), gy.copy()
        if XgModel.XGW > 0:
            for k, r in enumerate(rows):
                v = XG.get(f"{r[0].isoformat()}|{r[1]}|{r[2]}")
                if v:
                    x[k] = (1 - XgModel.XGW) * gx[k] + XgModel.XGW * v[0]
                    y[k] = (1 - XgModel.XGW) * gy[k] + XgModel.XGW * v[1]
        c = np.array([self.ci[r[5]] for r in rows])
        age = np.array([(asof - r[0]).days for r in rows], float)
        w = np.exp(-math.log(2) * age / half_life)
        self.fit(h, a, x, y, c, w, sigma, tau)
        # rho from the real scores, with the rates of the fitted model
        lam = np.exp(self.mu + self.home[c] + self.att[h] - self.dfn[a]); nu = np.exp(self.mu + self.att[a] - self.dfn[h])
        best, self.rho = -1e18, 0.0
        for rho in np.arange(-0.25, 0.101, 0.005):
            t = np.ones_like(lam)
            m00 = (gx == 0) & (gy == 0); m01 = (gx == 0) & (gy == 1); m10 = (gx == 1) & (gy == 0); m11 = (gx == 1) & (gy == 1)
            t[m00] = 1 - lam[m00] * nu[m00] * rho; t[m01] = 1 + lam[m01] * rho; t[m10] = 1 + nu[m10] * rho; t[m11] = 1 - rho
            if (t <= 0).any():
                continue
            ll = np.sum(w * np.log(t))
            if ll > best:
                best, self.rho = ll, rho


def with_ucl(data):
    """Adds the snapshot's extra results (Champions League 2025/26 + 2026/27, league gaps)."""
    out = list(data)
    for e in snap.get("extra", []):
        out.append((date.fromisoformat(e["d"]), e["h"], e["a"], e["hg"], e["ag"], e["comp"], e["season"]))
    out.sort(key=lambda r: r[0])
    return out


def evaluate(data, start, end, leagues):
    tune.Model = XgModel                 # evaluate() builds tune.Model each week
    return tune.evaluate(data, start, end, 240, 0.5, leagues)


if __name__ == "__main__":
    base = tune.matches()
    full = with_ucl(base)
    xg_share = sum(1 for r in base if f"{r[0].isoformat()}|{r[1]}|{r[2]}" in XG) / len(base)
    print(f"{len(base)} openfootball matches, {len(full) - len(base)} extra from football-data.org, xG on {xg_share:.0%} of matches")
    tune.Model.TOL = 1e-5
    TOP5 = {"en.1", "es.1", "de.1", "it.1", "fr.1"}
    rows = []
    grid = [] if len(sys.argv) > 1 else [("goals only", base, 0.0), ("+UCL", full, 0.0),
                           ("+UCL +xG 0.25", full, 0.25), ("+UCL +xG 0.5", full, 0.5),
                           ("+UCL +xG 0.75", full, 0.75), ("+UCL +xG 1.0", full, 1.0)]
    for label, data, w in grid:
        XgModel.XGW = w
        t0 = time.time()
        e = evaluate(data, date(2025, 8, 11), date(2026, 5, 31), tune.EVAL_LEAGUES)
        e5 = evaluate(data, date(2025, 8, 11), date(2026, 5, 31), TOP5)
        rows.append((label, e, e5))
        print(f"2025/26  {label:15}  all 8 leagues: logloss {e['logloss']:.4f} acc {e['acc']:.3f} n={e['n']} | "
              f"top-5 (have xG): logloss {e5['logloss']:.4f} acc {e5['acc']:.3f} n={e5['n']}  [{time.time() - t0:.0f}s]", flush=True)
    if len(sys.argv) > 2 and sys.argv[1] == "2425":
        # an independent full season: the xG weight was chosen on 2025/26, not on this one
        w = float(sys.argv[2])
        for label, ww in [("goals only", 0.0), (f"+xG {w}", w)]:
            XgModel.XGW = ww
            e = evaluate(full, date(2024, 10, 1), date(2025, 5, 31), tune.EVAL_LEAGUES)
            e5 = evaluate(full, date(2024, 10, 1), date(2025, 5, 31), TOP5)
            print(f"2024/25  {label:12}  all: logloss {e['logloss']:.4f} acc {e['acc']:.3f} n={e['n']} | top-5: logloss {e5['logloss']:.4f} n={e5['n']}", flush=True)
        sys.exit(0)
    if len(sys.argv) > 1:
        w = float(sys.argv[1])
        for label, data, ww in [("goals only", base, 0.0), (f"+UCL +xG {w}", full, w)]:
            XgModel.XGW = ww
            e = evaluate(data, date(2026, 8, 17), date(2026, 9, 28), tune.EVAL_LEAGUES)
            print(f"2026/27  {label:15}  logloss {e['logloss']:.4f} (base {e['base']:.4f}) acc {e['acc']:.3f} n={e['n']}")
