/**
 * End-to-end acceptance check against a running dev server.
 *
 *   npm run infra:up && npm run db:migrate && npm run db:seed
 *   npm run dev
 *   npx tsx scripts/verify-e2e.ts [baseUrl]
 *
 * Exercises the real HTTP path — session cookie, API route, server-side
 * validation, RLS, idempotency — and then reads the result back out of the
 * analytics view. Complements the unit and integration suites, which test the
 * pieces rather than the wiring between them.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import { SignJWT } from 'jose';
import { loadRootEnv } from '../load-env.mjs';
import { analyticsSchemaName, pgIdentifier } from '../packages/form-engine/src/index';
import {
  createPostgresClient,
  forms,
  loadCurrentFormVersion,
  organisations,
  purposes,
  submissions,
  userLocations,
  users,
  type Database,
} from '../packages/db/src/index';

loadRootEnv();

const BASE_URL = process.argv[2] ?? 'http://localhost:3100';
const ORG_SLUG = 'shiksha-demo';

let failures = 0;

function check(label: string, passed: boolean, detail?: unknown): void {
  if (passed) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}`);
    if (detail !== undefined) console.log(`      ${JSON.stringify(detail)}`);
  }
}

async function main(): Promise<void> {
  const client = createPostgresClient(process.env.DATABASE_URL!, 2);
  const db = drizzle(client) as unknown as Database;

  try {
    const [org] = await db
      .select({ id: organisations.id, slug: organisations.slug })
      .from(organisations)
      .where(eq(organisations.slug, ORG_SLUG))
      .limit(1);
    if (!org) throw new Error(`Seed data missing — run: npm run db:seed`);

    const [worker] = await db
      .select()
      .from(users)
      .where(and(eq(users.orgId, org.id), eq(users.username, 'sunita')))
      .limit(1);
    if (!worker) throw new Error('Demo user "sunita" not found');

    const [form] = await db
      .select({ id: forms.id })
      .from(forms)
      .where(and(eq(forms.orgId, org.id), eq(forms.slug, 'school_attendance')))
      .limit(1);
    if (!form) throw new Error('Form "school_attendance" not found');

    const version = await loadCurrentFormVersion(db, form.id);
    if (!version) throw new Error('school_attendance has no published version');

    const [assignment] = await db
      .select({ locationId: userLocations.locationId })
      .from(userLocations)
      .where(eq(userLocations.userId, worker.id))
      .limit(1);

    const cookie = `mis_session=${await mintSession(org, worker)}`;
    const post = (body: unknown) =>
      fetch(`${BASE_URL}/api/submissions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      });

    console.log(`\nVerifying ${BASE_URL} as ${worker.username} (${worker.role})\n`);

    // --- 1. A valid submission is accepted ---------------------------------
    console.log('Submitting an absence record');
    const clientUuid = randomUUID();
    const payload = {
      clientUuid,
      formVersionId: version.id,
      locationId: assignment?.locationId ?? null,
      data: {
        attendance_date: '2026-08-05',
        present: false,
        absence_reason: 'illness',
        notes: 'Fever since Monday',
      },
    };

    const first = await post(payload);
    const firstBody = (await first.json()) as { id?: string; duplicate?: boolean };
    check('accepted with 201', first.status === 201, { status: first.status, body: firstBody });
    check('not flagged as a duplicate', firstBody.duplicate === false);

    // --- 2. A replay is idempotent -----------------------------------------
    console.log('\nReplaying the same submission (simulating a retry over a flaky link)');
    const replay = await post(payload);
    const replayBody = (await replay.json()) as { id?: string; duplicate?: boolean };
    check('accepted with 200', replay.status === 200);
    check('recognised as a duplicate', replayBody.duplicate === true);
    check('resolves to the same row', replayBody.id === firstBody.id, {
      first: firstBody.id,
      replay: replayBody.id,
    });

    const rowCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(submissions)
      .where(eq(submissions.clientUuid, clientUuid));
    check('exactly one row was written', rowCount[0]?.count === 1, rowCount[0]);

    // --- 3. Server-side validation ------------------------------------------
    console.log('\nSubmitting with a required answer missing');
    const invalid = await post({
      clientUuid: randomUUID(),
      formVersionId: version.id,
      data: { present: false, absence_reason: 'illness' },
    });
    check('rejected with 422', invalid.status === 422, { status: invalid.status });

    // --- 4. Skip logic strips orphaned answers ------------------------------
    console.log('\nSubmitting "present" while an absence reason is still filled in');
    const strippedUuid = randomUUID();
    const stripped = await post({
      clientUuid: strippedUuid,
      formVersionId: version.id,
      locationId: assignment?.locationId ?? null,
      data: { attendance_date: '2026-08-06', present: true, absence_reason: 'illness' },
    });
    check('accepted with 201', stripped.status === 201, { status: stripped.status });

    const [strippedRow] = await db
      .select({ data: submissions.data })
      .from(submissions)
      .where(eq(submissions.clientUuid, strippedUuid))
      .limit(1);
    check(
      'the hidden answer was not stored',
      strippedRow !== undefined && !('absence_reason' in (strippedRow.data as object)),
      strippedRow?.data,
    );

    // --- 5. It arrives in the analytics view --------------------------------
    console.log('\nReading back from the analytics view');
    const schema = analyticsSchemaName(org.slug);
    const rows = (await db.execute(
      sql.raw(`
        SELECT attendance_date, present, absence_reason, absence_reason_label, notes
        FROM ${pgIdentifier(schema)}."school_attendance"
        WHERE submission_id = '${firstBody.id}'
      `),
    )) as unknown as Record<string, unknown>[];

    const row = rows[0];
    check('the submission is visible in the view', row !== undefined);
    check('date is a real date', row?.attendance_date === '2026-08-05', row?.attendance_date);
    check('boolean is a real boolean', row?.present === false, row?.present);
    check('choice keeps its stable code', row?.absence_reason === 'illness');
    check('choice gains a readable label', row?.absence_reason_label === 'Illness');
    check('free text came through', row?.notes === 'Fever since Monday');

    // --- 6. A refusal after a write leaves nothing behind --------------------
    /*
     * The one failure the endpoint discovers *after* it has already written.
     *
     * A returned `NextResponse` resolves the `withSession` callback, and Drizzle
     * commits a resolved transaction — so returning the 409 from inside it left
     * the submission row committed with no `created` revision and its
     * attachments unclaimed, while the client was told the send had failed. The
     * retry then met the idempotency short-circuit and reported success, so the
     * orphan was never noticed. Only a throw rolls it back.
     */
    console.log('\nSending a consent that clashes with one already recorded');

    /*
     * Registered here rather than taken from the seed, so the check does not
     * quietly skip itself on an installation that has no beneficiaries yet —
     * which is exactly the state a fresh `db:seed` leaves behind, and a check
     * that skips is a check that never caught anything.
     */
    const registration = await db
      .select({ id: forms.id })
      .from(forms)
      .where(and(eq(forms.orgId, org.id), eq(forms.slug, 'student_registration')))
      .limit(1);
    const registrationVersion = registration[0]
      ? await loadCurrentFormVersion(db, registration[0].id)
      : null;

    let subject: { id: string } | undefined;
    if (registrationVersion) {
      const registered = await post({
        clientUuid: randomUUID(),
        formVersionId: registrationVersion.id,
        locationId: assignment?.locationId ?? null,
        data: { full_name: 'Consent Clash', gender: 'f', grade: 'g4' },
      });
      const body = (await registered.json()) as { subjectId?: string };
      check('a registration creates the person it is about', Boolean(body.subjectId), body);
      if (body.subjectId) subject = { id: body.subjectId };
    }

    const [existingPurpose] = await db
      .select({ id: purposes.id })
      .from(purposes)
      .where(eq(purposes.orgId, org.id))
      .limit(1);
    // A purpose is organisation configuration rather than something the field
    // app creates, so this one is seeded directly if the demo has none.
    const purpose =
      existingPurpose ??
      (
        await db
          .insert(purposes)
          .values({
            orgId: org.id,
            code: 'e2e_consent_check',
            name: { en: 'End-to-end check' },
            lawfulBasis: 'consent',
          })
          .onConflictDoNothing()
          .returning({ id: purposes.id })
      )[0] ??
      (
        await db
          .select({ id: purposes.id })
          .from(purposes)
          .where(and(eq(purposes.orgId, org.id), eq(purposes.code, 'e2e_consent_check')))
          .limit(1)
      )[0];

    if (!purpose || !subject) {
      check('a purpose and a person are available for the consent check', false, {
        purpose: purpose?.id ?? null,
        subject: subject?.id ?? null,
      });
    } else {
      const sharedEventUuid = randomUUID();
      /*
       * `voluntary` rather than `consent`, so the check does not also need a
       * published notice to cite — `consent_events_notice_required` requires
       * one for a consent basis. What is under test is the transaction
       * boundary, and the conflict is raised on the action and the purpose
       * regardless of basis.
       */
      const consented = (action: 'given' | 'refused') => ({
        clientEventUuid: sharedEventUuid,
        subjectId: subject.id,
        purposeId: purpose.id,
        action,
        lawfulBasis: 'voluntary' as const,
        noticeLocale: 'en',
      });

      const agreed = await post({
        clientUuid: randomUUID(),
        formVersionId: version.id,
        subjectId: subject.id,
        locationId: assignment?.locationId ?? null,
        data: { attendance_date: '2026-08-07', present: true },
        consent: [consented('given')],
      });
      check('the first consent is accepted', agreed.status === 201, { status: agreed.status });

      // Same idempotency key, opposite decision. Nothing can reconcile those.
      const clashUuid = randomUUID();
      const clash = await post({
        clientUuid: clashUuid,
        formVersionId: version.id,
        subjectId: subject.id,
        locationId: assignment?.locationId ?? null,
        data: { attendance_date: '2026-08-08', present: true },
        consent: [consented('refused')],
      });
      check('the clashing consent is refused with 409', clash.status === 409, {
        status: clash.status,
      });

      const orphans = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(submissions)
        .where(eq(submissions.clientUuid, clashUuid));
      check('the refused submission was not committed', orphans[0]?.count === 0, orphans[0]);

      // And the retry the queue would send must not find it either, or the
      // worker is told a record saved that nobody can see.
      const retry = await post({
        clientUuid: clashUuid,
        formVersionId: version.id,
        subjectId: subject.id,
        locationId: assignment?.locationId ?? null,
        data: { attendance_date: '2026-08-08', present: true },
        consent: [consented('refused')],
      });
      check('the retry is refused too, not reported as already sent', retry.status === 409, {
        status: retry.status,
      });
    }

    // --- 7. The ids the client chooses are resolved, not trusted -------------
    /*
     * `subjectId` and `locationId` used to be written onto the row behind
     * nothing but a uuid check. A worker could file a record at a location two
     * districts away — which then failed `can_see_location` and vanished from
     * the review queue of every supervisor who should have seen it — or against
     * another tenant's subject entirely.
     */
    console.log('\nFiling a record against places and people the worker may not use');

    const foreign = await post({
      clientUuid: randomUUID(),
      formVersionId: version.id,
      locationId: randomUUID(),
      data: { attendance_date: '2026-08-09', present: true },
    });
    check('an unknown location is refused with 404', foreign.status === 404, {
      status: foreign.status,
    });

    const strangerSubject = await post({
      clientUuid: randomUUID(),
      formVersionId: version.id,
      subjectId: randomUUID(),
      locationId: assignment?.locationId ?? null,
      data: { attendance_date: '2026-08-09', present: true },
    });
    check('an unknown subject is refused with 404', strangerSubject.status === 404, {
      status: strangerSubject.status,
    });

    // A place in the organisation the worker is not assigned to. Reachable in
    // the picker — `locations_isolation` is org-wide — and not somewhere they
    // may file from.
    const [elsewhere] = (await db.execute(sql`
      SELECT l.id
      FROM locations l
      WHERE l.org_id = ${org.id}
        AND l.id <> ${assignment?.locationId ?? org.id}
        AND NOT EXISTS (
          SELECT 1 FROM user_locations ul
          JOIN locations assigned ON assigned.id = ul.location_id
          WHERE ul.user_id = ${worker.id} AND l.path <@ assigned.path
        )
      LIMIT 1
    `)) as unknown as { id: string }[];

    if (!elsewhere) {
      console.log('  · skipped — the seed has no location outside this worker\'s subtree');
    } else {
      const outOfScope = await post({
        clientUuid: randomUUID(),
        formVersionId: version.id,
        locationId: elsewhere.id,
        data: { attendance_date: '2026-08-09', present: true },
      });
      check('a place outside the worker\'s own area is refused', outOfScope.status === 404, {
        status: outOfScope.status,
      });
    }

    // --- 8. Cross-tenant access is refused ----------------------------------
    console.log('\nAttempting to submit against another organisation');
    const forged = await post({
      clientUuid: randomUUID(),
      // A syntactically valid but foreign form version.
      formVersionId: randomUUID(),
      data: { attendance_date: '2026-08-05', present: true },
    });
    check('unknown form version refused with 404', forged.status === 404, {
      status: forged.status,
    });

    console.log(
      failures === 0
        ? '\n✓ All end-to-end checks passed\n'
        : `\n✗ ${failures} check(s) failed\n`,
    );
  } finally {
    await client.end();
  }

  if (failures > 0) process.exit(1);
}

async function mintSession(
  org: { id: string; slug: string },
  user: typeof users.$inferSelect,
): Promise<string> {
  const secret = new TextEncoder().encode(process.env.AUTH_SECRET!);
  return new SignJWT({
    orgId: org.id,
    userId: user.id,
    role: user.role,
    username: user.username,
    fullName: user.fullName,
    locale: user.locale ?? 'en',
    orgSlug: org.slug,
    mustChangePin: user.mustChangePin,
    tokenVersion: user.tokenVersion,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(secret);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
