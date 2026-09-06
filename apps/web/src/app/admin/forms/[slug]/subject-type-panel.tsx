'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, UserPlus } from 'lucide-react';
import type { I18nText } from '@sangraha/form-engine';
import { localise } from '@sangraha/form-engine';
import { backfillSubjectsAction, setSubjectTypeAction } from './actions';

/**
 * Who this form is about.
 *
 * Exists because a registration form with no subject type registers nobody,
 * quietly: the form said "Registers a person", a worker filled it in, and the
 * submission saved with nothing added to the registry. There was no warning and
 * no way to fix it — `/admin/forms/new` asks for the subject type, but forms
 * built before the registry existed never did, and nothing let you say so
 * afterwards.
 */
export function SubjectTypePanel({
  slug,
  formType,
  subjectTypeId,
  subjectTypes,
  unregisteredCount,
  locale,
}: {
  slug: string;
  formType: 'registration' | 'encounter' | 'standalone';
  subjectTypeId: string | null;
  subjectTypes: { id: string; name: I18nText; code: string }[];
  /** Records already captured that registered nobody. */
  unregisteredCount: number;
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [registered, setRegistered] = useState<number | null>(null);

  if (formType === 'standalone') return null;

  const run = (action: () => Promise<{ error?: string; registered?: number }>) =>
    startTransition(async () => {
      const result = await action();
      setError(result.error ?? null);
      if (result.registered !== undefined) setRegistered(result.registered);
      if (!result.error) router.refresh();
    });

  const missing = !subjectTypeId;

  return (
    <section
      className={`flex flex-col gap-3 rounded-lg border p-4 ${
        missing ? 'border-amber-300 bg-amber-50' : 'border-slate-200 bg-white'
      }`}
    >
      <div className="flex items-start gap-2">
        {missing ? (
          <AlertTriangle aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
        ) : (
          <UserPlus aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-brand-600" />
        )}
        <div>
          <h2 className="font-semibold">Who is it about?</h2>
          <p className="text-sm text-slate-700">
            {missing ? (
              <>
                {formType === 'registration'
                  ? 'This form says it registers a person, but you have not said who — so nobody is being added to the registry and nothing shows up under Find a person.'
                  : 'This form records a visit, but you have not said who it is about, so the visits are not attached to anybody.'}
              </>
            ) : formType === 'registration' ? (
              'Filling this form in creates one of these.'
            ) : (
              'Each visit is recorded against someone already registered.'
            )}
          </p>
        </div>
      </div>

      {error ? (
        <p role="alert" className="rounded bg-deny-50 p-3 text-sm text-deny-700">
          {error}
        </p>
      ) : null}

      {registered !== null ? (
        <p role="status" className="flex items-center gap-2 rounded bg-affirm-50 p-3 text-sm text-affirm-700">
          <CheckCircle2 aria-hidden className="h-4 w-4 shrink-0" />
          {registered === 0
            ? 'There was nothing left to catch up.'
            : `Registered ${registered} ${registered === 1 ? 'person' : 'people'} from records already collected.`}
        </p>
      ) : null}

      {subjectTypes.length === 0 ? (
        <p className="text-sm text-slate-700">
          You have not set up anyone to register yet.{' '}
          <Link href="/admin/subject-types" className="font-medium text-brand-700 underline">
            Add a type first
          </Link>{' '}
          — a Student, a Respondent, a Household.
        </p>
      ) : (
        <label className="flex flex-wrap items-center gap-2">
          <select
            defaultValue={subjectTypeId ?? ''}
            disabled={pending}
            onChange={(event) =>
              run(() => setSubjectTypeAction(slug, event.target.value || null))
            }
            className="rounded border border-slate-300 px-3 py-2"
          >
            <option value="">Not chosen</option>
            {subjectTypes.map((type) => (
              <option key={type.id} value={type.id}>
                {localise(type.name, locale, type.code)}
              </option>
            ))}
          </select>
        </label>
      )}

      {/*
       * The records already collected. A field worker met these people and
       * wrote them down; asking anyone to key them in again would be the wrong
       * answer, so they are caught up in place.
       */}
      {missing && unregisteredCount > 0 && subjectTypes.length > 0 ? (
        <p className="text-sm text-slate-700">
          <strong>{unregisteredCount}</strong> record
          {unregisteredCount === 1 ? '' : 's'} already collected with this form registered nobody.
          Choose a type above, then catch them up.
        </p>
      ) : null}

      {!missing && unregisteredCount > 0 ? (
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => backfillSubjectsAction(slug))}
          className="self-start rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white hover:bg-brand-700 disabled:opacity-50"
        >
          Register the {unregisteredCount} record{unregisteredCount === 1 ? '' : 's'} already
          collected
        </button>
      ) : null}
    </section>
  );
}
