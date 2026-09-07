/**
 * Reading a database connection out of whatever names the host chose.
 *
 * Every managed provider invents its own variable names, and moving between
 * two of them is where a working deployment stops with `DATABASE_URL is not
 * set` while the connection details sit in the environment under other names.
 * Supabase's Vercel integration injects a `POSTGRES_*` set and no
 * `DATABASE_URL` at all.
 *
 * The mapping is pure string work, so it is tested as string work — and it has
 * to be, because every mistake it can make is one that produces a connection
 * that opens successfully and is wrong.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applicationUrl, poolerTenant, resolveDatabaseEnv } from '../../../../load-env.mjs';

/** Exactly what Supabase's Vercel integration sets, minus the unrelated keys. */
const supabaseEnv = () => ({
  DATABASE_ENV_QUIET: '1',
  POSTGRES_URL:
    'postgres://postgres.abcdefghijkl:0wn3r@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?sslmode=require&supa=base-pooler.x',
  POSTGRES_URL_NON_POOLING:
    'postgres://postgres:0wn3r@db.abcdefghijkl.supabase.co:5432/postgres?sslmode=require',
  POSTGRES_PRISMA_URL:
    'postgres://postgres.abcdefghijkl:0wn3r@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1',
  POSTGRES_USER: 'postgres',
  POSTGRES_PASSWORD: '0wn3r',
  POSTGRES_HOST: 'db.abcdefghijkl.supabase.co',
  POSTGRES_DATABASE: 'postgres',
});

describe('resolving the owner connection', () => {
  it('takes Supabase\'s pooled URL when DATABASE_URL is absent', () => {
    const env: Record<string, string | undefined> = supabaseEnv();
    resolveDatabaseEnv(env);

    expect(env.DATABASE_URL).toContain('aws-0-ap-south-1.pooler.supabase.com:6543');
  });

  it('prefers the pooler over the direct host, which Vercel cannot reach', () => {
    /*
     * Supabase's direct host resolves to IPv6 only unless the IPv4 add-on is
     * enabled, and a Vercel function has no IPv6 egress. Preferring it would
     * read as the more "correct" choice — an unpooled connection to the real
     * database — and would fail to open at all in the one place this runs.
     */
    const env: Record<string, string | undefined> = supabaseEnv();
    resolveDatabaseEnv(env);

    expect(env.DATABASE_URL).not.toContain('db.abcdefghijkl.supabase.co');
  });

  it('leaves an explicit DATABASE_URL alone', () => {
    const env: Record<string, string | undefined> = {
      ...supabaseEnv(),
      DATABASE_URL: 'postgres://someone:else@elsewhere.example:5432/mis',
    };
    resolveDatabaseEnv(env);

    expect(env.DATABASE_URL).toBe('postgres://someone:else@elsewhere.example:5432/mis');
  });

  it('assembles one from the parts when no URL was given', () => {
    const env: Record<string, string | undefined> = {
      DATABASE_ENV_QUIET: '1',
      POSTGRES_USER: 'postgres',
      POSTGRES_PASSWORD: 'p@ss word',
      POSTGRES_HOST: 'db.abcdefghijkl.supabase.co:5432',
      POSTGRES_DATABASE: 'postgres',
    };
    resolveDatabaseEnv(env);

    const url = new URL(env.DATABASE_URL!);
    expect(decodeURIComponent(url.password)).toBe('p@ss word');
    expect(url.host).toBe('db.abcdefghijkl.supabase.co:5432');
  });

  it('does nothing at all when there is nothing to resolve', () => {
    const env: Record<string, string | undefined> = { DATABASE_ENV_QUIET: '1' };
    expect(resolveDatabaseEnv(env)).toEqual([]);
    expect(env.DATABASE_URL).toBeUndefined();
  });
});

describe('query parameters the driver would forward to the server', () => {
  /*
   * postgres.js sends every query parameter it does not recognise itself to
   * Postgres as a startup parameter, and Postgres answers an unknown one with
   * `FATAL: unrecognized configuration parameter`. So a string copied verbatim
   * from a provider dashboard does not connect, and the error names the
   * parameter rather than the provider that added it.
   */
  it('drops the markers other tools left behind, and keeps sslmode', () => {
    const env: Record<string, string | undefined> = supabaseEnv();
    resolveDatabaseEnv(env);

    expect(env.DATABASE_URL).not.toContain('supa=');
    expect(env.DATABASE_URL).toContain('sslmode=require');
  });

  it('cleans a DATABASE_URL that was pasted in by hand', () => {
    const env: Record<string, string | undefined> = {
      DATABASE_ENV_QUIET: '1',
      DATABASE_URL:
        'postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres?pgbouncer=true&connection_limit=1',
    };
    resolveDatabaseEnv(env);

    expect(env.DATABASE_URL).toBe(
      'postgres://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
    );
  });

  it('leaves a string with nothing to strip byte-identical', () => {
    // No stray trailing '?', which would be a gratuitous difference in
    // something people compare by eye against a dashboard.
    const env: Record<string, string | undefined> = {
      DATABASE_ENV_QUIET: '1',
      DATABASE_URL: 'postgres://mis:pw@localhost:5432/mis',
    };
    resolveDatabaseEnv(env);

    expect(env.DATABASE_URL).toBe('postgres://mis:pw@localhost:5432/mis');
  });
});

