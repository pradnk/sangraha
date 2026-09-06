import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(fileURLToPath(import.meta.url));

/**
 * Loads the repo-root `.env` into `process.env`.
 *
 * One env file for the whole monorepo. Next.js only reads a `.env` beside its
 * own package.json, and vitest reads none at all, so both call this instead of
 * each keeping a copy of the same secrets.
 *
 * Existing variables always win. In production — Docker, Fly, Vercel — the
 * environment is the source of truth and there is no file; this must never
 * clobber it.
 */
export function loadRootEnv() {
  try {
    const contents = readFileSync(join(repoRoot, '.env'), 'utf8');
    for (const line of contents.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;
      const key = trimmed.slice(0, separator).trim();
      if (key in process.env) continue;
      process.env[key] = trimmed.slice(separator + 1).trim();
    }
  } catch {
    // No .env is expected in production and fine in CI.
  }
}
