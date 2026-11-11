"""
TEST 6 v2 (trial_id=19): Carhart 4-factor regression with FULL loadings.

Reads the per-date (profile_version, period, as_of_date, spread_1m, mkt_rf,
smb, hml, umd) panel produced by v2_test6_ff3_momentum_factor_check.sql
(saved locally as spread_ff3_mom_data_v2.json after being pulled through the
DB tool's overflow-file mechanism -- never read into the orchestrating
agent's own context, same discipline as round 1).

For each (profile_version, period): OLS of spread_1m on
[const, mkt_rf, smb, hml, umd], HAC (Newey-West) covariance, maxlags=1, per
the test 6 pre-registration (scr_trials id=19). Reports FULL loadings
(alpha, beta_mkt, beta_smb, beta_hml, beta_umd with t-stats, plus R^2),
not just alpha/R^2, specifically so the committed report can assess
whether a_growth's 2022-23 validation reversal is explained by a negative
HML loading (value-outperforms-growth regime) or by beta_umd, rather than
being genuine sign-level alpha decay.

Output: prints one row per (profile_version, period) with every field
needed to build the scr_results INSERT statement, and writes them to
test6_v2_results.json for the insert-generation step.
"""
import json
import numpy as np
import pandas as pd
import statsmodels.api as sm

with open('spread_ff3_mom_data_v2.json') as f:
    arr = json.load(f)

df = pd.DataFrame(arr)
for c in ['spread_1m', 'mkt_rf', 'smb', 'hml', 'umd']:
    df[c] = pd.to_numeric(df[c], errors='coerce')

results = []
for prof in sorted(df.profile_version.unique()):
    for period in ['development', 'validation']:
        sub = df[(df.profile_version == prof) & (df.period == period)].sort_values('as_of_date')
        y = sub['spread_1m'].values
        X = sm.add_constant(sub[['mkt_rf', 'smb', 'hml', 'umd']].values)
        model = sm.OLS(y, X).fit(cov_type='HAC', cov_kwds={'maxlags': 1})
        alpha, b_mkt, b_smb, b_hml, b_umd = model.params
        t_alpha, t_mkt, t_smb, t_hml, t_umd = model.tvalues
        r2 = model.rsquared
        n = len(sub)
        row = (prof, period, alpha, t_alpha, b_mkt, t_mkt, b_smb, t_smb,
               b_hml, t_hml, b_umd, t_umd, r2, n)
        results.append(row)
        print(f"{prof:22s} {period:12s} n={n:3d} alpha={alpha:+.5f}(t={t_alpha:+.2f}) "
              f"b_mkt={b_mkt:+.3f}(t={t_mkt:+.2f}) b_smb={b_smb:+.3f}(t={t_smb:+.2f}) "
              f"b_hml={b_hml:+.3f}(t={t_hml:+.2f}) b_umd={b_umd:+.3f}(t={t_umd:+.2f}) R2={r2:.3f}")

with open('test6_v2_results.json', 'w') as f:
    json.dump(results, f)
