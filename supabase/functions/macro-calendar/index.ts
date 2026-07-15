import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const RELEASE_DEFS = [
  { key: "gdp",   display: "GDP (Real, Advance)",          source: "BEA",   group: "Regime",    cadence: "quarterly", lagDays: 28 },
  { key: "cpi",   display: "CPI Inflation",                 source: "BLS",   group: "Inflation", cadence: "monthly",   lagDays: 14 },
  { key: "ppi",   display: "PPI",                           source: "BLS",   group: "Inflation", cadence: "monthly",   lagDays: 13 },
  { key: "sloos", display: "Sr Loan Officer Survey",        source: "Fed",   group: "Growth",    cadence: "quarterly", lagDays: 14 },
  { key: "lei",   display: "Conference Board LEI",          source: "CB",    group: "Growth",    cadence: "monthly",   lagDays: 21 },
  { key: "mich",  display: "UMich Inflation Expectations",  source: "UMich", group: "Inflation", cadence: "monthly",   lagDays: 14 },
  { key: "m2",    display: "M2 Money Supply",               source: "Fed",   group: "Inflation", cadence: "monthly",   lagDays: 25 },
  { key: "ci",    display: "C&I Loan Growth",               source: "Fed",   group: "Growth",    cadence: "monthly",   lagDays: 14 },
] as const;

const FOMC_DATES = [
  "2026-01-28", "2026-03-18", "2026-05-06", "2026-06-17",
  "2026-07-29", "2026-09-16", "2026-10-28", "2026-12-09",
  // 2027 placeholder dates — update annually
  "2027-01-27", "2027-03-17", "2027-05-05", "2027-06-16",
  "2027-07-28", "2027-09-15", "2027-10-27", "2027-12-08",
];

function eom(y: number, m: number): Date {
  return new Date(Date.UTC(y, m + 1, 0));
}
function eoq(d: Date): Date {
  const qm = Math.floor(d.getUTCMonth() / 3) * 3 + 2;
  return new Date(Date.UTC(d.getUTCFullYear(), qm + 1, 0));
}
function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}
function fmtMon(d: Date): string {
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}
function fmtQ(d: Date): string {
  return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
}

// Format a Date as iCal date string: YYYYMMDD
function icalDate(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

// Escape iCal text values
function esc(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

interface CalEvent {
  uid: string;
  dtstart: Date;
  summary: string;
  description: string;
}

function buildEvents(windowDays = 365): CalEvent[] {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const cutoff = addDays(today, windowDays);
  const events: CalEvent[] = [];

  for (const def of RELEASE_DEFS) {
    let periodEnd = def.cadence === "monthly"
      ? eom(today.getUTCFullYear(), today.getUTCMonth())
      : eoq(today);

    for (let iter = 0; iter < 15; iter++) {
      const releaseDate = addDays(periodEnd, def.lagDays);
      if (releaseDate > cutoff) break;
      if (releaseDate >= today) {
        const period = def.cadence === "monthly" ? fmtMon(periodEnd) : fmtQ(periodEnd);
        events.push({
          uid: `${def.key}-${periodEnd.toISOString().slice(0, 10)}@ratiobo.com`,
          dtstart: releaseDate,
          summary: `${def.display} (${period})`,
          description: `Source: ${def.source} · ${def.group}`,
        });
      }
      // Advance to next period
      if (def.cadence === "monthly") {
        const nm = periodEnd.getUTCMonth() === 11 ? 0 : periodEnd.getUTCMonth() + 1;
        const ny = periodEnd.getUTCMonth() === 11 ? periodEnd.getUTCFullYear() + 1 : periodEnd.getUTCFullYear();
        periodEnd = eom(ny, nm);
      } else {
        periodEnd = eoq(new Date(periodEnd.getTime() + 86400000));
      }
    }
  }

  for (const ds of FOMC_DATES) {
    const date = new Date(ds + "T12:00:00Z");
    if (date >= today && date <= cutoff) {
      events.push({
        uid: `fomc-${ds}@ratiobo.com`,
        dtstart: date,
        summary: "FOMC Rate Decision",
        description: "Source: Federal Reserve · Monetary Policy",
      });
    }
  }

  return events.sort((a, b) => a.dtstart.getTime() - b.dtstart.getTime());
}

function renderIcal(events: CalEvent[]): string {
  const now = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//RatioBo//Macro Economic Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "X-WR-CALNAME:Macro Economic Releases",
    "X-WR-CALDESC:Economic data release schedule — GDP\\, CPI\\, PPI\\, FOMC and more",
    "X-WR-TIMEZONE:UTC",
    "REFRESH-INTERVAL;VALUE=DURATION:P1D",
    "X-PUBLISHED-TTL:P1D",
  ];

  for (const ev of events) {
    const dtstart = icalDate(ev.dtstart);
    const dtend   = icalDate(addDays(ev.dtstart, 1)); // all-day: end = next day
    lines.push(
      "BEGIN:VEVENT",
      `UID:${ev.uid}`,
      `DTSTAMP:${now}`,
      `DTSTART;VALUE=DATE:${dtstart}`,
      `DTEND;VALUE=DATE:${dtend}`,
      `SUMMARY:${esc(ev.summary)}`,
      `DESCRIPTION:${esc(ev.description)}`,
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }

  lines.push("END:VCALENDAR");
  // iCal spec: lines must be ≤75 octets, folded with CRLF + SPACE
  return lines.map(fold).join("\r\n") + "\r\n";
}

// RFC 5545 line folding: split at 75 chars, continuation lines start with a space
function fold(line: string): string {
  if (line.length <= 75) return line;
  let out = "";
  let pos = 0;
  while (pos < line.length) {
    const chunk = line.slice(pos, pos + (pos === 0 ? 75 : 74));
    out += (pos === 0 ? "" : "\r\n ") + chunk;
    pos += chunk.length;
  }
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const events = buildEvents(365);
  const ical   = renderIcal(events);

  return new Response(ical, {
    headers: {
      ...CORS,
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'attachment; filename="macro-releases.ics"',
      "Cache-Control": "public, max-age=3600",
    },
  });
});
