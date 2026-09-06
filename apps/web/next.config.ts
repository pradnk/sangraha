import type { NextConfig } from 'next';
import { loadRootEnv } from '../../load-env.mjs';

// Next only reads a `.env` beside its own package.json; this project keeps one
// at the repo root so the packages, scripts and tests share it. Must run before
// the config object is built.
loadRootEnv();

const config: NextConfig = {
  reactStrictMode: true,
  /*
   * Anything that is not *the* dev server writes somewhere else.
   *
   * Every Next process shares `.next` by default, so a second one corrupts the
   * first's chunks. Two ways to hit it, both of which have:
   *
   *   `next build` while a dev server runs — every route throws
   *   MODULE_NOT_FOUND. `npm run build` sets NEXT_DIST_DIR to avoid it.
   *
   *   a second `next dev` on another port — subtler and nastier. The browser
   *   gets server HTML from one process and client chunks from the other, so
   *   hydration fails silently and the page renders but nothing is clickable.
   *   Buttons look fine and do nothing. `npm run dev:alt` avoids it.
   *
   * Both look exactly like a code bug and are not one. It has cost time three
   * times now, which is why this comment is longer than the line it explains.
   */
  distDir: process.env.NEXT_DIST_DIR || '.next',
  // Workspace packages are shipped as TypeScript source, so Next compiles them
  // itself. No build step to forget, no stale dist to debug.
  transpilePackages: ['@sangraha/db', '@sangraha/form-engine'],
  // Native and driver packages must stay external rather than being bundled
  // into the server build — @node-rs/argon2 ships a platform-specific binary.
  serverExternalPackages: ['postgres', '@node-rs/argon2'],
  experimental: {
    /*
     * Stated rather than left to the default 1 MB.
     *
     * Logos are resized in the browser to about 200 KB before they are sent, so
     * this is headroom, not a target — it exists so an unusually large but
     * legitimate upload does not get rejected by the framework before our own
     * validation can give a useful answer. Kept modest on purpose: a large limit
     * is an easy way to exhaust server memory.
     */
    serverActions: { bodySizeLimit: '2mb' },
  },
};

export default config;
