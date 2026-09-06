'use client';

import { useRouter } from 'next/navigation';
import { SubjectPicker } from '@/components/field/subject-picker';
import { m } from '@/lib/messages';

/**
 * "Who is this for?" — shown before an encounter form when the subject is not
 * already known.
 *
 * Both entry points have to work. A worker who opens the form from the home
 * screen is thinking form-first and lands here; one who opens it from somebody's
 * profile is thinking person-first and never sees this screen, because the
 * subject arrived in the URL.
 */
export function ChooseSubject({
  slug,
  subjectTypeId,
  locale,
}: {
  slug: string;
  subjectTypeId: string;
  locale: string;
}) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-5 px-5 py-6">
      <h1 className="text-field-question font-semibold text-slate-900">
        {m(locale, 'whoIsThisFor')}
      </h1>

      <SubjectPicker
        locale={locale}
        subjectTypeId={subjectTypeId}
        autoFocus
        onPick={(subject) => router.push(`/forms/${slug}?subject=${subject.id}`)}
      />
    </div>
  );
}
