/**
 * Who may create an organisation.
 *
 * Two failure modes pull in opposite directions, and both are bad:
 *
 *   Too open — a public Vercel URL where anyone who finds it can create tenants
 *   in an NGO's database.
 *
 *   Too closed — the person who just deployed cannot create their own first
 *   organisation, because there is no shell on Vercel to run `org:create` in,
 *   and they are locked out of their own installation.
 *
 * The resolution is that an empty database is the bootstrap case. These tests
 * pin both halves down.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const ENV_KEYS = ['SIGNUP_MODE', 'SIGNUP_CODE', 'NODE_ENV'] as const;
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

// The database is stubbed: what is under test is the policy, not the query.
let organisationCount = 0;
vi.mock('@sangraha/db', () => ({
  getOwnerDb: () => ({
    select: () => ({ from: async () => [{ total: organisationCount }] }),
  }),
  organisations: {},
}));

async function loadSignup() {
  vi.resetModules();
  return import('../../lib/signup');
}

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else (process.env as Record<string, string>)[key] = value;
  }
  organisationCount = 0;
});

describe('the default', () => {
  it('is closed in production', async () => {
    // The previous default was open everywhere, which made a public deployment
    // insecure unless its operator had read the right paragraph.
    (process.env as Record<string, string>).NODE_ENV = 'production';
    delete process.env.SIGNUP_MODE;
    delete process.env.SIGNUP_CODE;

    const { signupMode } = await loadSignup();
    expect(signupMode()).toBe('closed');
  });

  it('is open in development, so a fresh clone just works', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'development';
    delete process.env.SIGNUP_MODE;
    delete process.env.SIGNUP_CODE;

    const { signupMode } = await loadSignup();
    expect(signupMode()).toBe('open');
  });

  it('switches to code the moment a code is configured', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    delete process.env.SIGNUP_MODE;
    process.env.SIGNUP_CODE = 'shared-secret';

    const { signupMode } = await loadSignup();
    expect(signupMode()).toBe('code');
  });

  it('lets an explicit setting win over everything', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    process.env.SIGNUP_MODE = 'open';

    const { signupMode } = await loadSignup();
    expect(signupMode()).toBe('open');
  });
});

describe('bootstrapping a fresh deployment', () => {
  it('lets the first organisation be created even when closed', async () => {
    // Without this an NGO deploying to Vercel could not set itself up: there is
    // no shell to run `npm run org:create` in.
    (process.env as Record<string, string>).NODE_ENV = 'production';
    delete process.env.SIGNUP_MODE;
    organisationCount = 0;

    const { signupAvailability } = await loadSignup();
    const availability = await signupAvailability();

    expect(availability.allowed).toBe(true);
    expect(availability.bootstrap).toBe(true);
    expect(availability.requiresCode).toBe(false);
  });

  it('shuts the door once an organisation exists', async () => {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    delete process.env.SIGNUP_MODE;
    organisationCount = 1;

    const { signupAvailability } = await loadSignup();
    const availability = await signupAvailability();

    expect(availability.allowed).toBe(false);
    expect(availability.bootstrap).toBe(false);
  });

  it('does not treat an open installation as a bootstrap', async () => {
    // `open` means deliberately open, not "empty and therefore open".
    process.env.SIGNUP_MODE = 'open';
    organisationCount = 0;

    const { signupAvailability } = await loadSignup();
    const availability = await signupAvailability();

    expect(availability.allowed).toBe(true);
    expect(availability.bootstrap).toBe(false);
  });

  it('still asks for the code on an empty installation when one is set', async () => {
    // A code configured is a deliberate choice, and an empty database must not
    // quietly waive it.
    process.env.SIGNUP_CODE = 'shared-secret';
    organisationCount = 0;

    const { signupAvailability } = await loadSignup();
    const availability = await signupAvailability();

    expect(availability.requiresCode).toBe(true);
  });
});

describe('the shared code', () => {
  it('accepts only an exact match', async () => {
    process.env.SIGNUP_CODE = 'shared-secret';
    const { signupCodeMatches } = await loadSignup();

    expect(signupCodeMatches('shared-secret')).toBe(true);
    expect(signupCodeMatches('  shared-secret  ')).toBe(true);
    expect(signupCodeMatches('wrong')).toBe(false);
    expect(signupCodeMatches(undefined)).toBe(false);
  });

  it('matches nothing when no code is configured', async () => {
    delete process.env.SIGNUP_CODE;
    const { signupCodeMatches } = await loadSignup();

    /*
     * It used to return true here, on the reasoning that the mode decides
     * access and this only checks the value. But `SIGNUP_MODE=code` with an
     * empty `SIGNUP_CODE` reported mode `code`, so the gate consulted this and
     * was waved through by any input at all. Nothing to check against means
     * nothing matches.
     */
    expect(signupCodeMatches(undefined)).toBe(false);
    expect(signupCodeMatches('')).toBe(false);
    expect(signupCodeMatches('anything')).toBe(false);
  });

  it('treats a whitespace-only code as no code', async () => {
    process.env.SIGNUP_CODE = '   ';
    const { signupCodeMatches } = await loadSignup();

    expect(signupCodeMatches('   ')).toBe(false);
  });
});

describe('a code mode with no code set', () => {
  /*
   * The shape that shipped: an operator uncomments SIGNUP_MODE, sets it to
   * `code`, and never fills in SIGNUP_CODE. Every part of the system reported
   * that signup was gated and none of it was.
   */
  it('is closed rather than open, and says so', async () => {
    process.env.SIGNUP_MODE = 'code';
    delete process.env.SIGNUP_CODE;
    organisationCount = 1;
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { signupMode, signupAvailability } = await loadSignup();

    expect(signupMode()).toBe('closed');
    const availability = await signupAvailability();
    expect(availability.allowed).toBe(false);
    // Not a code box on a door that opens for anyone.
    expect(availability.requiresCode).toBe(false);
    expect(complaint).toHaveBeenCalled();

    complaint.mockRestore();
  });

  it('still lets the operator create the first organisation', async () => {
    // The misconfiguration must not lock somebody out of an empty installation
    // — that is the failure the bootstrap exemption exists to prevent.
    process.env.SIGNUP_MODE = 'code';
    delete process.env.SIGNUP_CODE;
    organisationCount = 0;
    const complaint = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { signupAvailability } = await loadSignup();
    const availability = await signupAvailability();

    expect(availability.allowed).toBe(true);
    expect(availability.bootstrap).toBe(true);

    complaint.mockRestore();
  });
});
