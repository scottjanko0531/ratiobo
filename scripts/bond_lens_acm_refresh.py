#!/usr/bin/env python3
"""
Bond Lens overlay -- weekly ACM term premium refresh (bond-lens-decisions.md,
2026-10-02 follow-up).

Why this lives here and not in bond-lens-ingest (Supabase edge function):
the ACM .xls decode alone costs ~363MB of heap in the xlsx (JS) library,
well past the edge function's memory budget, confirmed empirically and
independent of sheet/row filtering. pandas + xlrd handle the same file
fine in a GitHub Actions runner, which has far more memory to spare.

Scope: ACM only. FRED, HLW r-star and GDPNow keep their daily edge-function
cron jobs (bond-lens-ingest) -- this script does not touch those.
"""
import io
import os
import sys
from datetime import datetime, timezone

import pandas as pd
import requests

ACM_URL = "https://www.newyorkfed.org/medialibrary/media/research/data_indicators/ACMTermPremium.xls"
SUPABASE_URL = "https://xuutmtfrpaxrzhwwokpk.supabase.co"
CHUNK_SIZE = 1000


def fetch_acm_rows():
    resp = requests.get(
        ACM_URL,
        headers={"User-Agent": "Mozilla/5.0 (compatible; ratiobo-bond-lens-gha/1.0)"},
        timeout=60,
    )
    resp.raise_for_status()
    df = pd.read_excel(io.BytesIO(resp.content), sheet_name="ACM Daily", engine="xlrd")
    if "DATE" not in df.columns or "ACMTP10" not in df.columns:
        raise ValueError(f"expected columns DATE/ACMTP10 not found, got: {list(df.columns)}")
    df = df[["DATE", "ACMTP10"]].dropna()
    df["DATE"] = pd.to_datetime(df["DATE"]).dt.strftime("%Y-%m-%d")
    return [
        {"series_id": "ACMTP10", "obs_date": d, "value": float(v), "source": "nyfed_acm"}
        for d, v in zip(df["DATE"], df["ACMTP10"])
    ]


def upsert_rows(rows, service_key):
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    url = f"{SUPABASE_URL}/rest/v1/bond_raw_series?on_conflict=series_id,obs_date"
    for i in range(0, len(rows), CHUNK_SIZE):
        chunk = rows[i : i + CHUNK_SIZE]
        resp = requests.post(url, headers=headers, json=chunk, timeout=60)
        if not resp.ok:
            raise RuntimeError(f"bond_raw_series upsert failed (rows {i}-{i + len(chunk)}): {resp.status_code} {resp.text}")


def log_job_run(service_key, started_at, status, detail):
    headers = {
        "apikey": service_key,
        "Authorization": f"Bearer {service_key}",
        "Content-Type": "application/json",
    }
    payload = {
        "job_name": "bond-lens-acm-refresh-github-actions",
        "started_at": started_at,
        "finished_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "detail": detail,
    }
    resp = requests.post(f"{SUPABASE_URL}/rest/v1/bond_lens_job_runs", headers=headers, json=payload, timeout=30)
    if not resp.ok:
        print(f"warning: failed to log job run: {resp.status_code} {resp.text}", file=sys.stderr)


def main():
    service_key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not service_key:
        print("SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr)
        sys.exit(1)

    started_at = datetime.now(timezone.utc).isoformat()
    try:
        rows = fetch_acm_rows()
        upsert_rows(rows, service_key)
        detail = {
            "totalRows": len(rows),
            "from": rows[0]["obs_date"] if rows else None,
            "to": max(r["obs_date"] for r in rows) if rows else None,
        }
        log_job_run(service_key, started_at, "ok", detail)
        print(f"ACM refresh ok: {detail}")
    except Exception as e:
        log_job_run(service_key, started_at, "error", {"error": str(e)})
        print(f"ACM refresh failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
