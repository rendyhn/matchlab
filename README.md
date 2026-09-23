# MatchLab

Win / draw / loss chances for Europe's football leagues, recomputed from the latest results every time the page opens.

## Website

GitHub Actions (`.github/workflows/update.yml`) runs the collector every 2 hours, commits the new `data/latest.*` and publishes `index.html` + `data/` on GitHub Pages. Any upload to `main` publishes immediately. The Actions tab shows every run; "Run workflow" there starts one by hand, and its box "Refresh the bookmaker odds now" fetches new odds at once instead of waiting for the 24-hour refresh (9 credits).

The keys live only in the repository secrets `FOOTBALL_DATA_ORG_KEY` and `ODDS_API_KEY` (Settings → Secrets and variables → Actions). The collector reads them from environment variables; GitHub hides them in the log.

Run one updater only: the website's workflow *or* the Windows task (`install-schedule.cmd`). Both spend credits of the same Odds API key, and together (18 credits a day) they exceed the free 500 a month.

## Files

| Path | What it is |
|---|---|
| `index.html` | The app. Opens in any modern browser, from disk or from any static host. |
| `data/latest.js`, `data/latest.json` | Snapshot built by the collector: football-data.org results and official tables, Champions League, Understat xG, bookmaker odds. Optional — without it the app still runs on openfootball alone. |
| `collector/collect.py` | The collector (Python 3, standard library only). |
| `collector/config.local.json` | API keys on your own PC. **Never publish or commit this file** (it is in `.gitignore`). |
| `.github/workflows/update.yml` | The website's updater: every 2 hours, then publish on GitHub Pages. |
| `update-data.bat` | Runs the collector once on Windows, in a console window. |
| `install-schedule.cmd` | Installs the Windows scheduled task "MatchLab - update data": the collector every 2 hours, no window (`collector/schedule.ps1`). It asks Windows for admin rights to register the task; the task itself runs as you. |
| `remove-schedule.cmd` | Removes that scheduled task. |
| `collector/cache/update.log` | Output of the Windows task's last run. |
| `model-lab/` | Offline tuning and the xG walk-forward test. |

## Sources

- openfootball / football.json — results and fixtures, fetched live by the page itself
- football-data.org — results, official tables, Champions League (free tier: 10 calls/min, key required)
- Understat — expected goals per match, top-5 leagues
- OpenLigaDB — Bundesliga cross-check
- The Odds API — 1X2 odds from ~20 bookmakers (free tier 500 credits/month; the collector refreshes at most every 24 h, 9 credits per refresh, however often it runs)
