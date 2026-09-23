# MatchLab

Win / draw / loss chances for Europe's football leagues, recomputed from the latest results every time the page opens.

## The model

- **Dixon-Coles**, hierarchical and time-decayed: every team has an attack and a defence rating, pulled toward its league's average; a match's weight halves every 240 days; 60 % of the fitting target is Understat xG where it exists. It gives the goal rates, the score grid and the 1X2.
- **Elo**, goal-margin, carried from every match since 2018, turned into 1X2 by an ordered logit refitted on the last two years.
- **MatchLab = 65 % Dixon-Coles + 35 % Elo.** The score grid is rescaled to the blended 1X2 so every number on the page agrees.
- **Uncertainty**: a 90 % range for each probability and ± for each team rating, from the posterior covariance of the Dixon-Coles ratings (Laplace approximation).
- **One club, one history**: clubs that openfootball spells differently between seasons or divisions are joined into one team.

Every setting and every candidate change was chosen on 2022/23–2023/24 and tested untouched on 2024/25–2026/27 (nested walk-forward). Only the Elo blend passed: −0.0020 (±0.0012) log-loss on the test seasons. Details, and the tests that failed: [model-lab/RESULTS.md](model-lab/RESULTS.md).

## Live track record

On GitHub, `collector/forecast.mjs` runs `engine.js` — the page's own code — every two hours. Each match of the next seven days gets a forecast that is locked when its match day begins (00:00 UTC) and scored once the result is in. `data/forecasts.json` is committed on every run, so its git history shows that no forecast is changed after the fact; the page shows the summary from `data/track.js`.

## Website

GitHub Actions (`.github/workflows/update.yml`) runs the collector and the forecast archive every 2 hours, commits `data/`, and publishes `index.html`, `engine.js` and `data/` on GitHub Pages. Any upload to `main` publishes immediately. The Actions tab shows every run; "Run workflow" there starts one by hand, and its box "Refresh the bookmaker odds now" fetches new odds at once instead of waiting for the 24-hour refresh (9 credits).

The keys live only in the repository secrets `FOOTBALL_DATA_ORG_KEY` and `ODDS_API_KEY` (Settings → Secrets and variables → Actions). The collector reads them from environment variables; GitHub hides them in the log.

Run one updater only: the website's workflow *or* the Windows task (`install-schedule.cmd`). Both spend credits of the same Odds API key, and together (18 credits a day) they exceed the free 500 a month.

## Files

| Path | What it is |
|---|---|
| `index.html` | The app. Opens in any modern browser, from disk or from any static host (with `engine.js` next to it). |
| `engine.js` | Everything that turns data into forecasts: data loading, team identity, Dixon-Coles, Elo, the blend, uncertainty, the backtest and the forecast archive. Shared by the page, its backtest worker and `collector/forecast.mjs`. |
| `data/latest.js`, `data/latest.json` | Snapshot built by the collector: football-data.org results and official tables, Champions League, Understat xG, bookmaker odds, Elo ratings back to 2018. Optional — without it the app still runs on openfootball alone. |
| `data/forecasts.json`, `data/track.js` | The forecast archive and the summary the page shows (written on GitHub). |
| `collector/collect.py` | The collector (Python 3, standard library only). |
| `collector/forecast.mjs` | The forecast archive (Node 18+). |
| `collector/config.local.json` | API keys on your own PC. **Never publish or commit this file** (it is in `.gitignore`). |
| `.github/workflows/update.yml` | The website's updater: every 2 hours, then publish on GitHub Pages. |
| `update-data.bat` | Runs the collector once on Windows, in a console window. |
| `install-schedule.cmd` | Installs the Windows scheduled task "MatchLab - update data": the collector every 2 hours, no window (`collector/schedule.ps1`). It asks Windows for admin rights to register the task; the task itself runs as you. |
| `remove-schedule.cmd` | Removes that scheduled task. |
| `collector/cache/update.log` | Output of the Windows task's last run. |
| `model-lab/lab.py` | Nested walk-forward validation of the model and its variants (Python, numpy, scipy). Results in `model-lab/RESULTS.md`. |
| `model-lab/tune.py`, `model-lab/xg_test.py` | The earlier tuning scripts (v1, v3). |

## Sources

- openfootball / football.json — results and fixtures, fetched live by the page itself
- football-data.org — results, official tables, Champions League (free tier: 10 calls/min, key required)
- Understat — expected goals per match, top-5 leagues
- OpenLigaDB — Bundesliga cross-check
- The Odds API — 1X2 odds from ~20 bookmakers (free tier 500 credits/month; the collector refreshes at most every 24 h, 9 credits per refresh, however often it runs)
