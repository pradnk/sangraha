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
import { connectionProfile, looksPooled } from '../client';

const ENV_KEYS = [
  'VERCEL',
  'AWS_LAMBDA_FUNCTION_NAME',
  'DATABASE_POOL_MAX',
  'DATABASE_POOLED',
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