describe('the project reference in a pooler username', () => {
  it('is found on Supabase\'s shared pooler', () => {
    expect(
      poolerTenant('postgres://postgres.abcdefghijkl:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres'),
    ).toBe('abcdefghijkl');
  });

  it('is absent everywhere else, including a username that merely has a dot', () => {
    // A role legitimately called `first.last` on any other host must not have
    // half its name taken for a tenant.
    expect(poolerTenant('postgres://first.last:p@db.example:5432/mis')).toBeNull();
    expect(poolerTenant('postgres://postgres:p@db.abcdefghijkl.supabase.co:5432/postgres')).toBeNull();
  });
});

describe('deriving the application connection', () => {
  it('keeps the tenant suffix, which is what a hand-written URL leaves off', () => {
    const env: Record<string, string | undefined> = {
      ...supabaseEnv(),
      DATABASE_APP_PASSWORD: 'app-secret',
    };
    resolveDatabaseEnv(env);

    const url = new URL(env.DATABASE_APP_URL!);
    expect(decodeURIComponent(url.username)).toBe('mis_app.abcdefghijkl');
    expect(decodeURIComponent(url.password)).toBe('app-secret');
    expect(url.host).toBe('aws-0-ap-south-1.pooler.supabase.com:6543');
  });

  it('never falls back to the owner\'s password', () => {
    /*
     * The one failure this whole two-role arrangement exists to prevent.
     * Serving requests as the owner bypasses RLS, so every organisation would
     * read every other organisation's records — and nothing would look wrong,
     * because the connection works perfectly.
     */
    const env: Record<string, string | undefined> = supabaseEnv();
    resolveDatabaseEnv(env);

    expect(env.DATABASE_APP_URL).toBeUndefined();
  });

  it('honours DATABASE_APP_ROLE', () => {
    const env: Record<string, string | undefined> = {
      ...supabaseEnv(),
      DATABASE_APP_PASSWORD: 'app-secret',
      DATABASE_APP_ROLE: 'sangraha_web',
    };
    resolveDatabaseEnv(env);

    expect(decodeURIComponent(new URL(env.DATABASE_APP_URL!).username)).toBe(
      'sangraha_web.abcdefghijkl',
    );
  });

  it('adds no suffix off the pooler', () => {
    expect(applicationUrl('postgres://postgres:pw@db.example:5432/mis', 'mis_app', 's')).toBe(
      'postgres://mis_app:s@db.example:5432/mis',
    );
  });

  it('encodes a password that would otherwise break the URL', () => {
    const derived = applicationUrl('postgres://postgres:pw@db.example:5432/mis', 'mis_app', 'a@b:c/d');
    expect(decodeURIComponent(new URL(derived!).password)).toBe('a@b:c/d');
    // The password's ':' and '/' must not be read as a port or a path.
    expect(new URL(derived!).host).toBe('db.example:5432');
    expect(new URL(derived!).pathname).toBe('/mis');
  });
});

describe('where the resolution has to happen', () => {
  it('runs when a connection is opened, not only when loadRootEnv is called', () => {
    /*
     * The gap this closes. `loadRootEnv()` is called by next.config.ts, which
     * runs at build time — and a built serverless function never sees that
     * process's environment. So on a host injecting `POSTGRES_URL` and no
     * `DATABASE_URL`, the build would succeed, migrations would run against a
     * perfectly good database, and the deployed app would then throw
     * `DATABASE_URL is not set` on its first request. A deploy that goes green
     * and a site that is down.
     *
     * Asserted against the source because the alternative is a test that
     * imports the module for its side effect, which proves nothing about when
     * the side effect happens.
     */
    const source = readFileSync(join(import.meta.dirname, '..', 'client.ts'), 'utf8');

    const call = source.indexOf('\nresolveDatabaseEnv();');
    const firstConnection = source.indexOf('export function getDb');

    expect(call, 'client.ts should resolve the names at module scope').toBeGreaterThan(-1);
    expect(call).toBeLessThan(firstConnection);
  });
});
