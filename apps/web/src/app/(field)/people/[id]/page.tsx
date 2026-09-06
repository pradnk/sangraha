import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft, CalendarPlus, Link2, User } from 'lucide-react';
import {
  getSubject,
  getSubjectTimeline,
  listEncounterForms,
  loadFormVersionById,
} from '@sangraha/db';
import { formatAnswers, summariseSubmission } from '@sangraha/form-engine';
import { requireSession, withSession } from '@/lib/auth/guard';
import { logAccess } from '@/lib/access-log';
import { AnswerList } from '@/components/field/answer-list';
import { StatusBadge } from '@/components/field/status-badge';
import { t } from '@/lib/i18n';
import { m } from '@/lib/messages';
import { subjectDetailResolver } from '@/lib/subject-details';
import { subjectNameLookup } from '@/lib/subject-names';
import { DuplicateLink } from './duplicate-link';

/**
 * One person's record.
 *
 * The payoff of the registry, and the screen that justifies having built it:
 * their details, then everything that has happened to them in date order. A
 * form collector can show you a hundred attendance records; only a registry can
 * show you *this child's* year.
 */
export default async function PersonPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireSession();
  const { id } = await params;

  const loaded = await withSession(session, async (tx) => {
    // Out of scope resolves to null rather than a 403: the RLS policy filters
    // the row out, so as far as this worker is concerned it does not exist.
    const subject = await getSubject(tx, id);
    if (!subject) return null;

    const timeline = await getSubjectTimeline(tx, id);
    const encounterForms = await listEncounterForms(tx, session.orgId, subject.subjectTypeId);

    /*
     * Every entry is rendered against the version it was captured under, not
     * the current one, so a question renamed last month cannot change what a
     * record from last year appears to say. Versions repeat across entries, so
     * they are loaded once each.
     */
    const versionIds = [...new Set(timeline.map((entry) => entry.formVersionId))];
    const versions = new Map(
      (await Promise.all(versionIds.map((vid) => loadFormVersionById(tx, vid))))
        .filter((v) => v !== null)
        .map((v) => [v.id, v]),
    );

    /*
     * This person's own identifying answers, so the "are these the same
     * person?" confirmation can show both records side by side. Comparing one
     * described record against one bare name is not a comparison.
     */
    const detailsFor = await subjectDetailResolver(
      tx,
      session.orgId,
      [subject.subjectTypeId],
      session.locale,
    );

    /*
     * Names for every "link to a person" answer across the whole timeline,
     * fetched once. Without it a visit reads "Guardian: b8b9cf9f-…" on the one
     * screen whose entire purpose is following a person's record.
     */
    const nameOf = await subjectNameLookup(
      tx,
      session.orgId,
      timeline.map((entry) => ({ version: versions.get(entry.formVersionId), data: entry.data })),
    );

    return {
      subject,
      timeline,
      encounterForms,
      versions,
      nameOf,
      ownDetails: detailsFor(subject.subjectTypeId, subject.attributes),
    };
  });

  if (!loaded) notFound();

  /*
   * The heaviest single act in the product: this screen is everything ever
   * recorded about one person. Logged after the RLS load, so a worker probing
   * ids they cannot see leaves no entry naming somebody they never saw.
   */
  await logAccess(session, {
    action: 'view_subject',
    targetType: 'subject',
    targetId: id,
    rowCount: 1,
  });

  const { subject, timeline, encounterForms, versions, nameOf, ownDetails } = loaded;
  const locale = session.locale;

  // The registration itself supplies the "their details" block; the visits are
  // the history. Splitting them keeps the timeline about what happened.
  const registration = timeline.find((entry) => entry.formType === 'registration');
  const registrationVersion = registration ? versions.get(registration.formVersionId) : undefined;
  const visits = timeline.filter((entry) => entry.formType !== 'registration');

  const canLink = session.role === 'supervisor' || session.role === 'org_admin';

  return (
    <div className="flex flex-col gap-6 px-5 py-6">
      <Link
        href="/find"
        className="inline-flex min-h-tap items-center gap-2 self-start text-field-base font-medium text-brand-700"
      >
        <ArrowLeft aria-hidden className="h-5 w-5" />
        {m(locale, 'findPerson')}
      </Link>

      <header className="flex items-start gap-4">
        <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-brand-100">
          <User aria-hidden className="h-8 w-8 text-brand-700" />
        </span>
        <div className="min-w-0">
          <h1 className="text-field-question font-bold text-slate-900">{subject.displayName}</h1>
          <p className="text-field-sm text-slate-600">
            {[
              t(subject.subjectTypeName, locale, ''),
              subject.locationName ? t(subject.locationName, locale, '') : '',
              subject.externalId,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
      </header>

      {subject.duplicateOfId ? (
        /*
         * This record has been folded into another. Said plainly, with a way
         * through to the record actually in use — a worker who arrives here
         * from an old link should not sit adding visits to a dead record.
         */
        <div className="flex items-start gap-3 rounded-field border-2 border-amber-300 bg-amber-50 p-4">
          <Link2 aria-hidden className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" />
          <p className="text-field-sm text-amber-900">
            {m(locale, 'sameAsAnother', { name: subject.duplicateOfName ?? '' })}{' '}
            <Link href={`/people/${subject.duplicateOfId}`} className="font-semibold underline">
              {subject.duplicateOfName}
            </Link>
          </p>
        </div>
      ) : null}

      {subject.duplicates.length > 0 ? (
        <div className="rounded-field bg-slate-100 p-4">
          <p className="text-field-sm text-slate-700">{m(locale, 'alsoFiledUnder')}:</p>
          <ul className="mt-1 flex flex-col gap-1">
            {subject.duplicates.map((other) => (
              <li key={other.id}>
                <Link
                  href={`/people/${other.id}`}
                  className="text-field-sm font-medium text-brand-700 underline"
                >
                  {other.displayName}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {registration && registrationVersion ? (
        <section>
          <h2 className="text-field-lg font-semibold text-slate-900">{m(locale, 'thisRecord')}</h2>
          <AnswerList
            answers={formatAnswers(registrationVersion, registration.data, locale, nameOf)}
            locale={locale}
          />
          {registration.submittedByName ? (
            <p className="text-field-sm text-slate-500">
              {m(locale, 'registeredBy')} {registration.submittedByName}
            </p>
          ) : null}
        </section>
      ) : null}

      {/* Adding a visit is the reason most workers open this screen, so it sits
          above the history rather than below it. Hidden when this record has
          been folded into another: visits belong on the live one. */}
      {encounterForms.length > 0 && !subject.duplicateOfId ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-field-lg font-semibold text-slate-900">{m(locale, 'addVisit')}</h2>
          {encounterForms.map((form) => (
            <Link
              key={form.id}
              href={`/forms/${form.slug}?subject=${subject.id}`}
              className="flex min-h-tap items-center gap-4 rounded-field bg-brand-600 px-5 py-4 text-field-base font-semibold text-white"
            >
              <CalendarPlus aria-hidden className="h-6 w-6 shrink-0" />
              <span className="flex-1">{t(form.name, locale, form.slug)}</span>
            </Link>
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-field-lg font-semibold text-slate-900">{m(locale, 'theirHistory')}</h2>

        {visits.length === 0 ? (
          <p className="rounded-field bg-slate-100 p-5 text-field-base text-slate-700">
            {m(locale, 'nothingRecordedYet')}
          </p>
        ) : (
          <ol className="flex flex-col gap-3">
            {visits.map((entry) => {
              const version = versions.get(entry.formVersionId);
              return (
                <li key={entry.submissionId}>
                  <Link
                    href={`/my-submissions/${entry.submissionId}`}
                    className="flex flex-col gap-1.5 rounded-field border-2 border-slate-300 bg-white p-4"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="text-field-base font-semibold text-slate-900">
                        {t(entry.formName, locale, entry.formSlug)}
                      </span>
                      <StatusBadge status={entry.status} locale={locale} />
                    </span>
                    <span className="text-field-sm text-slate-500">
                      {new Intl.DateTimeFormat(`${locale}-IN`, { dateStyle: 'medium' }).format(
                        entry.submittedAt,
                      )}
                      {entry.submittedByName ? ` · ${entry.submittedByName}` : ''}
                    </span>
                    {version ? (
                      // A couple of answers, so the entries are distinguishable
                      // without opening each one.
                      <span className="text-field-sm text-slate-700">
                        {summariseSubmission(version, entry.data, locale, 2, nameOf)}
                      </span>
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ol>
        )}
      </section>

      {/* Linking two records together is a supervisor's judgement call, not a
          field worker's — so it lives at the bottom, out of the way of the
          work, and only for those two roles. */}
      {canLink ? (
        <DuplicateLink
          subjectId={subject.id}
          subjectName={subject.displayName}
          subjectDetails={ownDetails}
          subjectTypeId={subject.subjectTypeId}
          locale={locale}
          linkedTo={subject.duplicateOfId ? subject.duplicateOfName : null}
        />
      ) : null}
    </div>
  );
}
