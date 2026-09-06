'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AlertCircle, Eye, EyeOff, Plus, Trash2, Users } from 'lucide-react';
import type { SubjectTypeDetail } from '@sangraha/db';
import type { I18nText } from '@sangraha/form-engine';
import { localise, pruneBlank } from '@sangraha/form-engine';
import { LANGUAGE_NAMES, UI_LOCALES } from '@/lib/i18n';
import {
  createSubjectTypeAction,
  deleteSubjectTypeAction,
  updateSubjectTypeAction,
  type SubjectTypeState,
} from './actions';

export interface RegistrationField {
  key: string;
  label: I18nText;
  dataType: string;
}

export function SubjectTypesManager({
  types,
  fieldsByType,
  locale,
}: {
  types: SubjectTypeDetail[];
  fieldsByType: Record<string, RegistrationField[]>;
  locale: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<SubjectTypeState>({});
  const [openId, setOpenId] = useState<string | null>(types[0]?.id ?? null);
  const [newName, setNewName] = useState('');

  const run = (action: () => Promise<SubjectTypeState>) =>
    startTransition(async () => {
      const result = await action();
      setMessage(result);
      if (result.selectId) setOpenId(result.selectId);
      router.refresh();
    });

  const open = types.find((type) => type.id === openId) ?? null;
  const fields = open ? (fieldsByType[open.id] ?? []) : [];

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-xl font-bold">What you register</h1>
        <p className="mt-1 text-slate-600">
          Students, households, self-help groups — whoever your work follows over time.
          Registering someone once and attaching visits to them is what lets you ask how they
          progressed, rather than only how many forms were filled in.
        </p>
      </div>

      {message.error ? (
        <p role="alert" className="flex items-start gap-2 rounded-lg bg-deny-50 p-3 text-deny-700">
          <AlertCircle aria-hidden className="mt-0.5 h-4 w-4 shrink-0" />
          {message.error}
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
        <section className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-white p-4">
          <h2 className="text-sm font-semibold">Types</h2>

          {types.length === 0 ? (
            <p className="rounded-lg bg-slate-50 p-4 text-center text-slate-500">
              None yet.
            </p>
          ) : (
            <ul className="flex flex-col gap-1">
              {types.map((type) => (
                <li key={type.id}>
                  <button
                    type="button"
                    onClick={() => setOpenId(type.id)}
                    className={`flex w-full items-start gap-2 rounded-lg border p-2.5 text-left ${
                      type.id === openId
                        ? 'border-brand-500 bg-brand-50'
                        : 'border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <Users aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-brand-600" />
                    <span className="min-w-0">
                      <span className="block truncate font-medium">
                        {localise(type.name, locale, type.code)}
                        {type.isActive ? '' : ' · off'}
                      </span>
                      <span className="block text-xs text-slate-500">
                        {type.subjectCount} registered
                        {type.registrationForm ? '' : ' · no registration form'}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (!newName.trim()) return;
              run(() => createSubjectTypeAction(newName.trim()));
              setNewName('');
            }}
            className="flex gap-2 border-t border-slate-200 pt-3"
          >
            <input
              value={newName}
              onChange={(event) => setNewName(event.target.value)}
              placeholder="Student, Household…"
              maxLength={120}
              className="min-w-0 flex-1 rounded border border-slate-300 px-2 py-1.5"
            />
            <button
              type="submit"
              disabled={pending}
              aria-label="Add a type"
              className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-white disabled:opacity-50"
            >
              <Plus aria-hidden className="h-4 w-4" />
            </button>
          </form>
        </section>

        <section className="flex flex-col gap-5 rounded-lg border border-slate-200 bg-white p-4">
          {!open ? (
            <p className="rounded-lg bg-slate-50 p-6 text-center text-slate-500">
              Add a type to get started.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2">
                <h2 className="text-sm font-semibold">Name</h2>
                {UI_LOCALES.map((loc) => (
                  <label key={loc} className="flex items-center gap-2">
                    <span className="w-16 shrink-0 text-xs text-slate-500">
                      {LANGUAGE_NAMES[loc]}
                    </span>
                    <input
                      defaultValue={open.name[loc] ?? ''}
                      onBlur={(event) =>
                        run(() =>
                          updateSubjectTypeAction({
                            id: open.id,
                            name: pruneBlank({ ...open.name, [loc]: event.target.value }),
                          }),
                        )
                      }
                      className="w-full max-w-xs rounded border border-slate-300 px-2 py-1.5"
                    />
                  </label>
                ))}
                <p className="font-mono text-xs text-slate-400">{open.code}</p>
              </div>

              <div className="border-t border-slate-200 pt-4">
                <h2 className="text-sm font-semibold">Registration form</h2>
                {open.registrationForm ? (
                  <p className="mt-1 text-slate-600">
                    <Link
                      href={`/admin/forms/${open.registrationForm.slug}`}
                      className="text-brand-700 hover:underline"
                    >
                      {localise(open.registrationForm.name, locale, open.registrationForm.slug)}
                    </Link>
                  </p>
                ) : (
                  // Without one there is nothing to register, and no answers to
                  // name anybody by — so this is the next thing to do.
                  <p className="mt-1 text-slate-600">
                    None yet.{' '}
                    <Link href="/admin/forms/new" className="text-brand-700 hover:underline">
                      Create one
                    </Link>{' '}
                    and point it at this type.
                  </p>
                )}
                {open.encounterForms.length > 0 ? (
                  <p className="mt-2 text-xs text-slate-500">
                    Visits recorded with:{' '}
                    {open.encounterForms
                      .map((form) => localise(form.name, locale, form.slug))
                      .join(', ')}
                  </p>
                ) : null}
              </div>

              <FieldChooser
                title="What to call them"
                hint="The answers a field worker sees in a search result. Usually just the name."
                empty="Publish the registration form first, then its questions appear here."
                fields={fields}
                selected={open.displayNameFields}
                locale={locale}
                disabled={pending}
                onChange={(displayNameFields) =>
                  run(() => updateSubjectTypeAction({ id: open.id, displayNameFields }))
                }
              />

              <FieldChooser
                title="How to spot a duplicate"
                hint="Answers that must match exactly for two records to be the same person — a phone number, a ration card. Names alone produce too many false alarms in a village where half the children share a surname."
                empty="Publish the registration form first, then its questions appear here."
                fields={fields}
                selected={open.matchFields}
                locale={locale}
                disabled={pending}
                onChange={(matchFields) =>
                  run(() => updateSubjectTypeAction({ id: open.id, matchFields }))
                }
              />

              <div className="flex flex-col gap-3 rounded-lg border border-slate-200 bg-slate-50/60 p-4">
                <div>
                  <h3 className="text-sm font-semibold">Age and contact</h3>
                  <p className="mt-1 text-xs text-slate-600">
                    {/* Said as the consequence rather than the statute. An
                        administrator does not need to know it is Section 9;
                        they need to know a child needs a guardian. */}
                    The law treats anyone under 18 differently — a parent or guardian has to agree
                    on their behalf. Tell us which question holds their age so we can ask your team
                    for a guardian at the right moment. If nothing is chosen here, we have to ask
                    about every single person.
                  </p>
                </div>

                <OneFieldChooser
                  label="Date of birth"
                  hint="Preferred. An age recorded three years ago is three years out of date; a birth date never is."
                  fields={fields}
                  value={open.dateOfBirthField}
                  locale={locale}
                  disabled={pending}
                  onChange={(dateOfBirthField) =>
                    run(() => updateSubjectTypeAction({ id: open.id, dateOfBirthField }))
                  }
                />

                <OneFieldChooser
                  label="Age in years"
                  hint="Used when no birth date was recorded, which is common."
                  fields={fields}
                  value={open.ageYearsField}
                  locale={locale}
                  disabled={pending}
                  onChange={(ageYearsField) =>
                    run(() => updateSubjectTypeAction({ id: open.id, ageYearsField }))
                  }
                />

                <OneFieldChooser
                  label="Phone number"
                  hint="If information about your beneficiaries is ever exposed, the law requires you to tell each person affected. This is how."
                  fields={fields}
                  value={open.contactField}
                  locale={locale}
                  disabled={pending}
                  onChange={(contactField) =>
                    run(() => updateSubjectTypeAction({ id: open.id, contactField }))
                  }
                />
              </div>

              <div className="flex flex-wrap gap-2 border-t border-slate-200 pt-4">
                <button
                  type="button"
                  disabled={pending}
                  onClick={() =>
                    run(() =>
                      updateSubjectTypeAction({ id: open.id, isActive: !open.isActive }),
                    )
                  }
                  className="inline-flex items-center gap-2 rounded-lg border border-slate-300 px-3 py-1.5 hover:bg-slate-50"
                >
                  {open.isActive ? (
                    <>
                      <EyeOff aria-hidden className="h-4 w-4" />
                      Stop using this
                    </>
                  ) : (
                    <>
                      <Eye aria-hidden className="h-4 w-4" />
                      Use it again
                    </>
                  )}
                </button>

                {/* Offered only when nothing depends on it; the server refuses
                    otherwise and says what is in the way. */}
                {open.subjectCount === 0 && !open.registrationForm ? (
                  <button
                    type="button"
                    disabled={pending}
                    onClick={() => {
                      setOpenId(null);
                      run(() => deleteSubjectTypeAction(open.id));
                    }}
                    className="inline-flex items-center gap-2 rounded-lg border border-deny-300 px-3 py-1.5 text-deny-700 hover:bg-deny-50"
                  >
                    <Trash2 aria-hidden className="h-4 w-4" />
                    Delete
                  </button>
                ) : (
                  <p className="self-center text-xs text-slate-500">
                    {open.subjectCount > 0
                      ? `${open.subjectCount} registered, so this cannot be deleted.`
                      : 'A form uses this, so it cannot be deleted.'}
                  </p>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

/** Multi-select over the registration form's questions, in form order. */
function FieldChooser({
  title,
  hint,
  empty,
  fields,
  selected,
  locale,
  disabled,
  onChange,
}: {
  title: string;
  hint: string;
  empty: string;
  fields: RegistrationField[];
  selected: string[];
  locale: string;
  disabled: boolean;
  onChange: (keys: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-slate-200 pt-4">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="text-xs text-slate-500">{hint}</p>

      {fields.length === 0 ? (
        <p className="rounded bg-slate-50 p-3 text-slate-500">{empty}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {fields.map((field) => {
            const isSelected = selected.includes(field.key);
            return (
              <button
                key={field.key}
                type="button"
                disabled={disabled}
                onClick={() =>
                  onChange(
                    isSelected
                      ? selected.filter((key) => key !== field.key)
                      : [...selected, field.key],
                  )
                }
                className={`rounded-full border px-3 py-1 text-xs ${
                  isSelected
                    ? 'border-brand-500 bg-brand-600 text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                }`}
              >
                {localise(field.label, locale, field.key)}
              </button>
            );
          })}
        </div>
      )}

      {selected.length > 0 ? (
        // Order matters for the name: "Sunita Devi", not "Devi Sunita".
        <p className="text-xs text-slate-500">In order: {selected.join(' + ')}</p>
      ) : null}
    </div>
  );
}


/**
 * Picks exactly one question, or none.
 *
 * Separate from `FieldChooser`, which picks a set. Date of birth is not a list:
 * two nominated birth-date questions would make "how old is this person" have
 * two answers, and the one the system happened to read first would decide
 * whether a child got a guardian.
 */
function OneFieldChooser({
  label,
  hint,
  fields,
  value,
  locale,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  fields: { key: string; label: Record<string, string> }[];
  value: string | null;
  locale: string;
  disabled: boolean;
  onChange: (value: string | null) => void;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-xs text-slate-500">{hint}</span>
      {fields.length === 0 ? (
        <span className="text-xs text-slate-500">
          Publish the registration form first, then its questions appear here.
        </span>
      ) : (
        <select
          value={value ?? ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value || null)}
          className="mt-0.5 w-full max-w-sm rounded border border-slate-300 px-2 py-1.5 text-sm"
        >
          <option value="">Not recorded</option>
          {fields.map((field) => (
            <option key={field.key} value={field.key}>
              {field.label[locale] || field.label.en || field.key}
            </option>
          ))}
        </select>
      )}
    </label>
  );
}
