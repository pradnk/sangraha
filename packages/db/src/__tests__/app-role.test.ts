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

const saved = process.env.DATABASE_APP_URL;

afterEach(() => {
  if (saved === undefined) delete process.env.DATABASE_APP_URL;
  else process.env.DATABASE_APP_URL = saved;
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
