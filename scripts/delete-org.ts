/**
 * Deletes an organisation and everything belonging to it.
 *
 *   npm run org:delete -- --slug pratham-education --confirm
 *
 * Irreversible, so `--confirm` is required. Removes submissions, subjects,
 * forms, users, places and the organisation's analytics schema, in the order the
 * foreign keys demand.
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { loadRootEnv } from '../load-env.mjs';
import {
  createPostgresClient,
  deleteObject,
  deleteOrganisationBySlug,
  organisations,
  type Database,
} from '../packages/db/src/index';

loadRootEnv();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : (argv[i + 1] ?? '');
  };

  const slug = flag('slug')?.trim();
  const confirmed = argv.includes('--confirm');

  if (!slug) {
    console.error('\n  npm run org:delete -- --slug <slug> --confirm\n');
    process.exit(1);
  }

  const client = createPostgresClient(process.env.DATABASE_URL!, 1);
  const db = drizzle(client) as unknown as Database;

  try {
    const [org] = await db
      .select({ name: organisations.name })
      .from(organisations)
      .where(eq(organisations.slug, slug))
      .limit(1);

    if (!org) {
      console.error(`No organisation with the slug "${slug}".`);
      process.exit(1);
    }

    if (!confirmed) {
      console.error(
        `\nThis would permanently delete "${org.name}" and all of its data.\nRe-run with --confirm if that is what you want.\n`,
      );
      process.exit(1);
    }

    // Their photographs and signatures are as much "them" as their rows.
    // Passed in rather than reached for, so the db package stays free of any
    // dependency on how the app talks to S3 — see `ObjectDeleter`.
    const result = await deleteOrganisationBySlug(db, slug, { deleteObject });
    console.log(`\n✓ Deleted "${org.name}" (${slug})`);
    console.log(`    photos and signatures destroyed   ${result.attachmentsDeleted}`);

    if (result.attachmentsFailed > 0) {
      // Loud, and not folded into the line above. These files are still there,
      // and their rows — the only record of where they were — are now gone.
      console.error(
        `\n  WARNING: ${result.attachmentsFailed} file(s) could not be deleted from\n` +
          '  object storage. The rows that named them are gone, so nothing will\n' +
          '  find them again. Check S3_* in .env before running this next time.',
      );
    }
    console.log('');
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
