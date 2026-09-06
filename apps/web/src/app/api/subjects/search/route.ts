import { NextResponse } from 'next/server';
import { searchSubjects } from '@sangraha/db';
import { requireSession, withSession } from '@/lib/auth/guard';
import { logAccess } from '@/lib/access-log';
import { subjectDetailResolver } from '@/lib/subject-details';

/**
 * Finds a person by name, for the picker.
 *
 * Unlike the duplicate check, this runs on the ordinary request connection
 * under Row-Level Security. That is the whole difference between the two: this
 * is browsing, and a village worker has no business paging through the next
 * district's beneficiaries just because they typed a common name.
 */
export async function GET(request: Request) {
  const session = await requireSession();
  const url = new URL(request.url);

  const query = url.searchParams.get('q') ?? '';

  const { results, detailsFor } = await withSession(session, async (tx) => {
    const found = await searchSubjects(tx, {
      query: query || undefined,
      subjectTypeId: url.searchParams.get('type') ?? undefined,
      limit: 25,
    });

    /*
     * A name on its own is not enough to pick from. Two people genuinely do
     * share one, and a list of identical rows asks a question nobody can
     * answer — so each result carries the answers that tell them apart.
     */
    return {
      results: found,
      detailsFor: await subjectDetailResolver(
        tx,
        session.orgId,
        found.map((subject) => subject.subjectTypeId),
        session.locale,
      ),
    };
  });

  /*
   * A search is a bulk act: it returns a list of real people the caller may not
   * have known existed. Counted rather than named — logging one row per result
   * would make typing a common surname the largest write in the product.
   *
   * Empty searches are skipped. The picker fires on every keystroke and a
   * no-query request exposed nobody.
   */
  if (query.trim() !== '') {
    await logAccess(session, {
      action: 'search_subjects',
      targetType: 'organisation',
      rowCount: results.length,
      // The term itself is not stored: it is very often a beneficiary's name,
      // and an audit log that accumulates the names people searched for is a
      // second copy of the registry in the table meant to protect it.
      scope: null,
    });
  }

  return NextResponse.json({
    results: results.map((subject) => ({
      id: subject.id,
      displayName: subject.displayName,
      externalId: subject.externalId,
      locationName: subject.locationName,
      subjectTypeName: subject.subjectTypeName,
      registeredAt: subject.registeredAt.toISOString(),
      registeredByName: subject.registeredByName,
      details: detailsFor(subject.subjectTypeId, subject.attributes),
    })),
  });
}
