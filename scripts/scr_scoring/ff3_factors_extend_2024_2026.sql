-- Extends ff3_factors (previously 2017-01..2023-12 only, 84 rows -- never
-- kept current, same "built once, never scheduled" shape as the QQQ/IWM/BIL
-- asset_price_history gap found during Phase 4c) through 2026-09, so the
-- exploratory value+momentum test's Carhart 4-factor (Mkt-RF/SMB/HML/UMD)
-- regression has real coverage for the full 2017-2026 period and the
-- 2024-26 sub-period.
--
-- Source: Ken French's Data Library, same series as the original load --
-- confirmed by exact match against stored 2017-01 and 2023-12 rows (CSV
-- percent values / 100 = stored decimals, to the hundredths place):
--   F-F_Research_Data_Factors_CSV.zip  (Mkt-RF, SMB, HML, RF)
--   F-F_Momentum_Factor_CSV.zip        (UMD)
-- Both files' monthly section (pre-annual-summary) runs through 2026-09 as
-- of this extension (2026-11-14).
--
-- trailing12_mkt_rf is a derived column from some prior ad-hoc load whose
-- exact formula could not be reverse-engineered from existing rows (neither
-- a trailing-12 geometric compound nor a simple sum of mkt_rf reproduces the
-- stored values) and is used only by superseded Phase 4a round-1 scripts --
-- left NULL for the new rows, matching how it's NULL for the original
-- table's own first 11 rows (2017-01..2017-11) before 12 months existed.

insert into ff3_factors (month_start, mkt_rf, smb, hml, rf, umd, trailing12_mkt_rf) values
('2024-01-01',  0.0073, -0.0504, -0.0237,  0.0047,  0.0546, null),
('2024-02-01',  0.0507, -0.0026, -0.0343,  0.0042,  0.0501, null),
('2024-03-01',  0.0284, -0.0250,  0.0416,  0.0043, -0.0032, null),
('2024-04-01', -0.0465, -0.0238, -0.0045,  0.0047, -0.0043, null),
('2024-05-01',  0.0433,  0.0053, -0.0133,  0.0044,  0.0145, null),
('2024-06-01',  0.0280, -0.0300, -0.0336,  0.0041,  0.0086, null),
('2024-07-01',  0.0122,  0.0681,  0.0557,  0.0045, -0.0236, null),
('2024-08-01',  0.0160, -0.0349, -0.0113,  0.0048,  0.0486, null),
('2024-09-01',  0.0172, -0.0013, -0.0273,  0.0040, -0.0060, null),
('2024-10-01', -0.0100, -0.0095,  0.0091,  0.0039,  0.0298, null),
('2024-11-01',  0.0649,  0.0449,  0.0038,  0.0040,  0.0081, null),
('2024-12-01', -0.0317, -0.0270, -0.0297,  0.0037, -0.0030, null),
('2025-01-01',  0.0280, -0.0200,  0.0176,  0.0037,  0.0101, null),
('2025-02-01', -0.0244, -0.0577,  0.0484,  0.0033, -0.0086, null),
('2025-03-01', -0.0639, -0.0272,  0.0287,  0.0034, -0.0264, null),
('2025-04-01', -0.0084, -0.0057, -0.0329,  0.0035,  0.0501, null),
('2025-05-01',  0.0606,  0.0061, -0.0281,  0.0038,  0.0225, null),
('2025-06-01',  0.0486,  0.0071, -0.0143,  0.0034, -0.0265, null),
('2025-07-01',  0.0198,  0.0030, -0.0134,  0.0034, -0.0094, null),
('2025-08-01',  0.0184,  0.0380,  0.0437,  0.0038, -0.0361, null),
('2025-09-01',  0.0339, -0.0183, -0.0105,  0.0033,  0.0462, null),
('2025-10-01',  0.0196, -0.0057, -0.0318,  0.0037,  0.0016, null),
('2025-11-01', -0.0013,  0.0040,  0.0376,  0.0030, -0.0172, null),
('2025-12-01', -0.0036, -0.0104,  0.0240,  0.0034, -0.0240, null),
('2026-01-01',  0.0103,  0.0218,  0.0380,  0.0030,  0.0503, null),
('2026-02-01', -0.0117,  0.0016,  0.0280,  0.0028,  0.0131, null),
('2026-03-01', -0.0518,  0.0044,  0.0329,  0.0029,  0.0156, null),
('2026-04-01',  0.0995,  0.0019, -0.0137,  0.0029,  0.0951, null),
('2026-05-01',  0.0491, -0.0159, -0.0231,  0.0031,  0.0139, null),
('2026-06-01', -0.0107,  0.0339,  0.0358,  0.0029,  0.0462, null),
('2026-07-01', -0.0061, -0.0192,  0.0211,  0.0033, -0.1221, null),
('2026-08-01',  0.0256,  0.0034, -0.0354,  0.0029, -0.0560, null),
('2026-09-01', -0.0107, -0.0316, -0.0155,  0.0031,  0.0670, null)
on conflict (month_start) do update set
  mkt_rf = excluded.mkt_rf, smb = excluded.smb, hml = excluded.hml,
  rf = excluded.rf, umd = excluded.umd;
