/**
 * Carries out erasures that have been accepted.
 *
 *   npx tsx scripts/purge.ts --org shiksha-demo            # rehearse
 *   npx tsx scripts/purge.ts --org shiksha-demo --confirm  # do it
 *
 * A command rather than a scheduled job, deliberately. There is no job runner
 * in this system, and the first thing to add one for should not be the one
 * operation that irreversibly destroys data — a cron nobody is watching, on a
 * self-hosted server nobody configured, is a bad place for that. An admin can
 * also run it from the Privacy screen; both call the same function.
 *
 * Rehearses by default. `--confirm` is required to touch anything.
 */
import { loadRootEnv } from '../load-env.mjs';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  loadRootEnv();

  // Imported inside `main`, after the environment is loaded, and matching every
  // other script here: a top-level await does not survive tsx's transform.
  const { getOwnerDb, purgeErasures, listErasureRequests, organisations, deleteObject } =
    await import('@sangraha/db');
  const { eq } = await import('drizzle-orm');

  const slug = arg('org');
  const confirm = process.argv.includes('--confirm');
  const keep = (arg('keep') ?? '').split(',').filter(Boolean);

  if (!slug) {
    console.error('Usage: tsx scripts/purge.ts --org <slug> [--keep field,field] [--confirm]');
    process.exit(1);
  }

  const db = getOwnerDb();
  const [org] = await db
    .select({ id: organisations.id, name: organisations.name })
    .from(organisations)
    .where(eq(organisations.slug, slug))
    .limit(1);

  if (!org) {
    console.error(`No organisation with slug "${slug}".`);
    process.exit(1);
  }

  const waiting = (await listErasureRequests(db, org.id)).filter(
    (request) => request.status === 'accepted',
  );

  console.log(`\n${org.name}`);
  console.log(`  ${waiting.length} erasure${waiting.length === 1 ? '' : 's'} accepted and waiting`);
  for (const request of waiting) {
    console.log(
      `    · ${request.subjectNameAtRequest ?? '(name already cleared)'} — ${request.mode}`,
    );
  }

  if (waiting.length === 0) {
    console.log('\nNothing to do.\n');
    return;
  }

  /** The one outcome that is neither a count nor a failure: a statute said no. */
  const reportHolds = (held: Awaited<ReturnType<typeof purgeErasures>>['heldBack']): void => {
    if (held.length === 0) return;
    console.log(`\n  ${held.length} request(s) held back by a retention law:`);
    for (const entry of held) {
      const statutes = [
        ...new Set(entry.holds.map((h) => (h.section ? `${h.statute} ${h.section}` : h.statute))),
      ].join(', ');
      const until = entry.holds
        .reduce((latest, h) => (h.expiresAt > latest ? h.expiresAt : latest), new Date(0))
        .toISOString()
        .slice(0, 10);
      console.log(`    · ${entry.subjectPseudonym} — ${statutes}, until ${until}`);
    }
    console.log(
      '\n  They stay hidden meanwhile and nothing needs re-filing: run this again\n' +
        '  after the last of those dates and it completes on its own.',
    );
  };

  if (!confirm) {
    const rehearsal = await purgeErasures(db, org.id, { dryRun: true });
    console.log(`\n  Would affect ${rehearsal.subjects} record(s) across the duplicate clusters.`);
    reportHolds(rehearsal.heldBack);
    console.log('  Nothing was changed. Re-run with --confirm to carry it out.\n');
    return;
  }

  // Their photograph and their signature go too. Without this the CLI would
  // quietly do less than the Privacy screen does, which is the worst kind of
  // difference between two ways of running the same operation.
  const result = await purgeErasures(db, org.id, { keepAttributes: keep, deleteObject });

  console.log('\n  Done.');
  console.log(`    people        ${result.subjects}`);
  console.log(`    records       ${result.submissions}`);
  console.log(`    revisions     ${result.revisions}`);
  console.log(`    consents kept, names removed  ${result.consentRedacted}`);
  console.log(`    counters written before deleting  ${result.countersWritten}`);
  console.log(`    photos and signatures destroyed   ${result.attachmentsDeleted}`);
  reportHolds(result.heldBack);
  if (result.attachmentsFailed > 0) {
    // Loud, and not folded into the tidy list above. These files still exist.
    console.error(
      `\n  WARNING: ${result.attachmentsFailed} file(s) could not be deleted from object\n` +
        '  storage. They are still there. Check S3_* in .env and re-run — the rows\n' +
        '  are kept so a re-run will find them again.',
    );
  }
  /*
   * Said every time, because it is the part an operator cannot do anything
   * about and must not forget they promised.
   */
  console.log(
    '\n  Not reached: spreadsheets already downloaded, and database backups\n' +
      '  until they rotate out of their retention window. Both are disclosed in\n' +
      '  the privacy notice.\n',
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
