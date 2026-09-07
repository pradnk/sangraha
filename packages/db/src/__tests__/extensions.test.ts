/**
 * The schema's extension dependencies are created by `npm run db:migrate`.
 *
 * The defect: `ltree`, `pg_trgm` and `pgcrypto` existed only in
 * `infra/postgres-init/01-extensions.sql`, which Docker runs once on container
 * boot. Local development worked, so nothing looked wrong — but a managed
 * Postgres mounts no init directory, and there the first migration died on
 * `type "ltree" does not exist`. That names a missing type, not the missing
 * step, and the fix was to find a SQL console and paste three lines that were
 * already in the repository.
 *
 * No database needed — the whole of it is a file and an ordering.
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Every extension the schema cannot be created without.
 *
 * `pgcrypto` is here for `gen_random_uuid()`, which has been in core since
 * Postgres 13 — it stays because the stated floor is 14 and an older server
 * would still need it.
 */
const REQUIRED = ['ltree', 'pg_trgm', 'pgcrypto'];

describe('the extensions the schema depends on', () => {
  it('are created by the migrate path, not by a Docker-only hook', async () => {
    const contents = await readFile(join(packageRoot, 'sql', '000-extensions.sql'), 'utf8');

    for (const extension of REQUIRED) {
      expect(contents).toContain(`CREATE EXTENSION IF NOT EXISTS ${extension};`);
    }
  });

  it('are applied before the schema migrations, which declare types from them', async () => {
    /*
     * The ordering *is* the fix. Moved into the ordinary sql/ loop — which runs
     * at the end — this file would apply cleanly and change nothing, because
     * the migration that needed it has already failed.
     */
    const source = await readFile(join(packageRoot, 'src', 'migrate.ts'), 'utf8');

    const extensions = source.indexOf('PRE_MIGRATION_SQL,');
    const migrations = source.indexOf('await migrate(db,');

    expect(extensions).toBeGreaterThan(-1);
    expect(migrations).toBeGreaterThan(-1);
    expect(extensions).toBeLessThan(migrations);
  });

  it('names ltree, which is the one the first migration would fail on', async () => {
    // Kept honest against the schema rather than against a memory of it: if the
    // ltree column ever goes away, this test should be what asks whether the
    // extension still needs to.
    const initial = await readFile(
      join(packageRoot, 'migrations', '0000_initial_schema.sql'),
      'utf8',
    );

    expect(initial).toContain('"ltree"');
    expect(initial).toContain('gin_trgm_ops');
  });
});
