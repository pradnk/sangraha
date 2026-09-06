'use client';

import { useRouter } from 'next/navigation';
import { SubjectPicker } from '@/components/field/subject-picker';
import { m } from '@/lib/messages';

/** "Find a person" — search, then open their record. */
export function FindPerson({ locale }: { locale: string }) {
  const router = useRouter();

  return (
    <div className="flex flex-col gap-5 px-5 py-6">
      <h1 className="text-field-question font-semibold text-slate-900">
        {m(locale, 'findPerson')}
      </h1>

      <SubjectPicker
        locale={locale}
        autoFocus
        onPick={(subject) => router.push(`/people/${subject.id}`)}
      />
    </div>
  );
}
