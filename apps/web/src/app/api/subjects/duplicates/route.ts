import { NextResponse } from 'next/server';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { composeDisplayName, findDuplicateCandidates, getOwnerDb, subjectTypes } from '@sangraha/db';
import { requireSession } from '@/lib/auth/guard';
import { logAccess } from '@/lib/access-log';
import { prioritise, subjectDetailResolver } from '@/lib/subject-details';

/**
 * "Is this the same person?"
 *
 * Called after the last question and before saving, which is the only moment
 * the answer is still cheap to act on. A duplicate found afterwards is a
 * cleanup job; a duplicate found here is one tap.
 *
 * The check itself deliberately looks past the caller's own locations — see
 * `findDuplicateCandidates`. What comes back for those out-of-scope matches is
 * a count and nothing else.
 */

const bodySchema = z.object({
  subjectTypeId: z.string().uuid(),
  data: z.record(z.unknown()),
  externalId: z.string().nullish(),
  /** Set when re-checking a record that already exists. */
  excludeId: z.string().uuid().nullish(),
});

export async function POST(request: Request) {
  const session = await requireSession();

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_body', issues: parsed.error.issues }, { status: 400 });
  }

  const body = parsed.data;

  /*
   * The owner connection, which bypasses RLS — the whole point, since the
   * duplicate worth warning about is often the one RLS hides. Everything below
   * is therefore scoped explicitly to the caller's own organisation, taken
   * from the session and never from the request body.
   */
  const db = getOwnerDb();

  const [type] = await db
    .select({
      id: subjectTypes.id,
      orgId: subjectTypes.orgId,
      name: subjectTypes.name,
      displayNameFields: subjectTypes.displayNameFields,
      matchFields: subjectTypes.matchFields,
    })
    .from(subjectTypes)
    .where(eq(subjectTypes.id, body.subjectTypeId))
    .limit(1);

  // A subject type from another organisation is not a 403 with an explanation;
  // it is simply not a thing that exists as far as this caller is concerned.
  if (!type || type.orgId !== session.orgId) {
    return NextResponse.json({ error: 'unknown_subject_type' }, { status: 404 });
  }

  const displayName = composeDisplayName(type.displayNameFields, body.data, '');

  const result = await findDuplicateCandidates(db, {
    orgId: session.orgId,
    subjectTypeId: type.id,
    displayName,
    answers: body.data,
    externalId: body.externalId ?? null,
    matchFields: type.matchFields,
    viewer: { userId: session.userId, role: session.role },
    excludeId: body.excludeId ?? undefined,
  });

  /*
   * Turn the raw answers into a few labelled lines.
   *
   * Without them the screen showed two cards reading "Test1 · Registered 6 Aug
   * 2026" and asked which one it was — a question with no answer. What tells
   * two same-named people apart is their age, their phone number, their
   * guardian, so those are what the card has to show.
   */
  const detailsFor = await subjectDetailResolver(db, session.orgId, [type.id], session.locale);

  /*
   * Logged because this is the one call that deliberately reaches past the
   * caller's own locations, on the owner connection, with RLS off. That is the
   * right trade — a duplicate hidden by scoping is exactly the duplicate worth
   * warning about — but unmetered it is also an oracle for "does this phone
   * number exist anywhere in this organisation", and the only thing that makes
   * the trade auditable is a record of who asked and how often.
   *
   * `hiddenCount` is added in: those are people the caller was told about
   * without being shown, and they were still touched.
   */
  await logAccess(session, {
    action: 'check_duplicates',
    targetType: 'organisation',
    rowCount: result.visible.length + result.hiddenCount,
  });

  return NextResponse.json({
    hiddenCount: result.hiddenCount,
    visible: result.visible.map((match) => ({
      id: match.id,
      displayName: match.displayName,
      externalId: match.externalId,
      locationName: match.locationName,
      registeredAt: match.registeredAt,
      registeredByName: match.registeredByName,
      reasons: match.reasons,
      // The answers this organisation nominated as identifying come first:
      // here the whole question is "are these the same person?", and a matching
      // phone number is the strongest evidence there is.
      details: prioritise(detailsFor(type.id, match.attributes), type.matchFields),
    })),
  });
}
