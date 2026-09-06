import { NextResponse } from 'next/server';
import { getSubject } from '@sangraha/db';
import { requireSession, withSession } from '@/lib/auth/guard';

/**
 * One person, by id — so a `subject_ref` answer restored from a draft can show
 * a name instead of a UUID.
 *
 * Row-Level Security applies, and out of scope resolves to 404 rather than 403:
 * confirming that a record exists but is none of your business is itself a
 * disclosure.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const session = await requireSession();
  const { id } = await params;

  const subject = await withSession(session, (tx) => getSubject(tx, id));
  if (!subject) return NextResponse.json({ error: 'not_found' }, { status: 404 });

  // Deliberately not the whole record: this answers "what is their name?", and
  // the registration answers are not needed to render a chip.
  return NextResponse.json({
    id: subject.id,
    displayName: subject.displayName,
    externalId: subject.externalId,
    locationName: subject.locationName,
    subjectTypeName: subject.subjectTypeName,
  });
}
