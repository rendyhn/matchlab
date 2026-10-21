# MatchLab v6 — what was tested, and what changed

Every candidate change was judged by out-of-sample probability forecasts, not by hit rate.

## Protocol

- **Walk-forward, weekly.** Each week the model is refitted on the matches before that week only, using the three seasons the page loads (that season and the two before), then it forecasts that week's matches in the eight leagues (Premier League, La Liga, Bundesliga, Serie A, Ligue 1, Eredivisie, Liga Portugal, Championship).
- **Nested.** Settings and model variants were chosen on the **validation** seasons 2022/23 and 2023/24 (5,916 matches). Only then were they run on the **test** seasons 2024/25, 2025/26 and 2026/27 so far (6,290 matches), which played no part in any choice.
- **Scores.** Log-loss (main), Brier, ranked probability score, accuracy and expected calibration error. Every difference between two variants is paired, match by match, and reported with ±2 standard errors. A change had to beat that noise on the validation seasons and hold up on the test seasons.
- **Data.** openfootball 2018/19 to now, football-data.org Champions League 2023/24 onwards (the free tier stops there), and Understat xG for the top-5 leagues. 32,259 matches.

`lab.py` reproduces everything: `python lab.py data`, then the commands below.

## Found on the way: one club, two histories

openfootball renames clubs between seasons and divisions: "VfL Bochum 1848" in the Bundesliga is "VfL Bochum" in 2. Bundesliga, and "Deportivo La Coruña" in Segunda is "RC Deportivo La Coruña" in La Liga. Each spelling was treated as a new team, so a club lost its history whenever it moved division or its name was restyled. Within the three seasons the page loads this split six clubs, including two teams promoted to La Liga for 2026/27 (Deportivo, Racing Santander), which were being rated as if they had never played.

Fix: names are joined when they come from the same country, one's name tokens contain the other's, reserve-team markers agree ("Real Sociedad B" is not "Real Sociedad") and they never appear in the same season. 85 merges over 2018–2026, all checked by hand. Implemented once in `collector/collect.py` (`canonical_names`) and mirrored in `engine.js` (`canonicalNames`), which produce identical results.

| Log-loss | 2022/23 | 2023/24 | 2024/25 | 2025/26 | 2026/27 |
|---|---|---|---|---|---|
| names as openfootball writes them | 0.9846 | 0.9800 | 0.9872 | 1.0010 | 1.0133 |
| clubs joined | 0.9847 | 0.9780 | 0.9872 | 1.0000 | 1.0118 |

Small on average because few clubs are affected — large for those clubs.

## Tests

| Change | Validation Δ log-loss | Test Δ log-loss | Decision |
|---|---|---|---|
| Re-tuned settings (half-life 180, σ 0.8, τ 0.5, home sd 0.05; best of 58 tried on validation) | −0.0007 ± 0.0010 | +0.0003 ± 0.0010 | not adopted |
| Plain Poisson instead of Dixon-Coles | +0.0005 ± 0.0005 | **+0.0008 ± 0.0004** | Dixon-Coles kept |
| Separate xG model, blended on log rates (instead of 60 % xG in the targets) | +0.0000 ± 0.0003 | +0.0001 ± 0.0003 | not adopted |
| **Elo blend: 65 % Dixon-Coles + 35 % Elo** | −0.0011 ± 0.0012 | **−0.0020 ± 0.0012** | **adopted** |
| Recalibration layer on top of the blend | −0.0011 ± 0.0012 | −0.0004 ± 0.0012 | not adopted |

Commands: `grid g1 halfLife=120,180,240,365 sigma=0.3,0.5,0.8 xgWeight=0.4,0.6,0.8`, `grid g2 halfLife=180,240 sigma=0.8,1.0,1.5 tau=0.3,0.5,1.0`, `grid g3 halfLife=180 sigma=0.8 tau=0.5 homeSd=0.03,0.05,0.2,0.4`, `run t1 halfLife=180 sigma=0.8 tau=0.5 homeSd=0.05`, `run poisson rho=0`, `grid sep xgMode=sep xgSepWeight=0.3,0.5,0.7`, `elo base K=20 hfa=70`, `ens base elo_K20_h70`, `recal ens_base_elo_K20_h70`, each followed by `diff`.

### The settings

The grid is flat around its best point: half-life 180–240 days, σ 0.5–1.0, τ 0.5–1.0 and the xG share 0.6 all land within 0.0008 of the best validation log-loss (0.9806). The values chosen for v1 on 2025/26 (0.9814 here) are optimal within noise on 2022/23–2023/24 too, and the best validation point does not beat them on the test seasons, so they stay.

### Elo

Goal-margin Elo (K 20, home 70 points, margin multiplier 1 / 1.5 / (11 + margin) / 8), frozen for a week at a time like the model's refits. An ordered logit, refitted weekly on the league matches of the two years before, turns the rating gap into 1/X/2. Alone it is about as good as Dixon-Coles (test log-loss 0.9955 against 0.9950). The two read the data differently, so the blend beats both, and it does so in every test season:

