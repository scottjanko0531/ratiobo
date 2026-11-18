import { describe, it, expect, vi } from "vitest";
import { fetchAllPages } from "../supabase/functions/_shared/fiscalDataPagination.ts";

// v3 Phase 1a (debt-metrics-integrity-v3 spec). The old ingest made one
// page[size]=10000 request with no pagination at all -- today's
// unfiltered total-count on this exact endpoint is already 11149 and
// climbing (confirmed live, v3 Phase 0). This proves the replacement
// walks every page a real multi-page response reports, with a mocked
// fetch (no live network needed for the test itself).
describe("fetchAllPages", () => {
  it("a mocked 2-page response yields rows from both pages", async () => {
    const page1 = {
      data: [{ id: 1 }, { id: 2 }],
      meta: { "total-count": 4, "total-pages": 2 },
    };
    const page2 = {
      data: [{ id: 3 }, { id: 4 }],
      meta: { "total-count": 4, "total-pages": 2 },
    };
    const fetchMock = vi.fn(async (url: string) => {
      const isPage1 = url.includes("page%5Bnumber%5D=1");
      return new Response(JSON.stringify(isPage1 ? page1 : page2), { status: 200 });
    });

    const result = await fetchAllPages<{ id: number }>("https://example.com/api?filter=x", 2, fetchMock as unknown as typeof fetch);

    expect(result.rows).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }]);
    expect(result.pagesFetched).toBe(2);
    expect(result.totalCount).toBe(4);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("a single-page response (total-pages: 1) makes exactly one request", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: 1 }], meta: { "total-count": 1, "total-pages": 1 } }), { status: 200 })
    );
    const result = await fetchAllPages<{ id: number }>("https://example.com/api", 1000, fetchMock as unknown as typeof fetch);
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops on an empty page even if total-pages claims more (defensive backstop)", async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response(JSON.stringify({ data: [{ id: 1 }], meta: { "total-pages": 5 } }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [], meta: { "total-pages": 5 } }), { status: 200 });
    });
    const result = await fetchAllPages<{ id: number }>("https://example.com/api", 1, fetchMock as unknown as typeof fetch);
    expect(result.rows).toEqual([{ id: 1 }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws on a non-OK HTTP response rather than silently returning partial data", async () => {
    const fetchMock = vi.fn(async () => new Response("", { status: 500 }));
    await expect(fetchAllPages("https://example.com/api", 10, fetchMock as unknown as typeof fetch)).rejects.toThrow(/HTTP 500/);
  });
});
