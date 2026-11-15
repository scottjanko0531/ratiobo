import { readFileSync } from "node:fs";

// Minimal .env.local parser -- no dotenv dependency. KEY=VALUE per line,
// ignores blank lines and lines starting with #. Does not support quoting
// or multi-line values; .env.local in this repo doesn't use either.
export function loadEnvLocal(path = ".env.local") {
  const text = readFileSync(path, "utf8");
  const env = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    env[key] = value;
  }
  return env;
}

export function requireEnv(env, keys) {
  const missing = keys.filter((k) => !env[k]);
  if (missing.length > 0) {
    throw new Error(`missing required .env.local keys: ${missing.join(", ")}`);
  }
}
