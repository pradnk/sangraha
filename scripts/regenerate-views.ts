/**
 * Rebuilds every organisation's analytics views.
 *
 *   npm run db:views
 *
 * Views are normally regenerated when a form is published, which covers the
 * ordinary case. This exists for the other one: a deploy that changes the
 * *generator* — adding a column, adding a whole new view — leaves every
 * existing view stale until somebody happens to republish, which for a form
 * that is finished and working may be never.
 *
 * Safe to run at any time. Views hold no data, `CREATE OR REPLACE` is close to
 * instantaneous, and nothing here touches a table.
 */
import { loadRootEnv } from '../load-env.mjs';

async function main() {
  loadRootEnv();

  const { getOwnerDb, regenerateAllViews } = await import('@sangraha/db');
  const results = await regenerateAllViews(getOwnerDb());

  if (results.length === 0) {
    console.log('No forms yet, so no views to build.');
    process.exit(0);
  }

  for (const result of results) {
    const created = result.created.join(', ') || 'none';
    console.log(`  ${result.schema}.${result.formSlug} → ${created}`);
    if (result.dropped.length > 0) {
      console.log(`    dropped: ${result.dropped.join(', ')}`);
    }
  }

  console.log(`\n✓ Rebuilt views for ${results.length} form(s).`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
