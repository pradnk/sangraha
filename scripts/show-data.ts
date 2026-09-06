/**
 * Prints collected data from the analytics views.
 *
 *   npx tsx scripts/show-data.ts                    # list the views
 *   npx tsx scripts/show-data.ts school_attendance  # show rows
 *
 * A stand-in until the supervisor review screen exists. The views it reads are
 * the same ones Metabase or Superset would point at, so what you see here is
 * exactly what an analyst would see.
 */
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadRootEnv } from '../load-env.mjs';
import { analyticsSchemaName, pgIdentifier } from '../packages/form-engine/src/index';
import { createPostgresClient, organisations, type Database } from '../packages/db/src/index';

loadRootEnv();

const viewName = process.argv[2];
const orgSlug = process.argv[3] ?? 'shiksha-demo';
const LIMIT = 20;

async function main(): Promise<void> {
  const client = createPostgresClient(process.env.DATABASE_URL!, 1);
  const db = drizzle(client) as unknown as Database;

  try {
    const [org] = await db
      .select({ slug: organisations.slug, name: organisations.name })
      .from(organisations)
      .where(eq(organisations.slug, orgSlug))
      .limit(1);
    if (!org) throw new Error(`No organisation "${orgSlug}". Run: npm run db:seed`);

    const schema = analyticsSchemaName(org.slug);

    const views = (await db.execute(sql`
      SELECT table_name FROM information_schema.views
      WHERE table_schema = ${schema} ORDER BY table_name
    `)) as unknown as { table_name: string }[];

    if (!viewName) {
      console.log(`\n${org.name} — ${schema}\n`);
      if (views.length === 0) {
        console.log('  No analytics views. Publish a form first.\n');
        return;
      }
      for (const view of views) {
        const [count] = (await db.execute(
          sql.raw(`SELECT count(*)::int AS n FROM ${pgIdentifier(schema)}.${pgIdentifier(view.table_name)}`),
        )) as unknown as { n: number }[];
        console.log(`  ${view.table_name.padEnd(34)} ${count?.n ?? 0} rows`);
      }
      console.log(`\n  npx tsx scripts/show-data.ts <view>   to see rows\n`);
      return;
    }

    if (!views.some((v) => v.table_name === viewName)) {
      throw new Error(
        `No view "${viewName}" in ${schema}. Available: ${views.map((v) => v.table_name).join(', ')}`,
      );
    }

    const rows = (await db.execute(
      sql.raw(
        `SELECT * FROM ${pgIdentifier(schema)}.${pgIdentifier(viewName)} ORDER BY submitted_at DESC LIMIT ${LIMIT}`,
      ),
    )) as unknown as Record<string, unknown>[];

    console.log(`\n${schema}.${viewName} — ${rows.length} most recent\n`);
    if (rows.length === 0) {
      console.log('  Nothing captured yet.\n');
      return;
    }

    // The bookkeeping columns are the same on every view and crowd out the
    // answers, which are what anyone running this actually wants to see.
    const noise = new Set(['org_id', 'form_version', 'created_at', 'updated_at', 'location_id']);
    const columns = Object.keys(rows[0]!).filter((c) => !noise.has(c));

    for (const [index, row] of rows.entries()) {
      console.log(`  ── ${index + 1} ──`);
      for (const column of columns) {
        const value = row[column];
        if (value === null || value === undefined || value === '') continue;
        console.log(`     ${column.padEnd(26)} ${formatValue(value)}`);
      }
    }
    console.log();
  } finally {
    await client.end();
  }
}

function formatValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
