'use client';

import { useEffect, useState } from 'react';
import { User, X } from 'lucide-react';
import { m } from '@/lib/messages';
import { SubjectPicker, type PickerSubject } from './subject-picker';
import type { QuestionInputProps } from './question-input';

/**
 * A question whose answer is a person.
 *
 * "Which mother does this child belong to?", "who referred them?". The stored
 * value is the subject's id, so the answer stays correct when the person is
 * renamed — but an id is unreadable, so the chosen name is held alongside it
 * for display and re-fetched if the worker returns to a saved draft.
 *
 * Uses the same picker as every other search in the app, on purpose.
 */
export function SubjectRefAnswer({ config, value, locale, onChange }: QuestionInputProps) {
  const subjectId = typeof value === 'string' ? value : null;
  const [chosen, setChosen] = useState<PickerSubject | null>(null);

  // A restored draft carries the id but not the name. Rather than showing a
  // raw UUID to a field worker, look it up.
  useEffect(() => {
    if (!subjectId || chosen?.id === subjectId) return;

    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/subjects/${subjectId}`);
        if (!response.ok) return;
        const body = (await response.json()) as PickerSubject;
        if (!cancelled) setChosen(body);
      } catch {
        // Offline. The id is still stored and the answer is still valid; the
        // worker just sees the placeholder below instead of a name.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subjectId, chosen?.id]);

  if (subjectId) {
    return (
      <div className="flex min-h-tap items-center gap-4 rounded-field border-2 border-brand-500 bg-brand-50 p-4">
        <User aria-hidden className="h-7 w-7 shrink-0 text-brand-700" />
        <span className="min-w-0 flex-1 text-field-base font-semibold text-slate-900">
          {chosen?.displayName ?? m(locale, 'searching')}
        </span>
        <button
          type="button"
          onClick={() => {
            setChosen(null);
            onChange(null);
          }}
          aria-label={m(locale, 'changePerson')}
          className="flex min-h-tap min-w-tap items-center justify-center rounded-field text-slate-600"
        >
          <X aria-hidden className="h-6 w-6" />
        </button>
      </div>
    );
  }

  return (
    <SubjectPicker
      locale={locale}
      subjectTypeId={typeof config.subjectTypeId === 'string' ? config.subjectTypeId : null}
      onPick={(subject) => {
        setChosen(subject);
        onChange(subject.id);
      }}
    />
  );
}
