// Reads one company's facts out of SEC's companyfacts.zip bulk file
// (https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip)
// without extracting the whole archive -- `unzip -p` seeks via the zip's
// central directory, so pulling one ~20547th of a 1.3GB archive is fast
// regardless of archive size. Returns null if the CIK isn't in the
// archive (no XBRL facts filed, e.g. a non-reporting entity).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { padCik } from "./sec.mjs";

const execFileAsync = promisify(execFile);

export async function loadCompanyFacts(zipPath, cik) {
  const entryName = `CIK${padCik(cik)}.json`;
  try {
    const { stdout } = await execFileAsync("unzip", ["-p", zipPath, entryName], { maxBuffer: 1024 * 1024 * 200 });
    return JSON.parse(stdout);
  } catch (e) {
    // unzip exits non-zero (11) when the entry isn't found in the archive
    if (String(e.message ?? e).includes("warning") || e.code === 11) return null;
    throw e;
  }
}
