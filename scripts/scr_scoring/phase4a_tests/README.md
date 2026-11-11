# Phase 4a Test Battery — Analysis Code (trials 6-13)

Each file corresponds to one pre-registered trial in `scr_trials` (ids 6-13, see
`description`/`parameters` columns for the exact pre-registration text) and writes its
output directly into `scr_results` keyed by `trial_id`.

## Provenance note (tests 1-5, trial_ids 6, 8, 9, 10)

The original queries for Test 1 (Information Coefficients, trial 6), Test 3 (Rule
Breaker, trial 8), Test 4 (Sign-level Contribution, trial 9), and Test 5 (Big Winners,
trial 10) were run interactively against the `scr_results`/`scr_trials` tables in an
earlier part of this working session. That session was summarized by the harness
before the raw SQL text was saved to a file or committed, so the literal queries could
not be recovered byte-for-byte.

The files `test1_information_coefficients.sql`, `test3_rule_breaker.sql`,
`test4_sign_contribution.sql`, and `test5_big_winners.sql` in this directory are
**post-hoc reconstructions** written directly from each trial's pre-registered
methodology text (stored verbatim in `scr_trials.description`/`parameters`), not the
original executed queries. They were spot-checked against the already-stored
`scr_results` rows (produced by the original, now-unrecoverable queries) for at least
one (profile_version, period, horizon) cell per test and found consistent with the
pre-registered methodology and stored numbers; they were **not** re-run end-to-end to
regenerate `scr_results`, so running them would be redundant with (and should reproduce,
modulo tie-handling detail in rank-based correlations) the rows already in the table.
This gap is disclosed here and in the final markdown report rather than silently
patched over.

Test 2 (Quintile Portfolios, trial 7) referenced here only as an input to Tests 6-8;
its own analysis code has the same provenance gap as above — not included in this
directory for the same reason.

Tests 6 (Fama-French Factor Check, trial 11), 7 (Regime Split, trial 12), and 8
(A-Fool Comparison, trial 13) were run directly in this session; their files are the
literal, unmodified queries executed (Python regression step for tests 6/7 included
alongside the SQL that produced their input series).
