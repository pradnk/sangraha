import { notFound } from 'next/navigation';
import { and, eq } from 'drizzle-orm';
import {
  consentRequirementFor,
  forms,
  getSubject,
  loadCurrentFormVersion,
  usableForm,
  userLocations,
} from '@sangraha/db';
import { requireSession, withSession } from '@/lib/auth/guard';
import { FormCapture } from '@/components/field/form-capture';
import { ChooseSubject } from './choose-subject';

/**
 * Capture screen for one form.
 *
 * The version served is whatever is currently published; the submission records
 * which one it was, so the answers stay interpretable even after the form is
 * edited.
 */
export default async function FormPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ subject?: string }>;
}) {
  const session = await requireSession();
  const { slug } = await params;
  const { subject: subjectParam } = await searchParams;

  const loaded = await withSession(session, async (tx) => {
    const [form] = await tx
      .select({ id: forms.id, isActive: forms.isActive })
      .from(forms)
      // Including the audience, so a form kept off somebody's home screen is
      // not simply one URL away. The submission policy refuses the write too;
      // this is so they meet a "not found" rather than a failed send.
      .where(and(eq(forms.orgId, session.orgId), eq(forms.slug, slug), usableForm()))
      .limit(1);

    if (!form || !form.isActive) return null;

    const version = await loadCurrentFormVersion(tx, form.id);
    if (!version) return null;

    // Out of scope resolves to null, exactly as it does in search: the RLS
    // policy filters the row out, so the picker is shown rather than an error
    // about a person this worker is not supposed to know exists.
    const subject = subjectParam ? await getSubject(tx, subjectParam) : null;

    // Defaults the submission's location to the worker's assignment. A worker
    // with one village should never be asked which village they are in.
    const assignments = await tx
      .select({ locationId: userLocations.locationId })
      .from(userLocations)
      .where(eq(userLocations.userId, session.userId));

    return {
      version,
      subject,
      // A visit inherits the place of the person it is about; failing that, it
      // falls back to where the worker works.
      locationId:
        subject?.locationId ??
        (assignments.length === 1 ? (assignments[0]?.locationId ?? null) : null),
      consent: await consentRequirementFor(tx, session.orgId, version.id, {
        locale: session.locale,
        subjectId: subject?.id ?? null,
      }),
    };
  });

  if (!loaded) notFound();

  const { version, subject, locationId } = loaded;

  /*
   * An encounter has to be about somebody. Without a subject there is nothing
   * to attach the visit to, and a submission saved anyway would be an orphan
   * that never appears on anybody's timeline — so the picker comes first.
   */
  if (version.formType === 'encounter' && version.subjectTypeId && !subject) {
    return (
      <ChooseSubject slug={slug} subjectTypeId={version.subjectTypeId} locale={session.locale} />
    );
  }

  return (
    <FormCapture
      version={version}
      locale={session.locale}
      locationId={locationId}
      subjectId={subject?.id ?? null}
      // The confirmation screen has always had a "Saved for {name}" message and
      // never had a name to put in it.
      subjectName={subject?.displayName ?? null}
      // Only a registration form creates a person, so only it can create a
      // duplicate one.
      checkDuplicates={version.formType === 'registration'}
      // Null when the organisation has published no notice, or when every
      // purpose this form serves rests on a legitimate use. Both are real
      // answers — asking for consent that is not needed implies a withdrawal
      // the organisation could not honour.
      consent={loaded.consent}
    />
  );
}
