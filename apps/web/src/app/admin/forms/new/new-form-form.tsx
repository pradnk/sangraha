'use client';

import { useActionState, useState } from 'react';
import Link from 'next/link';
import { AlertCircle } from 'lucide-react';
import type { I18nText } from '@sangraha/form-engine';
import { localise } from '@sangraha/form-engine';
import { createFormAction, type NewFormState } from './actions';

export interface SubjectTypeChoice {
  id: string;
  name: I18nText;
  code: string;
}

/**
 * Two questions and nothing else.
 *
 * The slug, the version, the subject type and every other structural decision
 * are either derived or deferred to the builder. A new-form screen that asks
 * for eight things up front is a screen a programme manager backs out of.
 */
const FORM_TYPES = [
  {
    value: 'standalone',
    label: 'A one-off record',
    hint: 'A village survey, a grievance, a meeting. Not tied to a particular person.',
  },
  {
    value: 'registration',
    label: 'Registers a person',
    hint: 'Enrols someone once — a student, a household, a self-help group.',
  },
  {
    value: 'encounter',
    label: 'Records a visit',
    hint: 'Happens repeatedly for someone already registered — attendance, a check-up.',
  },
] as const;

export function NewFormForm({
  subjectTypes,
  locale,
}: {
  subjectTypes: SubjectTypeChoice[];
  locale: string;
}) {
  const [state, formAction, pending] = useActionState<NewFormState, FormData>(
    createFormAction,
    {},
  );
  const [formType, setFormType] = useState<string>(FORM_TYPES[0]!.value);

  // Standalone forms are about nobody in particular. The other two are the
  // registry, and a form that does not say who it is about cannot join one
  // visit to the next.
  const needsSubjectType = formType !== 'standalone';

  return (
    <form action={formAction} className="flex flex-col gap-5 rounded-lg border border-slate-200 bg-white p-5">
      {state.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-deny-700">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {state.error}
        </p>
      ) : null}

      <label className="flex flex-col gap-1.5">
        <span className="font-medium">What is this form called?</span>
        <input
          name="name"
          required
          maxLength={120}
          autoFocus
          placeholder="School attendance"
          className="rounded border border-slate-300 px-3 py-2"
        />
        <span className="text-xs text-slate-500">
          You can change this later, and translate it, without affecting your reports.
        </span>
      </label>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 font-medium">What kind of form is it?</legend>
        {FORM_TYPES.map((type, index) => (
          <label
            key={type.value}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50 has-[:checked]:border-brand-500 has-[:checked]:bg-brand-50"
          >
            <input
              type="radio"
              name="formType"
              value={type.value}
              defaultChecked={index === 0}
              onChange={(event) => setFormType(event.target.value)}
              className="mt-1"
            />
            <span>
              <span className="block font-medium">{type.label}</span>
              <span className="block text-xs text-slate-500">{type.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {needsSubjectType ? (
        <label className="flex flex-col gap-1.5">
          <span className="font-medium">Who is it about?</span>
          {subjectTypes.length === 0 ? (
            // The dead end this whole screen used to walk into silently.
            <span className="rounded-lg bg-amber-50 p-3 text-amber-900">
              You have not set up anyone to register yet.{' '}
              <Link href="/admin/subject-types" className="font-medium underline">
                Add a type first
              </Link>{' '}
              — a Student, a Household — then come back.
            </span>
          ) : (
            <>
              <select
                name="subjectTypeId"
                required
                defaultValue={subjectTypes[0]?.id}
                className="rounded border border-slate-300 px-3 py-2"
              >
                {subjectTypes.map((type) => (
                  <option key={type.id} value={type.id}>
                    {localise(type.name, locale, type.code)}
                  </option>
                ))}
              </select>
              <span className="text-xs text-slate-500">
                {formType === 'registration'
                  ? 'Filling this form in creates one of these.'
                  : 'Each of these is recorded against someone already registered.'}
              </span>
            </>
          )}
        </label>
      ) : null}

      {/* Said here rather than asked here. This screen deliberately asks only a
          couple of questions, and who may use a form is easier to decide once
          you can see it — but "everyone, until you say otherwise" is not a
          default anybody should discover afterwards. */}
      <p className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
        <strong className="font-medium">Everyone in your organisation will be able to use this
        form.</strong>{' '}
        On the next screen, under <em>Who can use this form?</em>, you can narrow it to supervisors
        plus the field workers you choose, or to organisation admins plus the people you choose —
        useful for something sensitive, because supervisors do not see those records at all.
      </p>

      <button
        type="submit"
        disabled={pending || (needsSubjectType && subjectTypes.length === 0)}
        className="self-start rounded-lg bg-brand-600 px-4 py-2 font-medium text-white hover:bg-brand-700 disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create and add questions'}
      </button>
    </form>
  );
}
