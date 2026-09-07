/**
 * How the process decides to talk to Postgres.
 *
 * These settings are invisible when they are wrong. A pool of ten is correct on
 * a long-lived server and catastrophic across thirty serverless instances, and
 * prepared statements work perfectly until a transaction pooler is put in front
 * — at which point they fail intermittently under load. Neither shows up in
 * ordinary testing, so the decision itself is what gets tested.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connectionProfile, looksPooled, unpooledConnection } from '../client';

const ENV_KEYS = [
  'VERCEL',
  'AWS_LAMBDA_FUNCTION_NAME',
  'DATABASE_POOL_MAX',
  'DATABASE_POOLED',
  'DATABASE_DIRECT_URL',
  'NODE_ENV',
];
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const DIRECT = 'postgres://user:pw@db.example.com:5432/app';

describe('detecting a pooled connection', () => {
  it('recognises the shapes the common providers use', () => {
    // Neon puts the pooler in the hostname; Supabase uses a separate port;
    // a hand-rolled PgBouncer usually gets the query parameter.
    expect(looksPooled('postgres://u:p@ep-x-123-pooler.aws.neon.tech/db')).toBe(true);
    expect(looksPooled('postgres://u:p@db.abc.supabase.co:6543/postgres')).toBe(true);
    expect(
      looksPooled('postgres://postgres.abc:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres'),
    ).toBe(true);
    // Session mode, on the same host. One backend for the connection's
    // lifetime, so prepared statements are fine and giving them up would be
    // pure loss.
    expect(
      looksPooled('postgres://postgres.abc:p@aws-0-ap-south-1.pooler.supabase.com:5432/postgres'),
    ).toBe(false);
    expect(looksPooled('postgres://u:p@host/db?pgbouncer=true')).toBe(true);
  });

  it('treats an ordinary connection as direct', () => {
    expect(looksPooled(DIRECT)).toBe(false);
    expect(looksPooled('postgres://u:p@ep-x-123.aws.neon.tech/db')).toBe(false);
  });

  it('can be told explicitly, for anything unusual', () => {
    process.env.DATABASE_POOLED = 'true';
    expect(looksPooled(DIRECT)).toBe(true);

    process.env.DATABASE_POOLED = 'false';
    expect(looksPooled('postgres://u:p@x-pooler.neon.tech/db')).toBe(false);
  });
});

describe('reaching the same database without the pooler', () => {
  /*
   * Needed for role DDL, which a managed provider may handle outside Postgres.
   * Neon refused `CREATE ROLE` on a pooled connection that had just applied
   * every schema migration without complaint, and said only
   * `XX000 ddl_forwarding.c SendDeltasToControlPlane`.
   */
  const NEON_POOLED = 'postgres://u:p@ep-cool-x-123-pooler.ap-southeast-1.aws.neon.tech/db';

  it("rewrites Neon's pooled host, which is the direct one plus a suffix", () => {
    expect(unpooledConnection(NEON_POOLED)).toBe(
      'postgres://u:p@ep-cool-x-123.ap-southeast-1.aws.neon.tech/db',
    );
  });

  it('has nothing to offer for a connection that is already direct', () => {
    expect(unpooledConnection(DIRECT)).toBeNull();
    expect(unpooledConnection('postgres://u:p@ep-x-123.aws.neon.tech/db')).toBeNull();
  });

  it('does not guess at a pooled shape it cannot rewrite', () => {
    // Supabase's own direct host is deliberately never the target: it resolves
    // to IPv6 only without the IPv4 add-on, and a Vercel function has no IPv6
    // egress, so rewriting to it would replace a working fallback with a
    // connection that cannot be opened. Session mode on the pooler host is
    // what "without the transaction pooler" means there.
    expect(
      unpooledConnection(
        'postgres://postgres.abc:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres',
      ),
    ).toBe('postgres://postgres.abc:p@aws-0-ap-south-1.pooler.supabase.com:5432/postgres');

    // Supabase moves the port and sometimes the username too. Guessing that
    // would produce a plausible URL pointing at nothing; the explicit variable
    // is the answer there.
    expect(unpooledConnection('postgres://u:p@db.abc.supabase.co:6543/postgres')).toBeNull();
    expect(unpooledConnection('postgres://u:p@host/db?pgbouncer=true')).toBeNull();
  });

  it('prefers an explicit DATABASE_DIRECT_URL over anything derived', () => {
    process.env.DATABASE_DIRECT_URL = 'postgres://u:p@direct.example.com:5432/app';
    expect(unpooledConnection(NEON_POOLED)).toBe('postgres://u:p@direct.example.com:5432/app');
  });

  it('reports nothing to retry when the direct URL is the one that just failed', () => {
    // Otherwise the retry is the same statement against the same host, and the
    // warning about falling back to a direct connection would be a lie.
    process.env.DATABASE_DIRECT_URL = DIRECT;
    expect(unpooledConnection(DIRECT)).toBeNull();
  });
});

