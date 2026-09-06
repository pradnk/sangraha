/**
 * Releases Postgres connections stranded by killed processes.
 *
 *   npm run db:free
 *
 * A dev server or test run that is killed rather than stopped leaves its pool
 * open, and Postgres has no way to know the client is gone. Do that a few times
 * and `npm test` starts failing with "sorry, too many clients already" — which
 * looks exactly like a code regression and is not one.
 *
 * Only touches connections that have been idle for a while, so a running dev
 * server or a test suite mid-flight is left alone.
 */
import postgres from 'postgres';
import { loadRootEnv } from '../load-env.mjs';

const IDLE_SECONDS = 30;

async function main() {
  loadRootEnv();

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');

  const sql = postgres(url, { max: 1 });

  try {
    // `count(*)` always returns a row, but the types cannot know that and a
    // destructure of an empty result would throw here rather than report.
    const [counted] = await sql<{ total: number }[]>`
      SELECT count(*)::int AS total FROM pg_stat_activity WHERE usename IS NOT NULL
    `;
    const total = counted?.total ?? 0;

    const freed = await sql<{ pid: number }[]>`
      SELECT pg_terminate_backend(pid) AS pid
      FROM pg_stat_activity
      WHERE usename IN ('mis', 'mis_app')
        AND pid <> pg_backend_pid()
        AND state = 'idle'
        AND state_change < now() - make_interval(secs => ${IDLE_SECONDS})
    `;

    console.log(
      freed.length === 0
        ? `Nothing to free — ${total} connection(s) open, none idle.`
        : `Freed ${freed.length} idle connection(s), from ${total} open.`,
    );
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
