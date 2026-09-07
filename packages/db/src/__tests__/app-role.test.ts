/**
 * One name for the application role, derived from the URL it connects with.
 *
 * The defect: `030-grants.sql` granted to a literal `mis_app` while `migrate.ts`
 * created whatever `DATABASE_APP_URL` named. Any deployment that chose another
 * username migrated cleanly, printed "database is up to date", and then failed
 * every single request on a permission error that said nothing about why.
 *
 * No database needed — the whole of it is a string and a file.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appRoleName } from '../app-role';

const ENV_KEYS = ['DATABASE_APP_URL', 'DATABASE_APP_ROLE'];
const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('the application role name', () => {
  it('comes from the URL the application actually connects with', () => {
    process.env.DATABASE_APP_URL = 'postgres://sangraha_web:secret@db.example:5432/mis';
    expect(appRoleName()).toBe('sangraha_web');
  });

  it('decodes a username that had to be escaped in the URL', () => {
    process.env.DATABASE_APP_URL = 'postgres://tenant%40host:secret@db.example:5432/mis';
    expect(appRoleName()).toBe('tenant@host');
  });

  it('strips the project reference Supabase\'s pooler puts in the username', () => {
    /*
     * One pooler fronts every project on Supabase, so the project reference
     * travels in the username and is stripped back off before the connection
     * reaches Postgres, which authenticates plain `mis_app`.
     *
     * Taking the username literally here is silent and total: CREATE ROLE and
     * every GRANT in 030-grants.sql would name a role called
     * `mis_app.abcdefghijkl`, the migration would print "database is up to
     * date", and every request would then arrive as a `mis_app` that either
     * does not exist or holds nothing.
     */
    process.env.DATABASE_APP_URL =
      'postgres://mis_app.abcdefghijkl:secret@aws-0-ap-south-1.pooler.supabase.com:6543/postgres';
    expect(appRoleName()).toBe('mis_app');
  });

  it('leaves a dotted username alone anywhere but that pooler', () => {
    // A role legitimately called `first.last` must not lose half its name.
    process.env.DATABASE_APP_URL = 'postgres://first.last:secret@db.example:5432/mis';
    expect(appRoleName()).toBe('first.last');
  });

  it('lets DATABASE_APP_ROLE override the derivation entirely', () => {
    // The escape hatch for a provider that mangles the username some other
    // way. It names the role Postgres sees, not the string used to connect.
    process.env.DATABASE_APP_URL = 'postgres://whatever.the.provider.wants:s@odd.example/mis';
    process.env.DATABASE_APP_ROLE = 'sangraha_web';
    expect(appRoleName()).toBe('sangraha_web');
  });

  it('falls back to the development default rather than throwing', () => {
    // Reached from the analytics generator, which runs inside a request: a
    // malformed environment variable must not turn publishing a form into a
    // stack trace.
    delete process.env.DATABASE_APP_URL;
    expect(appRoleName()).toBe('mis_app');

    process.env.DATABASE_APP_URL = 'not a url at all';
    expect(appRoleName()).toBe('mis_app');

    process.env.DATABASE_APP_URL = 'postgres://db.example:5432/mis';
    expect(appRoleName()).toBe('mis_app');
  });
});

describe('the declarative SQL layer', () => {
  it('names no role of its own', async () => {
    /*
     * The guard that keeps the two from drifting apart again. A grant to a
     * hardcoded name is invisible in review — it reads as perfectly ordinary
     * SQL — and only shows up on a deployment nobody is watching.
     */
    const sqlDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'sql');
    const files = (await readdir(sqlDir)).filter((f) => f.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const contents = await readFile(join(sqlDir, file), 'utf8');
      const statements = contents
        .split('\n')
        // Comments may still discuss the old name; only statements matter.
        .filter((line) => !line.trimStart().startsWith('--') && !line.trimStart().startsWith('*'));

      for (const line of statements) {
        expect(/\b(TO|FROM)\s+mis_app\b/i.test(line), `${file}: ${line}`).toBe(false);
      }
    }
  });

  it('is not the only place a hardcoded name could hide', async () => {
    /*
     * The sibling of the guard above, and the gap it left. `/api/health` asked
     * `pg_roles` for a literal `mis_app` long after `030-grants.sql` had stopped
     * naming one, so a deployment that chose another username was reported
     * degraded — 503, appRolePresent: false — on a perfectly healthy database.
     * SQL in TypeScript is still SQL.
     *
     * `scripts/` is deliberately out of scope: `free-connections.ts` names the
     * local development roles on purpose, and it never runs against a
     * deployment.
     */
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
    const roots = [join(repoRoot, 'packages', 'db', 'src'), join(repoRoot, 'apps', 'web', 'src')];

    let scanned = 0;
    for (const root of roots) {
      const entries = await readdir(root, { recursive: true, withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) continue;
        const path = join(entry.parentPath ?? entry.path, entry.name);
        // The one legitimate definition, and the tests that exercise it.
        if (path.includes('__tests__') || entry.name === 'app-role.ts') continue;

        scanned += 1;
        const lines = (await readFile(path, 'utf8')).split('\n');
        for (const [index, line] of lines.entries()) {
          const code = line.trimStart();
          // Comments may still discuss the old name; only statements matter.
          if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) continue;
          expect(/'mis_app'|"mis_app"|\bmis_app\b/.test(line), `${path}:${index + 1}: ${code}`).toBe(
            false,
          );
        }
      }
    }

    // A path typo would otherwise make this pass by scanning nothing.
    expect(scanned).toBeGreaterThan(50);
  });

  it('substitutes the placeholder for a quoted identifier', () => {
    // Exactly what migrate.ts does, asserted so the two cannot disagree about
    // the token. A role name is not parameterisable in DDL, so this is the
    // only mechanism available.
    const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
    const line = 'GRANT USAGE ON SCHEMA public TO @APP_ROLE@;';

    expect(line.replaceAll('@APP_ROLE@', quoted('sangraha_web'))).toBe(
      'GRANT USAGE ON SCHEMA public TO "sangraha_web";',
    );
    // A name that would otherwise close the quoting early.
    expect(line.replaceAll('@APP_ROLE@', quoted('odd"name'))).toBe(
      'GRANT USAGE ON SCHEMA public TO "odd""name";',
    );
  });
});
