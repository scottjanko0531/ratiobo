// v3 Phase 1a (debt-metrics-integrity-v3 spec). Generic Treasury Fiscal
// Data API pagination -- walks `meta.total-pages`, not a single
// page[size]=10000 request. The v3 Phase 0 investigation found this
// specific endpoint's unfiltered total-count is already 11149 (and
// growing by ~700/year), so a single hardcoded page cap is a real latent
// bug even though it isn't the active cause of today's specific
// staleness (that's just the API itself having nothing newer than
// 2026-10-22 right now -- see the decisions log). Fixing the pagination
// properly now rather than leaving a ticking time bomb.
//
// Lives in its own Deno-API-free module (not inside
// ingest-auction-results/index.ts, which has module-scope
// Deno.env.get(...)! calls) so the pagination walk itself is directly
// unit-testable under Vitest with a mocked global.fetch -- same split
// rationale as every other _shared/ module in this spec.

export interface FiscalDataPage<T> {
  data: T[];
  meta: { "total-count"?: number; "total-pages"?: number };
}

export interface PaginatedFetchResult<T> {
  rows: T[];
  pagesFetched: number;
  totalCount: number | null;
}

// Fetches every page of `baseUrl` (a full querystring-ready URL missing
// only the page[number]/page[size] params, which this function appends
// itself), stopping once page[number] reaches meta["total-pages"] (or the
// API returns an empty page, as a defensive backstop against a
// mismatched/stale total-pages value). `pageSize` defaults to 1000, well
// above what any single tenor/date-window query in this codebase
// currently needs, but still paginates correctly past it rather than
// silently truncating the way the old single-request design did.
export async function fetchAllPages<T>(
  baseUrl: string,
  pageSize = 1000,
  fetchImpl: typeof fetch = fetch,
): Promise<PaginatedFetchResult<T>> {
  const rows: T[] = [];
  let pageNumber = 1;
  let totalPages = 1;
  let totalCount: number | null = null;

  while (pageNumber <= totalPages) {
    const sep = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${sep}page%5Bnumber%5D=${pageNumber}&page%5Bsize%5D=${pageSize}`;
    const res = await fetchImpl(url);
    if (!res.ok) throw new Error(`fiscalDataPagination: HTTP ${res.status} on page ${pageNumber}`);
    const j = (await res.json()) as FiscalDataPage<T>;
    const pageRows = j.data ?? [];
    if (pageRows.length === 0) break; // defensive: stop even if total-pages disagrees
    rows.push(...pageRows);
    totalPages = j.meta?.["total-pages"] ?? 1;
    totalCount = j.meta?.["total-count"] ?? totalCount;
    pageNumber++;
  }

  return { rows, pagesFetched: pageNumber - 1, totalCount };
}
