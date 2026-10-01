-- Bond Lens overlay -- GDPNow current-quarter fix (bond-lens-decisions.md
-- 2026-10-02 follow-up). growth_mom (spec §4.2) needs to detect when an
-- 8-week lookback crosses a GDPNow quarter boundary (the nowcast resets
-- to a new target quarter, making a raw difference meaningless). Only
-- populated for GDPNOW_ATL_NOWCAST rows; every other series leaves this
-- null.
alter table bond_raw_series add column target_quarter text;