| Log-loss | 2024/25 | 2025/26 | 2026/27 |
|---|---|---|---|
| Dixon-Coles | 0.9872 | 1.0000 | 1.0118 |
| Blend 65/35 | 0.9861 | 0.9980 | 1.0041 |

Elo needs its history. With only the three seasons the page loads it is much weaker (test 1.0003), and the blend's gain is no longer significant (−0.0011 ± 0.0014). So the collector computes the ratings from every season since 2018 up to where the page's three seasons begin (`snapshot.elo`), and the page carries them forward. `collector.elo_run` and the lab's Elo give identical differences on all 32,259 matches.

On Champions League matches (502 in 2023/24–2025/26; too few to decide anything on their own) the blend scored 0.920 against 0.926 for Dixon-Coles alone, so it is used for every match.

## What else v6 adds

- **Uncertainty.** The posterior covariance of the Dixon-Coles ratings (Laplace approximation: the full Hessian of data plus priors, so league-level uncertainty is included) gives a 90 % range for each 1X2 probability and ± for each team's rating. It covers the ratings only — not injuries, line-ups or news.
- **Scores beyond accuracy.** The page's own walk-forward now shows Brier, RPS and calibration error, and the log-loss of each part.
- **Live track record.** `collector/forecast.mjs` runs `engine.js` — the page's own code — on GitHub every two hours. Forecasts for the next seven days are locked when their match day begins (00:00 UTC) and scored after the match; the market's odds at that moment are stored next to them. `data/forecasts.json` is committed on every run, so its git history shows that no forecast changes after the fact.
- **Versions.** Every archived forecast carries the engine version, a hash of the settings and the snapshot it was made from.

## Not done, and why

- **Machine-learning challenger (gradient boosting on shots, rest days, …).** The free sources carry no shots, line-ups or rest data beyond what Dixon-Coles and Elo already use; a model on the same inputs has little to add and much to overfit.
- **Closing odds / closing-line value.** No free source of historical closing odds is reachable from here (football-data.co.uk fails the TLS handshake). The archive now stores the market's odds next to every forecast, so a model-versus-market record builds up from here on.
- **Dynamic (state-space) team strengths.** The time decay already lets ratings drift; a state-space model is a larger change that would need its own round of tests.

## Season projections (added after v6)

The page now plays the rest of each league season 10,000 times (`simSetup` / `simRun` in `engine.js`): every remaining match is drawn from MatchLab's own forecast, the 1X2 first and then a score from its grid, so the projection agrees with the match numbers. Ties on points go to goal difference, then goals scored; head-to-head rules are not modelled.

A projection made from fixed ratings is overconfident: over a season teams change, and today's ratings are only estimates. So in each simulated season every team's strength takes a random walk on the log-odds scale of the 1X2, a starting offset (sd *base*) plus drift (sd *drift* per √100 days). This adds no match forecast of its own and is not in `CFG`.

**Test** (`node model-lab/sim_test.mjs`): every four weeks of a season, from week 5 to the end, the model is fitted on the matches before that day only (three seasons, Elo carried from 2018 as the collector does, Understat xG where `data/latest.json` has it), the rest of the season is simulated 2,000 times and the final table scored: the ranked probability score over final positions (main), the log-loss of each team's actual position, and Brier scores for champion, top places and relegation. 20 settings (base 0–0.3 × drift 0–0.4) were tried on 2024/25; the best was then run untouched on 2025/26. 72 league-checkpoints per season. Differences are paired against no uncertainty and averaged per league first (checkpoints of one league are correlated), ±2 standard errors over the eight leagues.

| base | drift | 2024/25 RPS (Δ) | 2025/26 RPS (Δ) | 2024/25 / 2025/26 position log-loss |
|---|---|---|---|---|
| 0 | 0 | 0.06437 | 0.07047 | 1.9281 / 1.9659 |
| 0 | 0.2 | −0.00044 ± 0.00040 | −0.00023 ± 0.00051 | 1.9187 / 1.9657 |
| 0.1 | 0.2 | −0.00046 ± 0.00049 | −0.00043 ± 0.00072 | 1.9147 / 1.9566 |
| **0.1** | **0.3** | **−0.00055 ± 0.00072** (best) | **−0.00053 ± 0.00114** | 1.9179 / 1.9602 |
| 0.2 | 0.2 | −0.00053 ± 0.00068 | −0.00059 ± 0.00110 | 1.9169 / 1.9590 |
| 0.3 | 0.4 | +0.00015 ± 0.00122 | −0.00010 ± 0.00224 | 1.9409 / 1.9826 |

**Decision: base 0.1, drift 0.3** — the best on 2024/25, and better than no uncertainty on 2025/26 as well, but within noise in both seasons; the surface is flat between 0.1–0.2 base and 0.2–0.3 drift. Two seasons of eight leagues are few independent outcomes, so this mainly guards against overconfident extremes (a "99 %" title that is really 90 %) rather than proving a gain. Too much uncertainty (base 0.3, drift 0.4) is worse than none on position log-loss in both seasons.