describe('round trips per request', () => {
  /*
   * Every statement is a round trip, and a round trip costs whatever the
   * distance to the database costs.
   *
   * This shipped as three separate `set_config` awaits, which is invisible
   * against Postgres on localhost — 1ms became 3ms — and was three quarters of
   * a second against a database across an ocean, on every query that serves a
   * request. Measured against a real Postgres with `log_statement='all'`: six
   * statements before (begin, three set_config, the query, commit), four after.
   *
   * The distance is the larger half of that problem and is fixed in
   * `vercel.json` below, not here. This is the half that is in the code.
   */
  const clientSource = readFileSync(join(import.meta.dirname, '..', 'client.ts'), 'utf8');

  it('sets the whole RLS context in one statement, not one each', () => {
    const fn = clientSource.slice(clientSource.indexOf('export async function withContext'));
    const body = fn.slice(0, fn.indexOf('\n}') + 2);

    expect(body.match(/tx\.execute\(/g) ?? [], 'one execute, carrying all three').toHaveLength(1);
    for (const setting of ['app.org_id', 'app.user_id', 'app.role']) {
      expect(body, `${setting} still has to be set`).toContain(setting);
    }
  });

  it('states a function region, so it cannot default to the far side of the world', () => {
    /*
     * Vercel puts functions in Washington DC (`iad1`) unless told otherwise,
     * and a project whose database is in Singapore then pays ~240ms per round
     * trip — four of them per query, plus connection setup. It is not a value
     * this test can check for correctness; it can only insist the decision was
     * made, because the default is silent and wrong for every deployment whose
     * database is not on the US east coast.
     */
    const config = JSON.parse(
      readFileSync(join(import.meta.dirname, '..', '..', '..', '..', 'vercel.json'), 'utf8'),
    ) as { regions?: string[] };

    expect(config.regions, 'vercel.json should name the database\'s region').toBeInstanceOf(Array);
    expect(config.regions!.length).toBeGreaterThan(0);
  });
});

describe('the connection profile', () => {
  it('uses a real pool on a long-lived production server', () => {
    delete process.env.VERCEL;
    process.env.NODE_ENV = 'production';
    const profile = connectionProfile(DIRECT);

    expect(profile.max).toBe(10);
    // No pooler in the way, so prepared statements are pure win.
    expect(profile.prepare).toBe(true);
    // Holding connections open is correct here; reconnecting is pure cost.
    expect(profile.idleTimeout).toBe(0);
  });

  it('uses one connection per instance on serverless', () => {
    // The failure this prevents: max 10 across thirty warm instances is three
    // hundred connections against a database that permits a hundred.
    process.env.VERCEL = '1';
    expect(connectionProfile(DIRECT).max).toBe(1);
  });

  it('releases idle connections quickly on serverless', () => {
    process.env.VERCEL = '1';
    // A scaled-down instance must not still be holding a slot.
    expect(connectionProfile(DIRECT).idleTimeout).toBeGreaterThan(0);
  });

  it('disables prepared statements behind a transaction pooler', () => {
    // PgBouncer hands a different backend to each statement, so a prepared
    // statement is not there on the next one. Fails as "prepared statement does
    // not exist", intermittently, under load.
    expect(connectionProfile('postgres://u:p@x-pooler.neon.tech/db').prepare).toBe(false);
    expect(connectionProfile('postgres://u:p@x.supabase.co:6543/db').prepare).toBe(false);
  });

  it('keeps prepared statements on a direct connection even on serverless', () => {
    process.env.VERCEL = '1';
    expect(connectionProfile(DIRECT).prepare).toBe(true);
  });

  it('lets an operator override the pool size', () => {
    process.env.VERCEL = '1';
    process.env.DATABASE_POOL_MAX = '4';
    expect(connectionProfile(DIRECT).max).toBe(4);
  });

  it('keeps development well clear of Postgres\'s connection limit', () => {
    /*
     * Every Next process opens two of these — the app role and the owner role —
     * so ten each was twenty per dev server against a default limit of a
     * hundred. Two dev servers, a test run and a couple of scripts exhausted it,
     * and the symptom was "remaining connection slots are reserved for roles
     * with the SUPERUSER attribute" or an unexplained 500.
     */
    delete process.env.VERCEL;
    process.env.NODE_ENV = 'development';
    expect(connectionProfile(DIRECT).max).toBe(4);
  });

  it('ignores a nonsensical override rather than opening zero connections', () => {
    delete process.env.VERCEL;
    process.env.NODE_ENV = 'production';

    process.env.DATABASE_POOL_MAX = 'not-a-number';
    expect(connectionProfile(DIRECT).max).toBe(10);

    process.env.DATABASE_POOL_MAX = '0';
    expect(connectionProfile(DIRECT).max).toBe(10);
  });

  it('always sets a connect timeout, so a bad host fails rather than hangs', () => {
    expect(connectionProfile(DIRECT).connectTimeout).toBeGreaterThan(0);
  });
});
