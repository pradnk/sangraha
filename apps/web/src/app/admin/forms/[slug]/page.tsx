import { notFound } from 'next/navigation';
import { eq } from 'drizzle-orm';
import {
  countAnswersForKey,
  countUnregisteredSubmissions,
  getEditableVersion,
  getFormAudience,
  getFormBySlug,
  listPurposes,
  listSubjectTypes,
  listUsers,
  loadFormVersionById,
  options,
  optionSets,
  organisations,
} from '@sangraha/db';
import { requireRole, withSession } from '@/lib/auth/guard';
import { isTranslationAvailable } from '@/lib/translation';
import { FormBuilder } from './form-builder';

export default async function FormBuilderPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const session = await requireRole(['org_admin', 'super_admin']);
  const { slug } = await params;

  const loaded = await withSession(session, async (tx) => {
    const form = await getFormBySlug(tx, session.orgId, slug);
    if (!form) return null;

    const editable = await getEditableVersion(tx, form.id);
    const version = editable ? await loadFormVersionById(tx, editable.id) : null;

    // How many answers each question already holds. Drives the guardrails: the
    // builder can warn *before* an edit rather than rejecting it afterwards.
    const answerCounts: Record<string, number> = {};
    for (const field of version?.fields ?? []) {
      answerCounts[field.key] = await countAnswersForKey(tx, form.id, field.key);
    }

    const sets = await tx
      .select({ id: optionSets.id, code: optionSets.code, name: optionSets.name })
      .from(optionSets)
      .where(eq(optionSets.orgId, session.orgId));

    const allOptions = await tx
      .select({ optionSetId: options.optionSetId, code: options.code, label: options.label })
      .from(options);

    /*
     * Three states, not two.
     *
     * Collapsing this to an `isDraft` boolean made a form with no versions at
     * all fall through to the "published" branch, so a brand-new form
     * announced itself as "Published · version 1" while the forms list
     * correctly said "Not published".
     */
    const publishState: 'never' | 'draft' | 'published' = !editable
      ? 'never'
      : editable.status === 'draft'
        ? 'draft'
        : 'published';

    const [org] = await tx
      .select({ locales: organisations.enabledLocales })
      .from(organisations)
      .where(eq(organisations.id, session.orgId))
      .limit(1);

    /*
     * Only relevant for a form that is about somebody. A standalone form has
     * no subject type by definition, and offering the control there would
     * suggest it was missing something.
     */
    const needsSubject = form.formType !== 'standalone';

    return {
      form,
      version,
      subjectTypes: needsSubject
        ? (await listSubjectTypes(tx, session.orgId))
            .filter((type) => type.isActive)
            .map((type) => ({ id: type.id, name: type.name, code: type.code }))
        : [],
      /*
       * Records already captured that registered nobody. Offered as a backfill
       * rather than left as a silent hole in the registry.
       *
       * Counted whenever the form is a registration, not only while the
       * subject type is missing — the moment it is set is exactly when the
       * count starts mattering, and gating on `!subjectTypeId` meant the
       * button appeared only in the state where it could not be used.
       */
      unregisteredCount:
        form.formType === 'registration'
          ? await countUnregisteredSubmissions(tx, session.orgId, form.id)
          : 0,
      extraLocales: (org?.locales ?? ['en']).filter((l) => l !== 'en'),
      audience: await getFormAudience(tx, form.id),
      /*
       * Only the people an audience can actually be narrowed to. Admins are
       * left out because they always have access — offering them would imply a
       * choice that does not exist. Inactive accounts are left out because
       * naming somebody who cannot sign in reads as access that is not there.
       */
      candidates: (await listUsers(tx, session.orgId))
        .filter(
          (person) =>
            person.isActive &&
            (person.role === 'field_worker' || person.role === 'supervisor'),
        )
        .map((person) => ({
          id: person.id,
          fullName: person.fullName,
          username: person.username,
          role: person.role as 'field_worker' | 'supervisor',
        })),
      publishState,
      versionNumber: editable?.versionNumber ?? null,
      answerCounts,
      optionSets: sets.map((set) => ({
        ...set,
        options: allOptions.filter((o) => o.optionSetId === set.id),
      })),
      // So each question can be attributed to why it is collected, which is
      // what lets the privacy notice be generated rather than written.
      purposes: (await listPurposes(tx, session.orgId))
        .filter((purpose) => purpose.isActive)
        .map((purpose) => ({ id: purpose.id, code: purpose.code, name: purpose.name })),
    };
  });

  if (!loaded) notFound();

  return (
    <FormBuilder
      slug={slug}
      formName={loaded.form.name}
      formType={loaded.form.formType}
      subjectTypeId={loaded.form.subjectTypeId}
      subjectTypes={loaded.subjectTypes}
      unregisteredCount={loaded.unregisteredCount}
      audience={loaded.audience.audience}
      audienceUserIds={loaded.audience.userIds}
      audienceCandidates={loaded.candidates}
      version={loaded.version}
      publishState={loaded.publishState}
      versionNumber={loaded.versionNumber}
      answerCounts={loaded.answerCounts}
      optionSets={loaded.optionSets}
      purposes={loaded.purposes}
      locale={session.locale}
      canTranslate={isTranslationAvailable()}
      extraLocales={loaded.extraLocales}
    />
  );
}
